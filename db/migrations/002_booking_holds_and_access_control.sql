-- =============================================================================
-- PickSched — Migration 002: Booking holds and role-based access control
-- Depends on: 001_initial_schema.sql
-- =============================================================================
--
-- 1. Booking holds: a `pending` booking reserves its slot only until
--    `hold_expires_at`. Expired holds are released automatically when someone
--    else books an overlapping slot, and in bulk by expire_stale_bookings().
--
-- 2. Access control: row-level security (RLS) enforces the Admin/Player
--    permission matrix for the application role `picksched_app`. The API sets
--    the authenticated user per transaction:
--
--        SELECT set_config('app.current_user_id', '<user uuid>', true);
--
--    State changes that need rules RLS cannot express (status transitions,
--    payment results) go through SECURITY DEFINER functions.
--
-- 3. Server-side pricing: bookings.total_amount and transactions.amount are
--    computed by the database, so a client cannot choose its own price.
-- =============================================================================

BEGIN;

COMMENT ON TYPE user_role IS
    'RBAC role. admin = Court Owner (manages own courts, bookings and reports); player = Player.';

-- -----------------------------------------------------------------------------
-- Application role
-- -----------------------------------------------------------------------------
-- The API's login role should be granted membership:  GRANT picksched_app TO <login>;
-- It must not be the table owner or a superuser, since those bypass RLS.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'picksched_app') THEN
        CREATE ROLE picksched_app NOLOGIN;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Session identity helpers
-- -----------------------------------------------------------------------------
CREATE FUNCTION app_current_user_id() RETURNS UUID
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;

-- SECURITY DEFINER helpers read across tables without triggering RLS on
-- them, which avoids policy recursion between bookings, courts and users.
CREATE FUNCTION app_owns_court(p_court_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
        SELECT 1 FROM courts WHERE id = p_court_id AND owner_id = app_current_user_id()
    )
$$;

CREATE FUNCTION app_can_view_booking(p_booking_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
        SELECT 1
        FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE b.id = p_booking_id
          AND app_current_user_id() IN (b.player_id, c.owner_id)
    )
$$;

CREATE FUNCTION app_owns_pending_booking(p_booking_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
        SELECT 1 FROM bookings
        WHERE id = p_booking_id AND player_id = app_current_user_id() AND status = 'pending'
    )
$$;

CREATE FUNCTION app_court_is_bookable(p_court_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (SELECT 1 FROM courts WHERE id = p_court_id AND is_active)
$$;

-- Lets a court owner see the players who booked their courts.
CREATE FUNCTION app_player_booked_my_court(p_player_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
        SELECT 1
        FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE b.player_id = p_player_id AND c.owner_id = app_current_user_id()
    )
$$;

-- -----------------------------------------------------------------------------
-- Booking holds
-- -----------------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN hold_expires_at TIMESTAMPTZ;

-- Backfill holds for bookings that existed before this migration.
UPDATE bookings SET hold_expires_at = created_at + interval '15 minutes'
WHERE status = 'pending';

ALTER TABLE bookings ADD CONSTRAINT bookings_hold_chk
    CHECK (status <> 'pending' OR hold_expires_at IS NOT NULL);

CREATE INDEX bookings_pending_hold_idx ON bookings (hold_expires_at) WHERE status = 'pending';

-- How long an unpaid booking holds its slot. Change it by replacing this function.
CREATE FUNCTION booking_hold_interval() RETURNS INTERVAL
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '15 minutes' $$;

-- Cancels every pending booking whose hold has expired. Run it from a
-- scheduler (e.g. every minute) to keep availability listings accurate.
-- Returns the number of bookings cancelled.
CREATE FUNCTION expire_stale_bookings() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n INTEGER;
BEGIN
    UPDATE bookings
    SET status = 'cancelled', cancelled_at = now()
    WHERE status = 'pending' AND hold_expires_at <= now();
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END
$$;

-- Runs before every booking insert:
--   * prices the booking from the court's current hourly rate
--   * starts the hold timer
--   * releases expired holds that overlap the requested slot, so a stale
--     pending booking never blocks a new one even if the cleanup job lags
CREATE FUNCTION bookings_before_insert() RETURNS trigger
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

    IF NEW.status = 'pending' THEN
        NEW.hold_expires_at := now() + booking_hold_interval();
    END IF;

    -- Invalid ranges are left for bookings_time_order_chk to reject.
    IF NEW.end_time > NEW.start_time THEN
        UPDATE bookings
        SET status = 'cancelled', cancelled_at = now()
        WHERE court_id = NEW.court_id
          AND status = 'pending'
          AND hold_expires_at <= now()
          AND tstzrange(start_time, end_time, '[)') && tstzrange(NEW.start_time, NEW.end_time, '[)');
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER bookings_before_insert
    BEFORE INSERT ON bookings
    FOR EACH ROW EXECUTE FUNCTION bookings_before_insert();

-- Booking lifecycle:  pending -> confirmed -> cancelled,  pending -> cancelled.
-- A cancelled booking is final; a late payment on it must be refunded.
CREATE FUNCTION bookings_check_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
        RAISE EXCEPTION 'booking % is cancelled and cannot be reopened', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'confirmed' AND NEW.status = 'pending' THEN
        RAISE EXCEPTION 'booking % is confirmed and cannot return to pending', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER bookings_check_status_transition
    BEFORE UPDATE OF status ON bookings
    FOR EACH ROW EXECUTE FUNCTION bookings_check_status_transition();

-- Transactions always charge exactly the booking's total.
CREATE FUNCTION transactions_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_amount   BIGINT;
    v_currency CHAR(3);
BEGIN
    SELECT total_amount, currency INTO v_amount, v_currency
    FROM bookings WHERE id = NEW.booking_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'booking % does not exist', NEW.booking_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    NEW.amount   := v_amount;
    NEW.currency := v_currency;
    RETURN NEW;
END
$$;

CREATE TRIGGER transactions_before_insert
    BEFORE INSERT ON transactions
    FOR EACH ROW EXECUTE FUNCTION transactions_before_insert();

-- -----------------------------------------------------------------------------
-- Actions (SECURITY DEFINER; each checks the caller's permission itself)
-- -----------------------------------------------------------------------------
-- Errors:  P0002 no_data_found          -> HTTP 404
--          42501 insufficient_privilege -> HTTP 403
--          23514 check_violation        -> HTTP 409 (invalid state transition)

-- Sign-up. Runs before the user has an identity, so it can't rely on RLS.
CREATE FUNCTION register_user(p_email TEXT, p_password_hash TEXT, p_role user_role DEFAULT 'player')
RETURNS UUID
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    INSERT INTO users (email, password_hash, role)
    VALUES (p_email, p_password_hash, p_role)
    RETURNING id
$$;

-- Login lookup by email. The API verifies the password hash itself.
CREATE FUNCTION find_user_for_login(p_email TEXT)
RETURNS TABLE (id UUID, password_hash TEXT, role user_role)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT u.id, u.password_hash, u.role FROM users u WHERE lower(u.email) = lower(p_email)
$$;

-- The booking's player or the court's owner may cancel.
CREATE FUNCTION cancel_booking(p_booking_id UUID) RETURNS bookings
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

    UPDATE bookings SET status = 'cancelled', cancelled_at = now()
    WHERE id = p_booking_id
    RETURNING * INTO b;
    RETURN b;
END
$$;

-- Manual confirmation by the court owner (e.g. paid in cash at the venue).
CREATE FUNCTION confirm_booking(p_booking_id UUID) RETURNS bookings
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

    UPDATE bookings SET status = 'confirmed'
    WHERE id = p_booking_id
    RETURNING * INTO b;   -- a cancelled booking is rejected by the transition trigger
    RETURN b;
END
$$;

-- Applies a PayMongo result. Call it from the webhook handler after
-- verifying the PayMongo signature. Safe to call repeatedly with the same input.
--   paid     -> pending booking becomes confirmed
--   refunded -> booking becomes cancelled
-- Returns the booking's resulting status. 'cancelled' together with a 'paid'
-- input means the hold expired before payment arrived: the API should refund.
CREATE FUNCTION record_payment_result(p_provider_ref_id TEXT, p_status transaction_status)
RETURNS booking_status
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    t transactions;
    v_booking_status booking_status;
BEGIN
    IF p_status = 'pending' THEN
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
        WHERE id = t.booking_id AND status = 'pending';
    ELSIF p_status = 'refunded' THEN
        UPDATE bookings SET status = 'cancelled', cancelled_at = now()
        WHERE id = t.booking_id AND status <> 'cancelled';
    END IF;

    SELECT status INTO v_booking_status FROM bookings WHERE id = t.booking_id;
    RETURN v_booking_status;
END
$$;

-- -----------------------------------------------------------------------------
-- Row-level security policies
-- -----------------------------------------------------------------------------
ALTER TABLE users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE courts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- users: see yourself, and owners see players who booked their courts.
-- Sign-up and login go through register_user() / find_user_for_login().
CREATE POLICY users_select ON users FOR SELECT TO picksched_app
    USING (id = app_current_user_id() OR app_player_booked_my_court(id));
CREATE POLICY users_update_self ON users FOR UPDATE TO picksched_app
    USING (id = app_current_user_id())
    WITH CHECK (id = app_current_user_id());

-- courts: everyone sees active courts; owners see and manage their own.
CREATE POLICY courts_select ON courts FOR SELECT TO picksched_app
    USING (is_active OR owner_id = app_current_user_id());
CREATE POLICY courts_insert ON courts FOR INSERT TO picksched_app
    WITH CHECK (owner_id = app_current_user_id());
CREATE POLICY courts_update ON courts FOR UPDATE TO picksched_app
    USING (owner_id = app_current_user_id())
    WITH CHECK (owner_id = app_current_user_id());
CREATE POLICY courts_delete ON courts FOR DELETE TO picksched_app
    USING (owner_id = app_current_user_id());

-- bookings: players see their own; owners see bookings on their courts.
-- Players book only for themselves, only on active courts.
-- Status changes go through cancel_booking / confirm_booking / record_payment_result.
CREATE POLICY bookings_select ON bookings FOR SELECT TO picksched_app
    USING (player_id = app_current_user_id() OR app_owns_court(court_id));
CREATE POLICY bookings_insert ON bookings FOR INSERT TO picksched_app
    WITH CHECK (
        player_id = app_current_user_id()
        AND status = 'pending'
        AND app_court_is_bookable(court_id)
    );

-- transactions: visible to the booking's player and the court's owner
-- (financial reports). The player starts payment on their own pending
-- booking and stores the PayMongo id; results arrive via record_payment_result.
CREATE POLICY transactions_select ON transactions FOR SELECT TO picksched_app
    USING (app_can_view_booking(booking_id));
CREATE POLICY transactions_insert ON transactions FOR INSERT TO picksched_app
    WITH CHECK (app_owns_pending_booking(booking_id));
CREATE POLICY transactions_update ON transactions FOR UPDATE TO picksched_app
    USING (status = 'pending' AND app_owns_pending_booking(booking_id))
    WITH CHECK (status = 'pending' AND app_owns_pending_booking(booking_id));

-- -----------------------------------------------------------------------------
-- Privileges. Column lists keep sensitive fields server-controlled:
-- role, owner_id, status, prices and amounts are never writable directly.
-- `id` is insertable so the API can supply its own UUID and retry safely.
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO picksched_app;

GRANT SELECT ON users TO picksched_app;
GRANT UPDATE (email, password_hash) ON users TO picksched_app;

GRANT SELECT, DELETE ON courts TO picksched_app;
GRANT INSERT (id, owner_id, name, description, location, hourly_rate, currency, is_active) ON courts TO picksched_app;
GRANT UPDATE (name, description, location, hourly_rate, currency, is_active) ON courts TO picksched_app;

GRANT SELECT ON bookings TO picksched_app;
GRANT INSERT (id, court_id, player_id, start_time, end_time) ON bookings TO picksched_app;

GRANT SELECT ON transactions TO picksched_app;
GRANT INSERT (id, booking_id) ON transactions TO picksched_app;
GRANT UPDATE (provider_ref_id) ON transactions TO picksched_app;

-- SECURITY DEFINER functions are executable by PUBLIC by default; restrict them.
REVOKE EXECUTE ON FUNCTION
    app_owns_court(UUID), app_can_view_booking(UUID), app_owns_pending_booking(UUID),
    app_court_is_bookable(UUID), app_player_booked_my_court(UUID),
    expire_stale_bookings(), register_user(TEXT, TEXT, user_role), find_user_for_login(TEXT),
    cancel_booking(UUID), confirm_booking(UUID), record_payment_result(TEXT, transaction_status)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    app_owns_court(UUID), app_can_view_booking(UUID), app_owns_pending_booking(UUID),
    app_court_is_bookable(UUID), app_player_booked_my_court(UUID),
    expire_stale_bookings(), register_user(TEXT, TEXT, user_role), find_user_for_login(TEXT),
    cancel_booking(UUID), confirm_booking(UUID), record_payment_result(TEXT, transaction_status)
TO picksched_app;

COMMIT;
