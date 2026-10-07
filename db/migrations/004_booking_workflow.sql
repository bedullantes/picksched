-- =============================================================================
-- PickSched — Migration 004: Booking workflow (slot selection -> reservation)
-- Depends on: 001, 002, 003
-- =============================================================================
--
-- 1. Booking status 'pending' is renamed to 'pending_payment'. Statuses are
--    now: pending_payment, confirmed, cancelled. Existing rows, constraints,
--    indexes and policies follow the rename automatically; function bodies
--    that mention the value are redefined below.
-- 2. bookings.hold_expires_at is renamed to bookings.expires_at: when an
--    unpaid booking releases its slot.
-- 3. The checkout hold is shortened to 3 minutes (booking_hold_interval()).
-- 4. Court owners can't change a booking whose checkout is in progress
--    (pending_payment, hold not expired). They get SQLSTATE 55006
--    (object_in_use). Players can still abandon their own checkout.
--
-- Function definitions are otherwise unchanged from migrations 002/003.
-- =============================================================================

BEGIN;

ALTER TYPE booking_status RENAME VALUE 'pending' TO 'pending_payment';
ALTER TABLE bookings RENAME COLUMN hold_expires_at TO expires_at;

COMMENT ON COLUMN bookings.expires_at IS
    'When an unpaid (pending_payment) booking releases its slot. Set on insert to now() + booking_hold_interval().';

-- The checkout hold: how long a player has to pay before the slot is released.
CREATE OR REPLACE FUNCTION booking_hold_interval() RETURNS INTERVAL
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '3 minutes' $$;

-- True while a player is paying for the booking: owners must not change it.
CREATE FUNCTION booking_in_checkout(b bookings) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT b.status = 'pending_payment' AND b.expires_at > now()
$$;

-- -----------------------------------------------------------------------------
-- Functions redefined only for the renamed status value and column
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_owns_pending_booking(p_booking_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
        SELECT 1 FROM bookings
        WHERE id = p_booking_id AND player_id = app_current_user_id() AND status = 'pending_payment'
    )
$$;

CREATE OR REPLACE FUNCTION expire_stale_bookings() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n INTEGER;
BEGIN
    UPDATE bookings
    SET status = 'cancelled', cancelled_at = now()
    WHERE status = 'pending_payment' AND expires_at <= now();
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END
$$;

CREATE OR REPLACE FUNCTION bookings_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_rate     BIGINT;
    v_currency CHAR(3);
BEGIN
    SELECT hourly_rate, currency INTO v_rate, v_currency
    FROM courts WHERE id = NEW.court_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'court % does not exist', NEW.court_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    NEW.total_amount := round(v_rate * extract(epoch FROM (NEW.end_time - NEW.start_time)) / 3600);
    NEW.currency     := v_currency;

    IF NEW.status = 'pending_payment' THEN
        NEW.expires_at := now() + booking_hold_interval();
    END IF;

    -- Invalid ranges are left for bookings_time_order_chk to reject.
    IF NEW.end_time > NEW.start_time THEN
        UPDATE bookings
        SET status = 'cancelled', cancelled_at = now()
        WHERE court_id = NEW.court_id
          AND status = 'pending_payment'
          AND expires_at <= now()
          AND tstzrange(start_time, end_time, '[)') && tstzrange(NEW.start_time, NEW.end_time, '[)');
    END IF;

    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION bookings_check_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
        RAISE EXCEPTION 'booking % is cancelled and cannot be reopened', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'confirmed' AND NEW.status = 'pending_payment' THEN
        RAISE EXCEPTION 'booking % is confirmed and cannot return to pending', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION bookings_check_maintenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF NEW.status NOT IN ('pending_payment', 'confirmed') OR NEW.end_time <= NEW.start_time THEN
        RETURN NEW;
    END IF;

    PERFORM lock_court_schedule(NEW.court_id);

    IF EXISTS (
        SELECT 1 FROM court_blocks
        WHERE court_id = NEW.court_id
          AND tstzrange(start_time, end_time, '[)') && tstzrange(NEW.start_time, NEW.end_time, '[)')
    ) THEN
        RAISE EXCEPTION 'court is closed for maintenance during the requested time'
            USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'bookings_maintenance_overlap';
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION court_blocks_before_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.created_by := COALESCE(NEW.created_by, app_current_user_id());
    END IF;
    IF NEW.end_time <= NEW.start_time THEN
        RETURN NEW;  -- rejected by court_blocks_time_order_chk
    END IF;

    PERFORM lock_court_schedule(NEW.court_id);

    UPDATE bookings
    SET status = 'cancelled', cancelled_at = now()
    WHERE court_id = NEW.court_id
      AND status = 'pending_payment'
      AND expires_at <= now()
      AND tstzrange(start_time, end_time, '[)') && tstzrange(NEW.start_time, NEW.end_time, '[)');

    IF EXISTS (
        SELECT 1 FROM bookings
        WHERE court_id = NEW.court_id
          AND status IN ('pending_payment', 'confirmed')
          AND tstzrange(start_time, end_time, '[)') && tstzrange(NEW.start_time, NEW.end_time, '[)')
    ) THEN
        RAISE EXCEPTION 'maintenance block overlaps existing bookings; cancel or move them first'
            USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'court_blocks_booking_overlap';
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION get_availability(
    p_start_date  DATE,
    p_days        INTEGER DEFAULT 1,
    p_court_id    UUID    DEFAULT NULL,
    p_owned_only  BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    court_id        UUID,
    local_date      DATE,
    slot_start      TIMESTAMPTZ,
    slot_end        TIMESTAMPTZ,
    status          TEXT,
    booking_id      UUID,
    booking_status  booking_status,
    booking_start   TIMESTAMPTZ,
    booking_end     TIMESTAMPTZ,
    hold_expires_at TIMESTAMPTZ,
    player_email    TEXT,
    block_id        UUID,
    block_reason    TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_user UUID := app_current_user_id();
BEGIN
    IF p_days IS NULL OR p_days NOT BETWEEN 1 AND 31 THEN
        RAISE EXCEPTION 'p_days must be between 1 and 31' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    RETURN QUERY
    WITH visible_courts AS (
        SELECT c.*
        FROM courts c
        WHERE (c.is_active OR c.owner_id = v_user)
          AND (p_court_id IS NULL OR c.id = p_court_id)
          AND (NOT p_owned_only OR c.owner_id = v_user)
    ),
    slots AS (
        SELECT c.id AS court_id,
               c.owner_id,
               d.day AS local_date,
               (d.day + c.opens_at + make_interval(mins => n.i * c.slot_minutes)) AT TIME ZONE c.timezone AS s,
               (d.day + c.opens_at + make_interval(mins => (n.i + 1) * c.slot_minutes)) AT TIME ZONE c.timezone AS e
        FROM visible_courts c
        CROSS JOIN LATERAL (
            SELECT (p_start_date + k) AS day FROM generate_series(0, p_days - 1) k
        ) d
        CROSS JOIN LATERAL generate_series(
            0,
            floor(extract(epoch FROM (c.closes_at - c.opens_at)) / 60 / c.slot_minutes)::int - 1
        ) AS n(i)
    )
    SELECT s.court_id,
           s.local_date,
           s.s,
           s.e,
           CASE
               WHEN blk.id IS NOT NULL                        THEN 'maintenance'
               WHEN bk.id IS NOT NULL AND bk.player_id = v_user THEN 'mine'
               WHEN bk.id IS NOT NULL                         THEN 'booked'
               WHEN s.s < now() + booking_min_lead_time()     THEN 'unavailable'
               ELSE 'available'
           END,
           CASE WHEN bk.player_id = v_user OR s.owner_id = v_user THEN bk.id END,
           CASE WHEN bk.player_id = v_user OR s.owner_id = v_user THEN bk.status END,
           CASE WHEN bk.player_id = v_user OR s.owner_id = v_user THEN bk.start_time END,
           CASE WHEN bk.player_id = v_user OR s.owner_id = v_user THEN bk.end_time END,
           CASE WHEN bk.player_id = v_user OR s.owner_id = v_user THEN bk.expires_at END,
           CASE WHEN s.owner_id = v_user THEN u.email END,
           CASE WHEN s.owner_id = v_user THEN blk.id END,
           CASE WHEN s.owner_id = v_user THEN blk.reason END
    FROM slots s
    LEFT JOIN LATERAL (
        SELECT cb.id, cb.reason
        FROM court_blocks cb
        WHERE cb.court_id = s.court_id
          AND tstzrange(cb.start_time, cb.end_time, '[)') && tstzrange(s.s, s.e, '[)')
        ORDER BY cb.start_time
        LIMIT 1
    ) blk ON TRUE
    LEFT JOIN LATERAL (
        SELECT b.id, b.player_id, b.status, b.start_time, b.end_time, b.expires_at
        FROM bookings b
        WHERE b.court_id = s.court_id
          AND (b.status = 'confirmed' OR (b.status = 'pending_payment' AND b.expires_at > now()))
          AND tstzrange(b.start_time, b.end_time, '[)') && tstzrange(s.s, s.e, '[)')
        ORDER BY (b.player_id = v_user) DESC, b.start_time
        LIMIT 1
    ) bk ON TRUE
    LEFT JOIN users u ON u.id = bk.player_id
    ORDER BY s.court_id, s.s;
END
$$;

-- -----------------------------------------------------------------------------
-- Payment results (status value rename)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_payment_result(p_provider_ref_id TEXT, p_status transaction_status)
RETURNS booking_status
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    t transactions;
    v_booking_status booking_status;
BEGIN
    IF p_status = 'pending' THEN  -- transaction_status, not booking_status
        RAISE EXCEPTION 'a payment result cannot be pending' USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO t FROM transactions WHERE provider_ref_id = p_provider_ref_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'transaction % not found', p_provider_ref_id USING ERRCODE = 'no_data_found';
    END IF;

    IF t.status = 'refunded' AND p_status <> 'refunded' THEN
        RAISE EXCEPTION 'transaction % is refunded', p_provider_ref_id USING ERRCODE = 'check_violation';
    END IF;
    IF t.status = 'paid' AND p_status NOT IN ('paid', 'refunded') THEN
        RAISE EXCEPTION 'transaction % is paid', p_provider_ref_id USING ERRCODE = 'check_violation';
    END IF;

    IF t.status <> p_status THEN
        UPDATE transactions
        SET status = p_status,
            processed_at = CASE WHEN p_status IN ('paid', 'failed', 'refunded') THEN now() END
        WHERE id = t.id;
    END IF;

    IF p_status = 'paid' THEN
        UPDATE bookings SET status = 'confirmed'
        WHERE id = t.booking_id AND status = 'pending_payment';
    ELSIF p_status = 'refunded' THEN
        UPDATE bookings SET status = 'cancelled', cancelled_at = now()
        WHERE id = t.booking_id AND status <> 'cancelled';
    END IF;

    SELECT status INTO v_booking_status FROM bookings WHERE id = t.booking_id;
    RETURN v_booking_status;
END
$$;

-- -----------------------------------------------------------------------------
-- Owner actions: no changes to a booking while its checkout is in progress
-- -----------------------------------------------------------------------------
-- The booking's player may cancel (abandon checkout) at any time. The court
-- owner may cancel only once the checkout is finished or its hold has expired.
CREATE OR REPLACE FUNCTION cancel_booking(p_booking_id UUID) RETURNS bookings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    b bookings;
BEGIN
    SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
    IF NOT FOUND OR NOT app_can_view_booking(p_booking_id) THEN
        RAISE EXCEPTION 'booking % not found', p_booking_id USING ERRCODE = 'no_data_found';
    END IF;
    IF b.status = 'cancelled' THEN
        RETURN b;  -- idempotent
    END IF;
    IF b.player_id IS DISTINCT FROM app_current_user_id() AND booking_in_checkout(b) THEN
        RAISE EXCEPTION 'booking % is in checkout and cannot be changed until payment finishes or the hold expires', p_booking_id
            USING ERRCODE = 'object_in_use';
    END IF;

    UPDATE bookings SET status = 'cancelled', cancelled_at = now()
    WHERE id = p_booking_id
    RETURNING * INTO b;
    RETURN b;
END
$$;

-- Manual confirmation by the court owner applies only to bookings that are
-- not awaiting payment. Payment confirmation comes from record_payment_result.
CREATE OR REPLACE FUNCTION confirm_booking(p_booking_id UUID) RETURNS bookings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    b bookings;
BEGIN
    SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
    IF NOT FOUND OR NOT app_can_view_booking(p_booking_id) THEN
        RAISE EXCEPTION 'booking % not found', p_booking_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT app_owns_court(b.court_id) THEN
        RAISE EXCEPTION 'only the court owner can confirm a booking manually'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF b.status = 'confirmed' THEN
        RETURN b;  -- idempotent
    END IF;
    IF booking_in_checkout(b) THEN
        RAISE EXCEPTION 'booking % is in checkout and cannot be changed until payment finishes or the hold expires', p_booking_id
            USING ERRCODE = 'object_in_use';
    END IF;
    IF b.status = 'pending_payment' THEN
        RAISE EXCEPTION 'booking % was not paid in time and its hold expired', p_booking_id
            USING ERRCODE = 'check_violation';
    END IF;

    UPDATE bookings SET status = 'confirmed'
    WHERE id = p_booking_id
    RETURNING * INTO b;   -- a cancelled booking is rejected by the transition trigger
    RETURN b;
END
$$;

CREATE OR REPLACE FUNCTION reschedule_booking(
    p_booking_id UUID, p_court_id UUID, p_start_time TIMESTAMPTZ, p_end_time TIMESTAMPTZ
) RETURNS bookings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    b bookings;
BEGIN
    SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
    IF NOT FOUND OR NOT app_can_view_booking(p_booking_id) THEN
        RAISE EXCEPTION 'booking % not found', p_booking_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT app_owns_court(b.court_id) OR NOT app_owns_court(p_court_id) THEN
        RAISE EXCEPTION 'only the court owner can reschedule a booking'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF b.status = 'cancelled' THEN
        RAISE EXCEPTION 'booking % is cancelled', p_booking_id USING ERRCODE = 'check_violation';
    END IF;
    IF booking_in_checkout(b) THEN
        RAISE EXCEPTION 'booking % is in checkout and cannot be changed until payment finishes or the hold expires', p_booking_id
            USING ERRCODE = 'object_in_use';
    END IF;
    IF b.status = 'pending_payment' THEN
        RAISE EXCEPTION 'booking % was not paid in time and its hold expired', p_booking_id
            USING ERRCODE = 'check_violation';
    END IF;
    IF p_start_time < now() THEN
        RAISE EXCEPTION 'cannot move a booking into the past' USING ERRCODE = 'check_violation';
    END IF;

    UPDATE bookings
    SET court_id = p_court_id, start_time = p_start_time, end_time = p_end_time
    WHERE id = p_booking_id
    RETURNING * INTO b;
    RETURN b;
END
$$;

COMMIT;
