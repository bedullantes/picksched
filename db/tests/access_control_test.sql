-- =============================================================================
-- Tests for migration 002: booking holds, server-side pricing, status
-- transitions, payment results and role-based access control (RLS).
--   psql -v ON_ERROR_STOP=1 -d <db> -f db/tests/access_control_test.sql
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

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO picksched_app;

CREATE FUNCTION pg_temp.act_as(p_user UUID) RETURNS void AS $$
    SELECT set_config('app.current_user_id', coalesce(p_user::text, ''), true);
$$ LANGUAGE sql;

-- Fixtures (as table owner, RLS bypassed) -------------------------------------
-- a = owner A, d = owner D, b = player B, e = player E
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

-- Sign-up and login ----------------------------------------------------------
SELECT pg_temp.expect_value($$SELECT (register_user('new@example.com', 'h') IS NOT NULL)::text$$,
    'true', 'register_user creates a player');
SELECT pg_temp.expect_value($$SELECT role::text FROM find_user_for_login('NEW@example.com')$$,
    'player', 'find_user_for_login matches email without regard to case');
SELECT pg_temp.expect_error($$INSERT INTO users (email, password_hash) VALUES ('x@y.co', 'h')$$,
    '42501', 'direct insert into users is not allowed');

-- Player B -------------------------------------------------------------------
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000b');

SELECT pg_temp.expect_value($$SELECT count(*)::text FROM users$$, '1', 'player sees only own user row');
SELECT pg_temp.expect_error($$UPDATE users SET role = 'admin' WHERE id = app_current_user_id()$$,
    '42501', 'player cannot change own role');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM courts$$, '2', 'player sees active courts only');
SELECT pg_temp.expect_error($$INSERT INTO courts (owner_id, name, hourly_rate)
    VALUES ('00000000-0000-0000-0000-00000000000b', 'Mine', 1)$$,
    '23503', 'player cannot own a court');
SELECT pg_temp.expect_value($$WITH u AS (UPDATE courts SET hourly_rate = 1 RETURNING 1) SELECT count(*)::text FROM u$$,
    '0', 'player cannot update courts');

INSERT INTO bookings (id, court_id, player_id, start_time, end_time) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
     '00000000-0000-0000-0000-00000000000b', '2026-11-01 09:00+08', '2026-11-01 10:30+08');
SELECT pg_temp.expect_value($$SELECT total_amount::text FROM bookings WHERE id = '00000000-0000-0000-0000-0000000000b1'$$,
    '60000', 'total_amount computed from hourly rate (1.5h x 40000)');
SELECT pg_temp.expect_value($$SELECT (hold_expires_at = now() + interval '15 minutes')::text
    FROM bookings WHERE id = '00000000-0000-0000-0000-0000000000b1'$$,
    'true', 'pending booking gets a 15 minute hold');
SELECT pg_temp.expect_error($$INSERT INTO bookings (court_id, player_id, start_time, end_time, total_amount)
    VALUES ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-00000000000b',
            '2026-11-01 09:00+08', '2026-11-01 10:00+08', 1)$$,
    '42501', 'player cannot set total_amount');
SELECT pg_temp.expect_error($$INSERT INTO bookings (court_id, player_id, start_time, end_time)
    VALUES ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-00000000000e',
            '2026-11-01 09:00+08', '2026-11-01 10:00+08')$$,
    '42501', 'player cannot book on behalf of another player');
SELECT pg_temp.expect_error($$INSERT INTO bookings (court_id, player_id, start_time, end_time)
    VALUES ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000000b',
            '2026-11-01 09:00+08', '2026-11-01 10:00+08')$$,
    '42501', 'player cannot book an inactive court');
SELECT pg_temp.expect_error($$UPDATE bookings SET status = 'confirmed'
    WHERE id = '00000000-0000-0000-0000-0000000000b1'$$,
    '42501', 'player cannot set booking status directly');
SELECT pg_temp.expect_error($$SELECT confirm_booking('00000000-0000-0000-0000-0000000000b1')$$,
    '42501', 'player cannot confirm a booking manually');

-- Payment start
SELECT pg_temp.expect_error($$INSERT INTO transactions (booking_id, amount)
    VALUES ('00000000-0000-0000-0000-0000000000b1', 1)$$,
    '42501', 'player cannot set transaction amount');
INSERT INTO transactions (booking_id) VALUES ('00000000-0000-0000-0000-0000000000b1');
SELECT pg_temp.expect_value($$SELECT amount::text FROM transactions WHERE booking_id = '00000000-0000-0000-0000-0000000000b1'$$,
    '60000', 'transaction amount copied from booking');
UPDATE transactions SET provider_ref_id = 'pi_b1' WHERE booking_id = '00000000-0000-0000-0000-0000000000b1';
SELECT pg_temp.expect_error($$UPDATE transactions SET status = 'paid'
    WHERE booking_id = '00000000-0000-0000-0000-0000000000b1'$$,
    '42501', 'player cannot mark a transaction paid');

-- Player E: cannot see or touch B's data --------------------------------------
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM bookings$$, '0', 'player cannot see other players'' bookings');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM transactions$$, '0', 'player cannot see other players'' transactions');
SELECT pg_temp.expect_error($$SELECT cancel_booking('00000000-0000-0000-0000-0000000000b1')$$,
    'P0002', 'player cannot cancel another player''s booking');
SELECT pg_temp.expect_error($$INSERT INTO transactions (booking_id) VALUES ('00000000-0000-0000-0000-0000000000b1')$$,
    '42501', 'player cannot pay for another player''s booking');
SELECT pg_temp.expect_error($$INSERT INTO bookings (court_id, player_id, start_time, end_time)
    VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000e',
            '2026-11-01 10:00+08', '2026-11-01 11:00+08')$$,
    '23P01', 'active hold blocks an overlapping booking');

-- Owner D: no access to owner A's courts --------------------------------------
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM bookings$$, '0', 'owner cannot see bookings on other owners'' courts');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM courts$$, '2', 'owner sees own courts plus other active courts');
SELECT pg_temp.expect_value($$WITH u AS (UPDATE courts SET hourly_rate = 1
    WHERE id = '00000000-0000-0000-0000-0000000000c1' RETURNING 1) SELECT count(*)::text FROM u$$,
    '0', 'owner cannot update another owner''s court');
SELECT pg_temp.expect_error($$SELECT confirm_booking('00000000-0000-0000-0000-0000000000b1')$$,
    'P0002', 'owner cannot confirm bookings on another owner''s court');

-- Owner A: manages own courts, sees bookings and payments ---------------------
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM courts WHERE owner_id = app_current_user_id()$$,
    '2', 'owner sees own inactive courts');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM bookings$$, '1', 'owner sees bookings on own courts');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM transactions$$, '1', 'owner sees transactions on own courts');
SELECT pg_temp.expect_value($$SELECT email FROM users WHERE id = '00000000-0000-0000-0000-00000000000b'$$,
    'player-b@example.com', 'owner sees players who booked own courts');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM users WHERE id = '00000000-0000-0000-0000-00000000000e'$$,
    '0', 'owner cannot see unrelated players');
INSERT INTO courts (owner_id, name, hourly_rate) VALUES ('00000000-0000-0000-0000-00000000000a', 'A3', 30000);
UPDATE courts SET hourly_rate = 45000 WHERE name = 'A3';
DELETE FROM courts WHERE name = 'A3';
DO $$ BEGIN RAISE NOTICE 'PASS  owner can create, update and delete own court'; END $$;
SELECT pg_temp.expect_error($$UPDATE courts SET owner_id = '00000000-0000-0000-0000-00000000000d'
    WHERE id = '00000000-0000-0000-0000-0000000000c1'$$,
    '42501', 'owner cannot transfer a court');

-- Payment webhook ------------------------------------------------------------
SELECT pg_temp.act_as(NULL);
SELECT pg_temp.expect_error($$SELECT record_payment_result('pi_missing', 'paid')$$,
    'P0002', 'unknown PayMongo id rejected');
SELECT pg_temp.expect_value($$SELECT record_payment_result('pi_b1', 'paid')::text$$,
    'confirmed', 'paid webhook confirms booking');
SELECT pg_temp.expect_value($$SELECT record_payment_result('pi_b1', 'paid')::text$$,
    'confirmed', 'repeated paid webhook is harmless');
SELECT pg_temp.expect_error($$SELECT record_payment_result('pi_b1', 'failed')$$,
    '23514', 'paid transaction cannot become failed');
RESET ROLE;
SELECT pg_temp.expect_value($$SELECT status || ',' || (processed_at IS NOT NULL) FROM transactions WHERE provider_ref_id = 'pi_b1'$$,
    'paid,true', 'transaction marked paid with processed_at');
SET LOCAL ROLE picksched_app;

-- Status transitions ---------------------------------------------------------
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
SELECT pg_temp.expect_value($$SELECT (cancel_booking('00000000-0000-0000-0000-0000000000b1')).status::text$$,
    'cancelled', 'player cancels own confirmed booking');
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
SELECT pg_temp.expect_error($$SELECT confirm_booking('00000000-0000-0000-0000-0000000000b1')$$,
    '23514', 'cancelled booking cannot be reopened');
SELECT pg_temp.act_as(NULL);
SELECT pg_temp.expect_value($$SELECT record_payment_result('pi_b1', 'refunded')::text$$,
    'cancelled', 'refund recorded on cancelled booking');

-- Hold expiry ----------------------------------------------------------------
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
INSERT INTO bookings (id, court_id, player_id, start_time, end_time) VALUES
    ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-00000000000b', '2026-11-02 09:00+08', '2026-11-02 10:00+08'),
    ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-00000000000b', '2026-11-03 09:00+08', '2026-11-03 10:00+08');
INSERT INTO transactions (booking_id) VALUES ('00000000-0000-0000-0000-0000000000b2');
UPDATE transactions SET provider_ref_id = 'pi_b2' WHERE booking_id = '00000000-0000-0000-0000-0000000000b2';

RESET ROLE;  -- simulate both holds running out
UPDATE bookings SET hold_expires_at = now() - interval '1 second'
WHERE id IN ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b3');
SET LOCAL ROLE picksched_app;

SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
INSERT INTO bookings (court_id, player_id, start_time, end_time) VALUES
    ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-00000000000e',
     '2026-11-02 09:30+08', '2026-11-02 10:30+08');
DO $$ BEGIN RAISE NOTICE 'PASS  expired hold does not block a new booking'; END $$;

SELECT pg_temp.act_as(NULL);
SELECT pg_temp.expect_value($$SELECT record_payment_result('pi_b2', 'paid')::text$$,
    'cancelled', 'late payment on a released hold reports cancelled (refund needed)');
SELECT pg_temp.expect_value($$SELECT expire_stale_bookings()::text$$, '1', 'expire_stale_bookings cancels remaining stale holds');
SELECT pg_temp.expect_value($$SELECT expire_stale_bookings()::text$$, '0', 'expire_stale_bookings is safe to repeat');

ROLLBACK;
\echo 'All access control tests passed.'
