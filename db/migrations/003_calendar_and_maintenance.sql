-- =============================================================================
-- PickSched — Migration 003: Booking calendar support
-- Depends on: 001_initial_schema.sql, 002_booking_holds_and_access_control.sql
-- =============================================================================
--
-- 1. Court schedule settings: timezone, opening hours and slot length.
-- 2. Maintenance blocks (court_blocks): owners take a court out of service
--    for a time range. Blocks and active bookings can never overlap; this is
--    enforced under concurrency with a per-court transaction lock.
-- 3. Advance booking rule: players must book at least booking_min_lead_time()
--    (1 hour) ahead.
-- 4. reschedule_booking(): owners move a booking to another time or court.
-- 5. get_availability(): slot-by-slot availability for the calendar, with
--    booking details shown only to the court owner and the booking's player.
-- 6. Change notifications: every booking/block change sends
--    NOTIFY picksched_schedule so the API can push live calendar updates.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Court schedule settings
-- -----------------------------------------------------------------------------
CREATE FUNCTION is_valid_timezone(p_tz TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
BEGIN
    PERFORM now() AT TIME ZONE p_tz;
    RETURN TRUE;
EXCEPTION WHEN invalid_parameter_value THEN
    RETURN FALSE;
END
$$;

ALTER TABLE courts
    ADD COLUMN timezone     TEXT    NOT NULL DEFAULT 'Asia/Manila',
    ADD COLUMN opens_at     TIME    NOT NULL DEFAULT '06:00',
    ADD COLUMN closes_at    TIME    NOT NULL DEFAULT '22:00',
    ADD COLUMN slot_minutes INTEGER NOT NULL DEFAULT 60,
    ADD CONSTRAINT courts_hours_chk        CHECK (closes_at > opens_at),
    ADD CONSTRAINT courts_slot_minutes_chk CHECK (slot_minutes IN (30, 60, 90, 120)),
    ADD CONSTRAINT courts_slot_fits_chk    CHECK (
        extract(epoch FROM (closes_at - opens_at)) >= slot_minutes * 60
    );

CREATE FUNCTION courts_validate_timezone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT is_valid_timezone(NEW.timezone) THEN
        RAISE EXCEPTION 'unknown time zone "%"', NEW.timezone USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER courts_validate_timezone
    BEFORE INSERT OR UPDATE OF timezone ON courts
    FOR EACH ROW EXECUTE FUNCTION courts_validate_timezone();

GRANT INSERT (timezone, opens_at, closes_at, slot_minutes) ON courts TO picksched_app;
GRANT UPDATE (timezone, opens_at, closes_at, slot_minutes) ON courts TO picksched_app;

-- -----------------------------------------------------------------------------
-- 2. Maintenance blocks
-- -----------------------------------------------------------------------------
CREATE TABLE court_blocks (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    court_id   UUID        NOT NULL REFERENCES courts (id) ON DELETE CASCADE,
    created_by UUID        REFERENCES users (id) ON DELETE SET NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time   TIMESTAMPTZ NOT NULL,
    reason     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT court_blocks_time_order_chk CHECK (end_time > start_time),
    CONSTRAINT court_blocks_no_overlap EXCLUDE USING gist (
        court_id                              WITH =,
        tstzrange(start_time, end_time, '[)') WITH &&
    )
);

COMMENT ON TABLE court_blocks IS
    'Time ranges when a court is out of service (maintenance). Shown as unavailable in the calendar.';

-- Serializes schedule changes per court, so a booking and a maintenance block
-- created at the same moment cannot both succeed. Held until the transaction ends.
CREATE FUNCTION lock_court_schedule(p_court_id UUID) RETURNS void
LANGUAGE sql AS $$
    SELECT pg_advisory_xact_lock(hashtextextended(p_court_id::text, 0))
$$;

-- An active booking may not overlap a maintenance block.
CREATE FUNCTION bookings_check_maintenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF NEW.status NOT IN ('pending', 'confirmed') OR NEW.end_time <= NEW.start_time THEN
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

CREATE TRIGGER bookings_check_maintenance
    BEFORE INSERT OR UPDATE OF court_id, start_time, end_time, status ON bookings
    FOR EACH ROW EXECUTE FUNCTION bookings_check_maintenance();

-- A maintenance block may not overlap an active booking. Expired pending
-- holds in the way are released first (same rule as for new bookings).
CREATE FUNCTION court_blocks_before_write() RETURNS trigger
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
      AND status = 'pending'
      AND hold_expires_at <= now()
      AND tstzrange(start_time, end_time, '[)') && tstzrange(NEW.start_time, NEW.end_time, '[)');

    IF EXISTS (
        SELECT 1 FROM bookings
        WHERE court_id = NEW.court_id
          AND status IN ('pending', 'confirmed')
          AND tstzrange(start_time, end_time, '[)') && tstzrange(NEW.start_time, NEW.end_time, '[)')
    ) THEN
        RAISE EXCEPTION 'maintenance block overlaps existing bookings; cancel or move them first'
            USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'court_blocks_booking_overlap';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER court_blocks_before_write
    BEFORE INSERT OR UPDATE OF court_id, start_time, end_time ON court_blocks
    FOR EACH ROW EXECUTE FUNCTION court_blocks_before_write();

ALTER TABLE court_blocks ENABLE ROW LEVEL SECURITY;

-- Only the court's owner reads or manages blocks directly. Everyone else
-- sees blocked slots as 'maintenance' through get_availability().
CREATE POLICY court_blocks_owner_all ON court_blocks FOR ALL TO picksched_app
    USING (app_owns_court(court_id))
    WITH CHECK (app_owns_court(court_id));

GRANT SELECT, DELETE ON court_blocks TO picksched_app;
GRANT INSERT (id, court_id, start_time, end_time, reason) ON court_blocks TO picksched_app;
GRANT UPDATE (start_time, end_time, reason) ON court_blocks TO picksched_app;

-- -----------------------------------------------------------------------------
-- 3. Advance booking rule
-- -----------------------------------------------------------------------------
-- Minimum time between now and a new booking's start. Change it by replacing
-- this function.
CREATE FUNCTION booking_min_lead_time() RETURNS INTERVAL
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '1 hour' $$;

DROP POLICY bookings_insert ON bookings;
CREATE POLICY bookings_insert ON bookings FOR INSERT TO picksched_app
    WITH CHECK (
        player_id = app_current_user_id()
        AND status = 'pending'
        AND app_court_is_bookable(court_id)
        AND start_time >= now() + booking_min_lead_time()
    );

-- -----------------------------------------------------------------------------
-- 4. Owner rescheduling
-- -----------------------------------------------------------------------------
-- Moves an active booking to a new time and/or one of the owner's courts.
-- The price stays as originally charged. Overlaps with other bookings or
-- maintenance fail with 23P01.
CREATE FUNCTION reschedule_booking(
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

-- -----------------------------------------------------------------------------
-- 5. Calendar availability
-- -----------------------------------------------------------------------------
-- One row per slot for each visible court, for p_days days starting at
-- p_start_date (a local date in each court's own time zone).
--
-- status:
--   available    open and bookable
--   booked       held or confirmed by someone else
--   mine         held or confirmed by the caller
--   maintenance  covered by a maintenance block
--   unavailable  in the past, or inside the minimum advance-booking window
--
-- Booking and block details are returned only to the court owner, and to
-- the player for their own bookings. Other players see only the status.
CREATE FUNCTION get_availability(
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
           CASE WHEN bk.player_id = v_user OR s.owner_id = v_user THEN bk.hold_expires_at END,
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
        SELECT b.id, b.player_id, b.status, b.start_time, b.end_time, b.hold_expires_at
        FROM bookings b
        WHERE b.court_id = s.court_id
          AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > now()))
          AND tstzrange(b.start_time, b.end_time, '[)') && tstzrange(s.s, s.e, '[)')
        ORDER BY (b.player_id = v_user) DESC, b.start_time
        LIMIT 1
    ) bk ON TRUE
    LEFT JOIN users u ON u.id = bk.player_id
    ORDER BY s.court_id, s.s;
END
$$;

-- -----------------------------------------------------------------------------
-- 6. Change notifications
-- -----------------------------------------------------------------------------
-- Payload: {"court_id": "...", "start_time": "...", "end_time": "..."}.
-- It contains no personal data, so it is safe to broadcast to every viewer.
CREATE FUNCTION notify_schedule_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        PERFORM pg_notify('picksched_schedule', json_build_object(
            'court_id', OLD.court_id, 'start_time', OLD.start_time, 'end_time', OLD.end_time)::text);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        PERFORM pg_notify('picksched_schedule', json_build_object(
            'court_id', NEW.court_id, 'start_time', NEW.start_time, 'end_time', NEW.end_time)::text);
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER bookings_notify_schedule_change
    AFTER INSERT OR UPDATE OR DELETE ON bookings
    FOR EACH ROW EXECUTE FUNCTION notify_schedule_change();

CREATE TRIGGER court_blocks_notify_schedule_change
    AFTER INSERT OR UPDATE OR DELETE ON court_blocks
    FOR EACH ROW EXECUTE FUNCTION notify_schedule_change();

-- -----------------------------------------------------------------------------
-- Function privileges
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
    reschedule_booking(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ),
    get_availability(DATE, INTEGER, UUID, BOOLEAN)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    reschedule_booking(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ),
    get_availability(DATE, INTEGER, UUID, BOOLEAN)
TO picksched_app;

COMMIT;
