-- =============================================================================
-- Tests for migration 003: court hours, maintenance blocks, advance-booking
-- rule, owner rescheduling and get_availability().
--   psql -v ON_ERROR_STOP=1 -d <db> -f db/tests/calendar_test.sql
-- Runs inside a transaction that is rolled back at the end.
-- Dates are relative to "tomorrow" in Asia/Manila, so the tests never age out.
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

-- Court settings ----------------------------------------------------------------
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
SELECT pg_temp.expect_error($$UPDATE courts SET timezone = 'Mars/Olympus' WHERE name = 'A1'$$,
    '23514', 'invalid court time zone rejected');
SELECT pg_temp.expect_error($$UPDATE courts SET closes_at = '05:00' WHERE name = 'A1'$$,
    '23514', 'closing time must be after opening time');
SELECT pg_temp.expect_error($$UPDATE courts SET slot_minutes = 45 WHERE name = 'A1'$$,
    '23514', 'slot length limited to 30/60/90/120 minutes');

-- Availability grid -------------------------------------------------------------
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM get_availability(pg_temp.d(), 1,
    '00000000-0000-0000-0000-0000000000c1')$$, '16', '06:00-22:00 in 60 minute slots gives 16 slots');
SELECT pg_temp.expect_value($$SELECT (min(slot_start) = pg_temp.at(6))::text FROM get_availability(pg_temp.d(), 1,
    '00000000-0000-0000-0000-0000000000c1')$$, 'true', 'first slot starts at 06:00 court-local time');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM get_availability(pg_temp.d(), 7,
    '00000000-0000-0000-0000-0000000000c1')$$, '112', 'week view returns 7 days of slots');
SELECT pg_temp.expect_value($$SELECT count(DISTINCT court_id)::text FROM get_availability(pg_temp.d())$$,
    '2', 'player sees active courts only');
SELECT pg_temp.expect_value($$SELECT string_agg(DISTINCT status, ',') FROM get_availability(pg_temp.d() - 2, 1)$$,
    'unavailable', 'past slots are unavailable');
SELECT pg_temp.expect_value($$SELECT pg_temp.slot(9)$$, 'available', 'open future slot is available');
SELECT pg_temp.expect_error($$SELECT * FROM get_availability(pg_temp.d(), 32)$$,
    '22023', 'range limited to 31 days');

-- Advance booking rule -------------------------------------------------------------
SELECT pg_temp.expect_error($$INSERT INTO bookings (court_id, player_id, start_time, end_time)
    VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000b',
            now() + interval '30 minutes', now() + interval '90 minutes')$$,
    '42501', 'booking less than 1 hour ahead rejected');
SELECT pg_temp.expect_error($$INSERT INTO bookings (court_id, player_id, start_time, end_time)
    VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000b',
            now() - interval '2 hours', now() - interval '1 hour')$$,
    '42501', 'booking in the past rejected');

-- Booking visibility -------------------------------------------------------------
INSERT INTO bookings (id, court_id, player_id, start_time, end_time) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
     '00000000-0000-0000-0000-00000000000b', pg_temp.at(9), pg_temp.at(10));
SELECT pg_temp.expect_value($$SELECT pg_temp.slot(9)$$, 'mine', 'player sees own booking as mine');
SELECT pg_temp.expect_value($$SELECT pg_temp.slot(9, 'booking_id')$$,
    '00000000-0000-0000-0000-0000000000b1', 'player sees own booking id');

SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
SELECT pg_temp.expect_value($$SELECT pg_temp.slot(9)$$, 'booked', 'other player sees slot as booked');
SELECT pg_temp.expect_value($$SELECT coalesce(pg_temp.slot(9, 'booking_id'), 'hidden')$$,
    'hidden', 'other player gets no booking details');

SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
SELECT pg_temp.expect_value($$SELECT pg_temp.slot(9) || ' ' || pg_temp.slot(9, 'player_email')$$,
    'booked player-b@example.com', 'owner sees booking with player email');
SELECT pg_temp.expect_value($$SELECT count(DISTINCT court_id)::text FROM get_availability(pg_temp.d(), 1, NULL, true)$$,
    '2', 'owner-only view includes own inactive court and excludes others');

-- Maintenance blocks -----------------------------------------------------------------
INSERT INTO court_blocks (court_id, start_time, end_time, reason) VALUES
    ('00000000-0000-0000-0000-0000000000c1', pg_temp.at(12), pg_temp.at(14), 'Resurfacing');
SELECT pg_temp.expect_value($$SELECT pg_temp.slot(12) || ' ' || pg_temp.slot(13, 'block_reason')$$,
    'maintenance Resurfacing', 'owner sees maintenance block with reason');
SELECT pg_temp.expect_value($$SELECT created_by::text FROM court_blocks$$,
    '00000000-0000-0000-0000-00000000000a', 'block records who created it');
SELECT pg_temp.expect_error($$INSERT INTO court_blocks (court_id, start_time, end_time)
    VALUES ('00000000-0000-0000-0000-0000000000c1', pg_temp.at(13), pg_temp.at(15))$$,
    '23P01', 'overlapping maintenance blocks rejected');
SELECT pg_temp.expect_error($$INSERT INTO court_blocks (court_id, start_time, end_time)
    VALUES ('00000000-0000-0000-0000-0000000000c1', pg_temp.at(9), pg_temp.at(10))$$,
    '23P01', 'maintenance block over an active booking rejected');

SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
SELECT pg_temp.expect_value($$SELECT pg_temp.slot(13) || ' ' || coalesce(pg_temp.slot(13, 'block_reason'), 'hidden')$$,
    'maintenance hidden', 'player sees maintenance without the reason');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM court_blocks$$, '0', 'player cannot read blocks directly');
SELECT pg_temp.expect_error($$INSERT INTO bookings (court_id, player_id, start_time, end_time)
    VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000e',
            pg_temp.at(13), pg_temp.at(14))$$,
    '23P01', 'booking during maintenance rejected');
SELECT pg_temp.expect_error($$INSERT INTO court_blocks (court_id, start_time, end_time)
    VALUES ('00000000-0000-0000-0000-0000000000c1', pg_temp.at(18), pg_temp.at(19))$$,
    '42501', 'player cannot create maintenance blocks');

SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
SELECT pg_temp.expect_error($$INSERT INTO court_blocks (court_id, start_time, end_time)
    VALUES ('00000000-0000-0000-0000-0000000000c1', pg_temp.at(18), pg_temp.at(19))$$,
    '42501', 'owner cannot block another owner''s court');

SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
DELETE FROM court_blocks WHERE reason = 'Resurfacing';
SELECT pg_temp.expect_value($$SELECT pg_temp.slot(12)$$, 'available', 'deleting a block reopens the slots');

-- Expired holds give way to maintenance
RESET ROLE;
UPDATE bookings SET expires_at = now() - interval '1 second'
WHERE id = '00000000-0000-0000-0000-0000000000b1';
SET LOCAL ROLE picksched_app;
SELECT pg_temp.expect_value($$SELECT pg_temp.slot(9)$$, 'available', 'expired hold shows as available');
INSERT INTO court_blocks (court_id, start_time, end_time) VALUES
    ('00000000-0000-0000-0000-0000000000c1', pg_temp.at(9), pg_temp.at(10));
RESET ROLE;
SELECT pg_temp.expect_value($$SELECT status::text FROM bookings WHERE id = '00000000-0000-0000-0000-0000000000b1'$$,
    'cancelled', 'maintenance block releases an expired hold');
SET LOCAL ROLE picksched_app;

-- Owner rescheduling -----------------------------------------------------------------
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
INSERT INTO bookings (id, court_id, player_id, start_time, end_time) VALUES
    ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1',
     '00000000-0000-0000-0000-00000000000e', pg_temp.at(15), pg_temp.at(16));
SELECT pg_temp.expect_error($$SELECT reschedule_booking('00000000-0000-0000-0000-0000000000e1',
    '00000000-0000-0000-0000-0000000000c1', pg_temp.at(16), pg_temp.at(17))$$,
    '42501', 'player cannot reschedule');

SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
SELECT pg_temp.expect_error($$SELECT reschedule_booking('00000000-0000-0000-0000-0000000000e1',
    '00000000-0000-0000-0000-0000000000c1', pg_temp.at(16), pg_temp.at(17))$$,
    '55006', 'owner cannot reschedule a booking that is in checkout');
RESET ROLE;  -- simulate the payment completing
UPDATE bookings SET status = 'confirmed' WHERE id = '00000000-0000-0000-0000-0000000000e1';
SET LOCAL ROLE picksched_app;
SELECT pg_temp.expect_value($$SELECT ((reschedule_booking('00000000-0000-0000-0000-0000000000e1',
    '00000000-0000-0000-0000-0000000000c1', pg_temp.at(16), pg_temp.at(17))).start_time = pg_temp.at(16))::text$$,
    'true', 'owner reschedules a booking');
SELECT pg_temp.expect_value($$SELECT pg_temp.slot(15) || ',' || pg_temp.slot(16)$$,
    'available,booked', 'rescheduled booking moves in the calendar');
SELECT pg_temp.expect_error($$SELECT reschedule_booking('00000000-0000-0000-0000-0000000000e1',
    '00000000-0000-0000-0000-0000000000c1', pg_temp.at(9), pg_temp.at(10))$$,
    '23P01', 'cannot reschedule into maintenance');
SELECT pg_temp.expect_error($$SELECT reschedule_booking('00000000-0000-0000-0000-0000000000e1',
    '00000000-0000-0000-0000-0000000000c3', pg_temp.at(16), pg_temp.at(17))$$,
    '42501', 'cannot move a booking to another owner''s court');
SELECT pg_temp.expect_error($$SELECT reschedule_booking('00000000-0000-0000-0000-0000000000e1',
    '00000000-0000-0000-0000-0000000000c1', now() - interval '3 hours', now() - interval '2 hours')$$,
    '23514', 'cannot reschedule into the past');

ROLLBACK;
\echo 'All calendar tests passed.'
