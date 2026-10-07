-- =============================================================================
-- Tests for migration 004: booking workflow (pending_payment, expires_at,
-- checkout hold (15 minutes since migration 005), owners can't change bookings during checkout).
--   psql -v ON_ERROR_STOP=1 -d <db> -f db/tests/booking_workflow_test.sql
-- Runs inside a transaction that is rolled back at the end.
-- =============================================================================
\set QUIET on
\o /dev/null
BEGIN;

CREATE FUNCTION pg_temp.expect_error(stmt TEXT, expected TEXT, label TEXT) RETURNS void AS $$
BEGIN
    BEGIN
        EXECUTE stmt;
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = expected THEN
            RAISE NOTICE 'PASS  %', label;
            RETURN;
        END IF;
        RAISE EXCEPTION 'FAIL  % (expected %, got %: %)', label, expected, SQLSTATE, SQLERRM;
    END;
    RAISE EXCEPTION 'FAIL  % (expected %, statement succeeded)', label, expected;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION pg_temp.expect_value(query TEXT, expected TEXT, label TEXT) RETURNS void AS $$
DECLARE
    actual TEXT;
BEGIN
    EXECUTE query INTO actual;
    IF actual IS DISTINCT FROM expected THEN
        RAISE EXCEPTION 'FAIL  % (expected %, got %)', label, expected, actual;
    END IF;
    RAISE NOTICE 'PASS  %', label;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION pg_temp.act_as(p_user UUID) RETURNS void AS $$
    SELECT set_config('app.current_user_id', coalesce(p_user::text, ''), true);
$$ LANGUAGE sql;

-- Tomorrow (local Manila date) and helpers for times on that day.
CREATE FUNCTION pg_temp.d() RETURNS DATE AS $$
    SELECT (now() AT TIME ZONE 'Asia/Manila')::date + 1
$$ LANGUAGE sql STABLE;
CREATE FUNCTION pg_temp.at(h INTEGER) RETURNS TIMESTAMPTZ AS $$
    SELECT (pg_temp.d() + make_interval(hours => h)) AT TIME ZONE 'Asia/Manila'
$$ LANGUAGE sql STABLE;
-- Status of court c1's slot starting at hour h tomorrow, as the current user sees it.
CREATE FUNCTION pg_temp.slot(h INTEGER, col TEXT DEFAULT 'status') RETURNS TEXT AS $$
DECLARE
    v TEXT;
BEGIN
    EXECUTE format(
        'SELECT %I::text FROM get_availability($1, 1, $2) WHERE slot_start = $3', col)
    INTO v USING pg_temp.d(), '00000000-0000-0000-0000-0000000000c1'::uuid, pg_temp.at(h);
    RETURN v;
END
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO picksched_app;

-- Fixtures --------------------------------------------------------------------
INSERT INTO users (id, email, password_hash, role) VALUES
    ('00000000-0000-0000-0000-00000000000a', 'owner-a@example.com',  'x', 'admin'),
    ('00000000-0000-0000-0000-00000000000d', 'owner-d@example.com',  'x', 'admin'),
    ('00000000-0000-0000-0000-00000000000b', 'player-b@example.com', 'x', 'player'),
    ('00000000-0000-0000-0000-00000000000e', 'player-e@example.com', 'x', 'player');

INSERT INTO courts (id, owner_id, name, hourly_rate, is_active) VALUES
    ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a', 'A1', 40000, true),
    ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000000a', 'A2 (closed)', 40000, false),
    ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-00000000000d', 'D1', 60000, true);

SET LOCAL ROLE picksched_app;

SELECT pg_temp.expect_value($$SELECT string_agg(e::text, ',' ORDER BY e) FROM unnest(enum_range(NULL::booking_status)) e$$,
    'pending_payment,confirmed,cancelled', 'booking statuses are pending_payment, confirmed, cancelled');
SELECT pg_temp.expect_value($$SELECT booking_hold_interval()::text$$, '00:15:00', 'checkout hold is 15 minutes');

-- Reservation -------------------------------------------------------------------
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
INSERT INTO bookings (id, court_id, player_id, start_time, end_time) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
     '00000000-0000-0000-0000-00000000000b', pg_temp.at(9), pg_temp.at(10));
SELECT pg_temp.expect_value($$SELECT status::text FROM bookings WHERE id = '00000000-0000-0000-0000-0000000000b1'$$,
    'pending_payment', 'new booking starts as pending_payment');
SELECT pg_temp.expect_value($$SELECT (expires_at = now() + interval '15 minutes')::text
    FROM bookings WHERE id = '00000000-0000-0000-0000-0000000000b1'$$,
    'true', 'expires_at is set to 15 minutes from now');
SELECT pg_temp.expect_error($$INSERT INTO bookings (court_id, player_id, start_time, end_time)
    VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000b',
            pg_temp.at(9), pg_temp.at(10))$$,
    '23P01', 'a held slot cannot be reserved again');
SELECT pg_temp.expect_error($$INSERT INTO bookings (court_id, player_id, start_time, end_time, status)
    VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000b',
            pg_temp.at(11), pg_temp.at(12), 'confirmed')$$,
    '42501', 'players cannot create a booking that skips payment');
SELECT pg_temp.expect_error($$INSERT INTO bookings (court_id, player_id, start_time, end_time)
    VALUES ('00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-00000000000b',
            pg_temp.at(11), pg_temp.at(12))$$,
    '23503', 'a booking needs a valid court');
RESET ROLE;
SELECT pg_temp.expect_error($$INSERT INTO bookings (court_id, player_id, start_time, end_time)
    VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000ff',
            pg_temp.at(11), pg_temp.at(12))$$,
    '23503', 'a booking needs a valid player');
SET LOCAL ROLE picksched_app;

-- Owners can't touch a booking during checkout ------------------------------------
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
SELECT pg_temp.expect_value($$SELECT status::text FROM bookings WHERE id = '00000000-0000-0000-0000-0000000000b1'$$,
    'pending_payment', 'owner can view the booking in checkout');
SELECT pg_temp.expect_error($$SELECT cancel_booking('00000000-0000-0000-0000-0000000000b1')$$,
    '55006', 'owner cannot cancel a booking in checkout');
SELECT pg_temp.expect_error($$SELECT confirm_booking('00000000-0000-0000-0000-0000000000b1')$$,
    '55006', 'owner cannot confirm a booking in checkout');
SELECT pg_temp.expect_error($$SELECT reschedule_booking('00000000-0000-0000-0000-0000000000b1',
    '00000000-0000-0000-0000-0000000000c1', pg_temp.at(15), pg_temp.at(16))$$,
    '55006', 'owner cannot reschedule a booking in checkout');

-- The player can abandon their own checkout
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
INSERT INTO bookings (id, court_id, player_id, start_time, end_time) VALUES
    ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000c1',
     '00000000-0000-0000-0000-00000000000b', pg_temp.at(11), pg_temp.at(12));
SELECT pg_temp.expect_value($$SELECT (cancel_booking('00000000-0000-0000-0000-0000000000b2')).status::text$$,
    'cancelled', 'player can cancel their own checkout');

-- After the hold expires --------------------------------------------------------
RESET ROLE;
UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = '00000000-0000-0000-0000-0000000000b1';
SET LOCAL ROLE picksched_app;
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
SELECT pg_temp.expect_error($$SELECT confirm_booking('00000000-0000-0000-0000-0000000000b1')$$,
    '23514', 'an expired unpaid booking cannot be confirmed');
SELECT pg_temp.expect_value($$SELECT expire_stale_bookings()::text$$, '1', 'cleanup cancels the abandoned booking');
SELECT pg_temp.expect_value($$SELECT status::text || ',' || (cancelled_at IS NOT NULL)::text
    FROM bookings WHERE id = '00000000-0000-0000-0000-0000000000b1'$$,
    'cancelled,true', 'abandoned booking is cancelled');
SELECT pg_temp.expect_value($$SELECT pg_temp.slot(9)$$, 'available', 'the slot is open again');

-- Confirmed bookings stay manageable by the owner
RESET ROLE;
INSERT INTO bookings (id, court_id, player_id, start_time, end_time, status) VALUES
    ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000c1',
     '00000000-0000-0000-0000-00000000000e', pg_temp.at(14), pg_temp.at(15), 'confirmed');
SET LOCAL ROLE picksched_app;
SELECT pg_temp.expect_value($$SELECT (cancel_booking('00000000-0000-0000-0000-0000000000b3')).status::text$$,
    'cancelled', 'owner can cancel a confirmed booking');

ROLLBACK;
\echo 'All booking workflow tests passed.'
