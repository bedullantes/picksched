-- =============================================================================
-- Tests for migration 007: owner dashboard analytics (owner_daily_metrics).
--   psql -v ON_ERROR_STOP=1 -d <db> -f db/tests/dashboard_test.sql
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

CREATE FUNCTION pg_temp.metric(p_day DATE, col TEXT) RETURNS TEXT AS $$
DECLARE
    v TEXT;
BEGIN
    EXECUTE format('SELECT %I::text FROM owner_daily_metrics($1, $1)', col) INTO v USING p_day;
    RETURN v;
END
$$ LANGUAGE plpgsql;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO picksched_app;

-- Fixtures ----------------------------------------------------------------------------
-- Owner A: c1, c2 active (06:00-22:00 = 960 min/day each), c3 inactive. Owner D: c4.
INSERT INTO users (id, email, password_hash, role) VALUES
    ('00000000-0000-0000-0000-00000000000a', 'owner-a@example.com',  'x', 'admin'),
    ('00000000-0000-0000-0000-00000000000d', 'owner-d@example.com',  'x', 'admin'),
    ('00000000-0000-0000-0000-00000000000b', 'player-b@example.com', 'x', 'player');
INSERT INTO courts (id, owner_id, name, hourly_rate, is_active, created_at) VALUES
    ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a', 'A1', 40000, true,  now() - interval '10 days'),
    ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000000a', 'A2', 40000, true,  now() - interval '10 days'),
    ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-00000000000a', 'A3', 40000, false, now() - interval '10 days'),
    ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-00000000000d', 'D1', 40000, true,  now() - interval '10 days');

CREATE FUNCTION pg_temp.bk(p_id TEXT, p_court TEXT, h1 INTEGER, h2 INTEGER, p_status booking_status) RETURNS void AS $$
    INSERT INTO bookings (id, court_id, player_id, start_time, end_time, status, cancelled_at)
    VALUES (('00000000-0000-0000-0000-0000000000' || p_id)::uuid, ('00000000-0000-0000-0000-0000000000' || p_court)::uuid,
            '00000000-0000-0000-0000-00000000000b', pg_temp.at(h1), pg_temp.at(h2), p_status,
            CASE WHEN p_status = 'cancelled' THEN now() END);
$$ LANGUAGE sql;

-- Tomorrow on A's courts
SELECT pg_temp.bk('e1', 'c1', 9, 11, 'confirmed');        -- 120 min
SELECT pg_temp.bk('e2', 'c1', 13, 14, 'confirmed');       --  60 min
SELECT pg_temp.bk('e3', 'c1', 15, 16, 'pending_payment'); -- not counted (unpaid)
SELECT pg_temp.bk('e4', 'c1', 17, 18, 'cancelled');       -- not counted
SELECT pg_temp.bk('e5', 'c2', 9, 10, 'confirmed');        --  60 min
INSERT INTO court_blocks (court_id, start_time, end_time) VALUES
    ('00000000-0000-0000-0000-0000000000c2', pg_temp.at(12), pg_temp.at(14));  -- 120 min out of service
-- Tomorrow on D's court: must not appear in A's numbers
SELECT pg_temp.bk('f1', 'c4', 9, 12, 'confirmed');

-- Payments: two paid for A, one refunded, one failed, one paid for D
INSERT INTO transactions (booking_id, amount, status, provider_ref_id, processed_at, provider_fee) VALUES
    ('00000000-0000-0000-0000-0000000000e1', 0, 'paid',     'pi_e1', now(), 2000),
    ('00000000-0000-0000-0000-0000000000e2', 0, 'paid',     'pi_e2', now(), 1000),
    ('00000000-0000-0000-0000-0000000000e5', 0, 'refunded', 'pi_e5', now(), NULL),
    ('00000000-0000-0000-0000-0000000000e3', 0, 'failed',   'pi_e3', now(), NULL),
    ('00000000-0000-0000-0000-0000000000f1', 0, 'paid',     'pi_f1', now(), 3000);

SET LOCAL ROLE picksched_app;

-- Access ------------------------------------------------------------------------------
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
SELECT pg_temp.expect_error($$SELECT * FROM owner_daily_metrics(pg_temp.d(), pg_temp.d())$$, '42501', 'players cannot view analytics');
SELECT pg_temp.act_as(NULL);
SELECT pg_temp.expect_error($$SELECT * FROM owner_daily_metrics(pg_temp.d(), pg_temp.d())$$, '42501', 'anonymous callers cannot view analytics');

SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
SELECT pg_temp.expect_error($$SELECT * FROM owner_daily_metrics(pg_temp.d(), pg_temp.d() - 1)$$, '22023', 'end before start is rejected');
SELECT pg_temp.expect_error($$SELECT * FROM owner_daily_metrics(pg_temp.d() - 400, pg_temp.d())$$, '22023', 'range is limited to about a year');
SELECT pg_temp.expect_value($$SELECT owner_timezone()$$, 'Asia/Manila', 'dashboard uses the courts'' time zone');

-- Occupancy -------------------------------------------------------------------------
SELECT pg_temp.expect_value($$SELECT pg_temp.metric(pg_temp.d(), 'active_courts')$$, '2', 'counts the owner''s active courts');
SELECT pg_temp.expect_value($$SELECT pg_temp.metric(pg_temp.d(), 'available_minutes')$$, '1800',
    'available = 2 courts x 960 min - 120 min maintenance');
SELECT pg_temp.expect_value($$SELECT pg_temp.metric(pg_temp.d(), 'booked_minutes')$$, '240',
    'booked = confirmed bookings only (120 + 60 + 60)');
SELECT pg_temp.expect_value($$SELECT pg_temp.metric(pg_temp.d(), 'bookings')$$, '3', 'confirmed bookings that day');
SELECT pg_temp.expect_value($$SELECT sum(bookings)::text FROM owner_daily_metrics(pg_temp.d() - 1, pg_temp.d() + 5)$$,
    '3', 'bookings summed over a week');
SELECT pg_temp.expect_value($$SELECT pg_temp.metric(pg_temp.d() + 1, 'booked_minutes') || '/' || pg_temp.metric(pg_temp.d() + 1, 'available_minutes')$$,
    '0/1920', 'a quiet day has full availability and no bookings');

-- Revenue ------------------------------------------------------------------------------
SELECT pg_temp.expect_value($$SELECT concat_ws(' ', sum(payments), sum(gross), sum(provider_fees), sum(platform_fees), sum(owner_net))
    FROM owner_daily_metrics(pg_temp.d() - 3, pg_temp.d())$$,
    '2 120000 3000 6000 111000', 'revenue counts paid transactions only (80000 + 40000, 5% commission)');
SELECT pg_temp.expect_value($$SELECT sum(gross)::text FROM owner_daily_metrics(pg_temp.d() + 1, pg_temp.d() + 3)$$,
    '0', 'revenue falls on the day the payment was processed');

-- Owner isolation ----------------------------------------------------------------------
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
SELECT pg_temp.expect_value($$SELECT concat_ws(' ', active_courts, available_minutes, booked_minutes, bookings)
    FROM owner_daily_metrics(pg_temp.d(), pg_temp.d())$$, '1 960 180 1', 'another owner sees only their own court');
SELECT pg_temp.expect_value($$SELECT sum(gross)::text FROM owner_daily_metrics(pg_temp.d() - 3, pg_temp.d())$$,
    '120000', 'another owner sees only their own revenue (3h x 40000)');

-- Courts added recently don't count for days before they existed
RESET ROLE;
UPDATE courts SET created_at = now() WHERE id = '00000000-0000-0000-0000-0000000000c2';
SET LOCAL ROLE picksched_app;
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
SELECT pg_temp.expect_value($$SELECT pg_temp.metric(pg_temp.d() - 3, 'available_minutes')$$, '960',
    'a court added today adds no capacity to earlier days');

ROLLBACK;
\echo 'All dashboard tests passed.'
