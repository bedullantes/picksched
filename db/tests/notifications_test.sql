-- =============================================================================
-- Tests for migration 006: email/SMS notification channels, delivery tracking
-- and booking confirmation audit fields.
--   psql -v ON_ERROR_STOP=1 -d <db> -f db/tests/notifications_test.sql
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

-- Booking helper: player books hour h on court c1 (40000/hr) and returns the id.
CREATE FUNCTION pg_temp.book(p_player UUID, h INTEGER) RETURNS UUID AS $$
DECLARE
    v UUID;
BEGIN
    PERFORM pg_temp.act_as(p_player);
    INSERT INTO bookings (court_id, player_id, start_time, end_time)
    VALUES ('00000000-0000-0000-0000-0000000000c1', p_player, pg_temp.at(h), pg_temp.at(h + 1))
    RETURNING id INTO v;
    RETURN v;
END
$$ LANGUAGE plpgsql;
CREATE FUNCTION pg_temp.attach(p_booking UUID, p_intent TEXT) RETURNS void AS $$
    SELECT begin_payment(p_booking);
    SELECT attach_checkout_session(p_booking, 'cs_' || p_intent, p_intent, 'https://checkout.example/' || p_intent, '{}'::jsonb);
$$ LANGUAGE sql;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO picksched_app;


CREATE FUNCTION pg_temp.pay(p_booking UUID, p_intent TEXT) RETURNS void AS $$
    SELECT pg_temp.attach(p_booking, p_intent);
    SELECT pg_temp.act_as(NULL);
    SELECT apply_payment_result(p_intent, 'paid', 'pay_' || p_intent, 'gcash', NULL, 0);
$$ LANGUAGE sql;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO picksched_app;

-- Phone numbers
SELECT pg_temp.expect_error($$UPDATE users SET phone = '09171234567' WHERE email = 'player-b@example.com'$$,
    '23514', 'phone must be in E.164 format');
UPDATE users SET phone = '+639171234567' WHERE email = 'player-b@example.com';
UPDATE users SET phone = '+639181112222' WHERE email = 'owner-a@example.com';

SET LOCAL ROLE picksched_app;
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
UPDATE users SET phone = '+639990001111' WHERE id = app_current_user_id();
SELECT pg_temp.expect_value($$SELECT phone FROM users WHERE id = app_current_user_id()$$, '+639990001111', 'players can set their own phone');
UPDATE users SET phone = NULL WHERE id = app_current_user_id();

-- Confirmation queues email + SMS ---------------------------------------------------
SELECT pg_temp.book('00000000-0000-0000-0000-00000000000b', 9);
CREATE TEMP TABLE ids AS SELECT id AS b1 FROM bookings WHERE start_time = pg_temp.at(9);
GRANT SELECT ON ids TO picksched_app;
SELECT pg_temp.pay((SELECT b1 FROM ids), 'pi_n1');

RESET ROLE;
SELECT pg_temp.expect_value($$SELECT (confirmed_at IS NOT NULL)::text FROM bookings WHERE id = (SELECT b1 FROM ids)$$,
    'true', 'confirmed_at is recorded');
SELECT pg_temp.expect_value($$SELECT string_agg(kind || '/' || channel || ':' || status, ',' ORDER BY kind, channel) FROM notifications$$,
    'booking_confirmed/email:pending,booking_confirmed/sms:pending,booking_received/email:pending,booking_received/sms:pending',
    'player and owner each get email and SMS');
SET LOCAL ROLE picksched_app;

-- Player without a phone gets email only
SELECT pg_temp.book('00000000-0000-0000-0000-00000000000e', 11);
SELECT pg_temp.pay((SELECT id FROM bookings WHERE start_time = pg_temp.at(11)), 'pi_n2');
RESET ROLE;
SELECT pg_temp.expect_value($$SELECT string_agg(channel, ',' ORDER BY channel) FROM notifications n
    JOIN users u ON u.id = n.recipient_id WHERE u.email = 'player-e@example.com'$$,
    'email', 'player without a phone gets email only');
SET LOCAL ROLE picksched_app;

-- Claiming returns current booking details ------------------------------------------
SELECT pg_temp.act_as(NULL);
CREATE TEMP TABLE claimed AS SELECT * FROM claim_notifications(50);
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM claimed$$, '7', 'all due notifications are claimed');
SELECT pg_temp.expect_value($$SELECT DISTINCT court_name || ' ' || booking_status || ' ' || (start_time = pg_temp.at(9))::text
    FROM claimed WHERE booking_id = (SELECT b1 FROM ids)$$, 'A1 confirmed true', 'claim includes court, time and status');
SELECT pg_temp.expect_value($$SELECT recipient_phone FROM claimed WHERE kind = 'booking_confirmed' AND channel = 'sms'$$,
    '+639171234567', 'claim includes the phone number');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM claim_notifications(50)$$, '0', 'claimed rows are not claimed twice');

-- Results ----------------------------------------------------------------------------
SELECT mark_notification_sent(id, 'sendgrid', 'sg_1', recipient_email) FROM claimed
WHERE booking_id = (SELECT b1 FROM ids) AND kind = 'booking_confirmed' AND channel = 'email';
SELECT mark_notification_sent(id, 'twilio', 'SM1', recipient_phone) FROM claimed
WHERE booking_id = (SELECT b1 FROM ids) AND kind = 'booking_confirmed' AND channel = 'sms';
RESET ROLE;
SELECT pg_temp.expect_value($$SELECT (confirmation_email_sent_at IS NOT NULL AND confirmation_sms_sent_at IS NOT NULL)::text
    FROM bookings WHERE id = (SELECT b1 FROM ids)$$, 'true', 'booking records when the confirmation email and SMS went out');
SELECT pg_temp.expect_value($$SELECT string_agg(status || ' ' || provider || ' ' || provider_message_id || ' ' || recipient_address, ',' ORDER BY channel)
    FROM notifications WHERE kind = 'booking_confirmed' AND booking_id = (SELECT b1 FROM ids)$$,
    'sent sendgrid sg_1 player-b@example.com,sent twilio SM1 +639171234567', 'provider and message id are logged');
SET LOCAL ROLE picksched_app;

SELECT pg_temp.expect_value($$SELECT record_notification_delivery('twilio', 'SM1', 'delivered', NULL)::text$$, 'true', 'delivery receipt is recorded');
SELECT pg_temp.expect_value($$SELECT record_notification_delivery('twilio', 'SM1', 'queued', NULL)::text$$, 'false', 'interim statuses are ignored');
SELECT pg_temp.expect_value($$SELECT record_notification_delivery('twilio', 'SM_unknown', 'delivered', NULL)::text$$, 'false', 'unknown message ids are ignored');

-- Transient failure: retried after a backoff
SELECT pg_temp.expect_value($$SELECT mark_notification_failed(id, 'SendGrid 503', false) FROM claimed
    WHERE kind = 'booking_received' AND channel = 'email' AND booking_id = (SELECT b1 FROM ids)$$,
    'pending', 'a transient failure is retried');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM claim_notifications(50)$$, '0', 'not retried before the backoff');
RESET ROLE;
UPDATE notifications SET last_attempt_at = now() - interval '16 seconds' WHERE last_error = 'SendGrid 503';
SET LOCAL ROLE picksched_app;
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM claim_notifications(50)$$, '1', 'retried after 15 seconds');

-- Permanent failure
SELECT pg_temp.expect_value($$SELECT mark_notification_failed(id, 'Twilio 21211: invalid To number', true) FROM claimed
    WHERE kind = 'booking_received' AND channel = 'sms'$$, 'failed', 'a permanent error is not retried');

-- Too many attempts
RESET ROLE;
UPDATE notifications SET attempts = 6 WHERE kind = 'booking_received' AND channel = 'email' AND booking_id = (SELECT b1 FROM ids);
SET LOCAL ROLE picksched_app;
SELECT pg_temp.expect_value($$SELECT mark_notification_failed(id, 'SendGrid 503', false) FROM claimed
    WHERE kind = 'booking_received' AND channel = 'email' AND booking_id = (SELECT b1 FROM ids)$$,
    'failed', 'gives up after the last attempt');

SELECT mark_notification_skipped(id, 'booking is cancelled') FROM claimed WHERE booking_id <> (SELECT b1 FROM ids);
RESET ROLE;
SELECT pg_temp.expect_value($$SELECT string_agg(DISTINCT status, ',') FROM notifications WHERE booking_id <> (SELECT b1 FROM ids)$$,
    'skipped', 'skipped notifications are recorded');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM notifications WHERE status = 'failed' AND failed_at IS NOT NULL$$,
    '2', 'failures are timestamped');
SET LOCAL ROLE picksched_app;

-- Visibility
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
SELECT pg_temp.expect_value($$SELECT string_agg(channel, ',' ORDER BY channel) FROM notifications$$,
    'email,sms', 'players see only their own notifications');

ROLLBACK;
\echo 'All notifications tests passed.'
