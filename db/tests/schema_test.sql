-- =============================================================================
-- Schema constraint tests. Run against a fresh database after migrations:
--   psql -v ON_ERROR_STOP=1 -d <db> -f db/tests/schema_test.sql
-- Everything runs inside a transaction that is rolled back at the end.
-- Any failed assertion raises an exception and aborts the script.
-- =============================================================================
\set QUIET on
\o /dev/null
BEGIN;

-- expect_error(sql, sqlstate): passes only if `sql` fails with that SQLSTATE.
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

INSERT INTO users (id, email, password_hash, role) VALUES
    ('00000000-0000-0000-0000-00000000000a', 'owner@example.com',  'x', 'admin'),
    ('00000000-0000-0000-0000-00000000000b', 'player@example.com', 'x', 'player');

INSERT INTO courts (id, owner_id, name, hourly_rate) VALUES
    ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a', 'Court 1', 50000),
    ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000000a', 'Court 2', 50000);

INSERT INTO bookings (id, court_id, player_id, start_time, end_time, total_amount) VALUES
    ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
     '00000000-0000-0000-0000-00000000000b', '2026-11-01 09:00+08', '2026-11-01 10:00+08', 50000);

-- users ----------------------------------------------------------------------
SELECT pg_temp.expect_error($$INSERT INTO users (email, password_hash) VALUES ('OWNER@example.com', 'x')$$,
    '23505', 'email unique, case-insensitive');
SELECT pg_temp.expect_error($$INSERT INTO users (email, password_hash) VALUES ('not-an-email', 'x')$$,
    '23514', 'email format');
SELECT pg_temp.expect_error($$INSERT INTO users (email, password_hash, role) VALUES ('a@b.co', 'x', 'superuser')$$,
    '22P02', 'role limited to admin/player');

-- courts ---------------------------------------------------------------------
SELECT pg_temp.expect_error($$INSERT INTO courts (owner_id, name, hourly_rate)
    VALUES ('00000000-0000-0000-0000-00000000000b', 'Player court', 100)$$,
    '23503', 'court owner must be an admin');
SELECT pg_temp.expect_error($$INSERT INTO courts (owner_id, name, hourly_rate)
    VALUES ('00000000-0000-0000-0000-0000000000ff', 'Ghost court', 100)$$,
    '23503', 'court owner must exist');
SELECT pg_temp.expect_error($$INSERT INTO courts (owner_id, name, hourly_rate)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'Neg', -1)$$,
    '23514', 'hourly_rate non-negative');
SELECT pg_temp.expect_error($$UPDATE users SET role = 'player' WHERE id = '00000000-0000-0000-0000-00000000000a'$$,
    '23503', 'cannot demote an owner who still owns courts');

-- bookings -------------------------------------------------------------------
SELECT pg_temp.expect_error($$INSERT INTO bookings (court_id, player_id, start_time, end_time, total_amount)
    VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000b',
            '2026-11-01 10:00+08', '2026-11-01 09:00+08', 0)$$,
    '23514', 'end_time after start_time');
SELECT pg_temp.expect_error($$INSERT INTO bookings (court_id, player_id, start_time, end_time, total_amount)
    VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000b',
            '2026-11-01 09:00+08', '2026-11-01 09:00+08', 0)$$,
    '23514', 'zero-length booking rejected');
SELECT pg_temp.expect_error($$INSERT INTO bookings (court_id, player_id, start_time, end_time, total_amount)
    VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000b',
            '2026-11-01 09:30+08', '2026-11-01 10:30+08', 50000)$$,
    '23P01', 'overlapping booking on same court rejected');
SELECT pg_temp.expect_error($$INSERT INTO bookings (court_id, player_id, start_time, end_time, total_amount)
    VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000b',
            '2026-11-01 08:00+08', '2026-11-01 11:00+08', 50000)$$,
    '23P01', 'enclosing booking on same court rejected');
SELECT pg_temp.expect_error($$INSERT INTO bookings (court_id, player_id, start_time, end_time, total_amount)
    VALUES ('00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-00000000000b',
            '2026-11-01 09:00+08', '2026-11-01 10:00+08', 0)$$,
    '23503', 'booking court must exist');
SELECT pg_temp.expect_error($$UPDATE bookings SET status = 'cancelled'
    WHERE id = '00000000-0000-0000-0000-0000000000b1'$$,
    '23514', 'cancelled booking requires cancelled_at');
SELECT pg_temp.expect_error($$DELETE FROM courts WHERE id = '00000000-0000-0000-0000-0000000000c1'$$,
    '23503', 'court with bookings cannot be deleted');

-- These must succeed.
INSERT INTO bookings (court_id, player_id, start_time, end_time, total_amount) VALUES
    ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000b',
     '2026-11-01 10:00+08', '2026-11-01 11:00+08', 50000);           -- back-to-back slot
INSERT INTO bookings (court_id, player_id, start_time, end_time, total_amount) VALUES
    ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000000b',
     '2026-11-01 09:00+08', '2026-11-01 10:00+08', 50000);           -- same time, other court
UPDATE bookings SET status = 'cancelled', cancelled_at = now()
    WHERE id = '00000000-0000-0000-0000-0000000000b1';
INSERT INTO bookings (id, court_id, player_id, start_time, end_time, total_amount) VALUES
    ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000c1',
     '00000000-0000-0000-0000-00000000000b', '2026-11-01 09:00+08', '2026-11-01 10:00+08', 50000);
DO $$ BEGIN RAISE NOTICE 'PASS  back-to-back, other-court and rebook-after-cancel allowed'; END $$;

-- transactions ---------------------------------------------------------------
INSERT INTO transactions (booking_id, amount) VALUES ('00000000-0000-0000-0000-0000000000b2', 50000);
SELECT pg_temp.expect_error($$INSERT INTO transactions (booking_id, amount)
    VALUES ('00000000-0000-0000-0000-0000000000b2', 50000)$$,
    '23505', 'one transaction per booking');
SELECT pg_temp.expect_error($$INSERT INTO transactions (booking_id, amount)
    VALUES ('00000000-0000-0000-0000-0000000000ff', 50000)$$,
    '23503', 'transaction booking must exist');
SELECT pg_temp.expect_error($$UPDATE transactions SET status = 'paid'
    WHERE booking_id = '00000000-0000-0000-0000-0000000000b2'$$,
    '23514', 'paid transaction requires provider_ref_id and processed_at');
UPDATE transactions SET status = 'paid', provider_ref_id = 'pi_test_123', processed_at = now()
    WHERE booking_id = '00000000-0000-0000-0000-0000000000b2';
INSERT INTO transactions (booking_id, amount)
    SELECT id, 50000 FROM bookings WHERE court_id = '00000000-0000-0000-0000-0000000000c2';
SELECT pg_temp.expect_error($$UPDATE transactions SET provider_ref_id = 'pi_test_123'
    WHERE booking_id <> '00000000-0000-0000-0000-0000000000b2'$$,
    '23505', 'provider_ref_id unique');

ROLLBACK;
\echo 'All schema tests passed.'
