-- =============================================================================
-- Tests for migration 005: PayMongo payments (payment fields, transaction
-- logging, commission, webhook event log, refunds, notifications).
--   psql -v ON_ERROR_STOP=1 -d <db> -f db/tests/payments_test.sql
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

SET LOCAL ROLE picksched_app;

SELECT pg_temp.expect_value($$SELECT booking_hold_interval()::text$$, '00:15:00', 'bookings expire after 15 minutes unpaid');

-- Starting a payment -------------------------------------------------------------
SELECT pg_temp.book('00000000-0000-0000-0000-00000000000b', 9);
CREATE TEMP TABLE ids AS SELECT id AS b1 FROM bookings WHERE start_time = pg_temp.at(9);
GRANT SELECT ON ids TO picksched_app;

SELECT pg_temp.expect_value($$SELECT payment_status::text FROM bookings WHERE id = (SELECT b1 FROM ids)$$,
    'unpaid', 'new booking is unpaid');

SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
SELECT pg_temp.expect_error($$SELECT begin_payment((SELECT b1 FROM ids))$$, 'P0002', 'another player cannot pay for the booking');
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
SELECT pg_temp.expect_error($$SELECT begin_payment((SELECT b1 FROM ids))$$, '42501', 'court owner cannot start payment for a player''s booking');
SELECT pg_temp.expect_error($$SELECT confirm_booking((SELECT b1 FROM ids))$$, '55006', 'court owner cannot bypass payment');

-- An owner who reserves for themselves still can't pay (only players can)
INSERT INTO bookings (id, court_id, player_id, start_time, end_time) VALUES
    ('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-0000000000c1',
     '00000000-0000-0000-0000-00000000000a', pg_temp.at(20), pg_temp.at(21));
SELECT pg_temp.expect_error($$SELECT begin_payment('00000000-0000-0000-0000-0000000000a9')$$,
    '42501', 'admins cannot initiate payments');

SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
SELECT pg_temp.expect_value($$SELECT amount::text || ' ' || status::text FROM begin_payment((SELECT b1 FROM ids))$$,
    '40000 pending', 'begin_payment creates the transaction for the booking total');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM (SELECT begin_payment((SELECT b1 FROM ids))) x$$,
    '1', 'begin_payment is repeatable');
SELECT pg_temp.attach((SELECT b1 FROM ids), 'pi_1');
SELECT pg_temp.expect_value($$SELECT payment_status::text || ' ' || payment_intent_id FROM bookings WHERE id = (SELECT b1 FROM ids)$$,
    'processing pi_1', 'booking records the payment intent and is processing');
SELECT pg_temp.expect_value($$SELECT checkout_session_id || ' ' || provider_ref_id || ' ' || checkout_url FROM transactions$$,
    'cs_pi_1 pi_1 https://checkout.example/pi_1', 'transaction records the checkout session');

-- Failed attempt ------------------------------------------------------------------
SELECT pg_temp.act_as(NULL);
SELECT pg_temp.expect_value($$SELECT booking_status::text || ' ' || transaction_status::text
    FROM apply_payment_result('pi_1', 'failed', 'pay_f1', 'gcash', p_failure_code => 'insufficient_funds', p_failure_msg => 'Not enough balance')$$,
    'pending_payment failed', 'failed payment leaves the booking pending_payment');
RESET ROLE;
SELECT pg_temp.expect_value($$SELECT payment_status::text FROM bookings WHERE id = (SELECT b1 FROM ids)$$,
    'failed', 'booking payment_status is failed');
SELECT pg_temp.expect_value($$SELECT failure_code || ' / ' || failure_message FROM transactions WHERE provider_ref_id = 'pi_1'$$,
    'insufficient_funds / Not enough balance', 'failure details are logged');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM notifications$$, '0', 'no notifications for a failed payment');
SET LOCAL ROLE picksched_app;

-- Successful retry ------------------------------------------------------------------
SELECT pg_temp.expect_value($$SELECT booking_status::text || ' ' || refund_needed::text
    FROM apply_payment_result('pi_1', 'paid', 'pay_ok1', 'gcash', 40000, 1000, p_payload => '{"id":"pay_ok1"}')$$,
    'confirmed false', 'successful payment confirms the booking');
RESET ROLE;
SELECT pg_temp.expect_value($$SELECT concat_ws(' ', status, payment_id, payment_method, provider_fee, commission_rate_bps, platform_fee, owner_net,
    coalesce(failure_code, '-'), provider_payload->>'id') FROM transactions WHERE provider_ref_id = 'pi_1'$$,
    'paid pay_ok1 gcash 1000 500 2000 37000 - pay_ok1', 'transaction logs payment, method, fees and 5% commission');
SELECT pg_temp.expect_value($$SELECT payment_status::text FROM bookings WHERE payment_intent_id = 'pi_1'$$, 'paid', 'booking payment_status is paid');
SELECT pg_temp.expect_value($$SELECT string_agg(kind || ':' || u.email, ',' ORDER BY kind) FROM notifications n JOIN users u ON u.id = n.recipient_id$$,
    'booking_confirmed:player-b@example.com,booking_received:owner-a@example.com', 'confirmation notifies player and owner');
SET LOCAL ROLE picksched_app;

SELECT pg_temp.expect_value($$SELECT booking_status::text FROM apply_payment_result('pi_1', 'paid', 'pay_ok1', 'gcash', 40000, 1000)$$,
    'confirmed', 'duplicate paid event is harmless');
SELECT pg_temp.expect_value($$SELECT transaction_status::text FROM apply_payment_result('pi_1', 'failed', 'pay_late', 'gcash')$$,
    'paid', 'a failure reported after success is ignored');
RESET ROLE;
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM notifications$$, '2', 'notifications are not duplicated');
SET LOCAL ROLE picksched_app;
SELECT pg_temp.expect_error($$SELECT record_payment_result('pi_1', 'failed')$$, '23514', 'record_payment_result stays strict');
SELECT pg_temp.expect_error($$SELECT apply_payment_result('pi_unknown', 'paid')$$, 'P0002', 'unknown payment intent rejected');

-- Notifications outbox ------------------------------------------------------------
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
SELECT pg_temp.expect_value($$SELECT string_agg(kind, ',') FROM notifications$$, 'booking_confirmed', 'player sees only their own notifications');
SELECT pg_temp.act_as(NULL);
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM claim_notifications(10)$$, '2', 'dispatcher claims unsent notifications');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM claim_notifications(10)$$, '0', 'claimed notifications back off before retry');
RESET ROLE;
SELECT mark_notification_result(id, NULL) FROM notifications;
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM notifications WHERE sent_at IS NOT NULL$$, '2', 'sent notifications are marked');
SET LOCAL ROLE picksched_app;

-- Amount mismatch -------------------------------------------------------------------
SELECT pg_temp.book('00000000-0000-0000-0000-00000000000e', 11);
SELECT pg_temp.attach((SELECT id FROM bookings WHERE start_time = pg_temp.at(11)), 'pi_2');
SELECT pg_temp.act_as(NULL);
SELECT pg_temp.expect_value($$SELECT booking_status::text || ' ' || refund_needed::text
    FROM apply_payment_result('pi_2', 'paid', 'pay_2', 'paymaya', 100, 10)$$,
    'pending_payment true', 'a payment for the wrong amount does not confirm and is refunded');

-- Late payment after the hold expired -------------------------------------------------
SELECT pg_temp.book('00000000-0000-0000-0000-00000000000e', 13);
SELECT pg_temp.attach((SELECT id FROM bookings WHERE start_time = pg_temp.at(13)), 'pi_3');
RESET ROLE;
UPDATE bookings SET expires_at = now() - interval '1 second' WHERE payment_intent_id = 'pi_3';
SET LOCAL ROLE picksched_app;
SELECT pg_temp.act_as(NULL);
SELECT expire_stale_bookings();
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
SELECT pg_temp.expect_value($$SELECT status::text || ' ' || payment_status::text FROM bookings WHERE payment_intent_id = 'pi_3'$$,
    'cancelled expired', 'unpaid booking expires and is never confirmed');
SELECT pg_temp.act_as(NULL);
SELECT pg_temp.expect_value($$SELECT string_agg(checkout_session_id, ',') FROM checkout_sessions_to_expire()$$,
    'cs_pi_3', 'its PayMongo checkout session is queued for expiry');
SELECT pg_temp.expect_value($$SELECT booking_status::text || ' ' || refund_needed::text
    FROM apply_payment_result('pi_3', 'paid', 'pay_3', 'paymaya', 40000, 1000)$$,
    'cancelled true', 'payment arriving after expiry does not confirm and needs a refund');
SELECT pg_temp.expect_value($$SELECT string_agg(payment_intent_id, ',' ORDER BY payment_intent_id) FROM refunds_due()$$,
    'pi_2,pi_3', 'refunds_due lists late and mismatched payments');
SELECT mark_refunded('pi_3', 'ref_3', '{"id":"ref_3"}');
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
SELECT pg_temp.expect_value($$SELECT status::text || ' ' || payment_status::text FROM bookings WHERE payment_intent_id = 'pi_3'$$,
    'cancelled refunded', 'refunded booking stays cancelled');
SELECT pg_temp.act_as(NULL);
RESET ROLE;
SELECT pg_temp.expect_value($$SELECT status::text || ' ' || refund_id FROM transactions WHERE provider_ref_id = 'pi_3'$$,
    'refunded ref_3', 'refund is logged on the transaction');
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM notifications WHERE kind = 'payment_refunded'$$,
    '1', 'player is notified of the refund');
SET LOCAL ROLE picksched_app;
SELECT pg_temp.expect_value($$SELECT string_agg(payment_intent_id, ',') FROM refunds_due()$$, 'pi_2', 'refunded payment leaves the queue');

-- Expired checkout sessions
SELECT pg_temp.book('00000000-0000-0000-0000-00000000000e', 15);
SELECT pg_temp.attach((SELECT id FROM bookings WHERE start_time = pg_temp.at(15)), 'pi_4');
RESET ROLE;
UPDATE bookings SET expires_at = now() - interval '1 second' WHERE payment_intent_id = 'pi_4';
SET LOCAL ROLE picksched_app;
SELECT pg_temp.act_as(NULL);
SELECT expire_stale_bookings();
SELECT mark_checkout_expired(transaction_id) FROM checkout_sessions_to_expire() WHERE checkout_session_id = 'cs_pi_4';
SELECT pg_temp.expect_value($$SELECT count(*)::text FROM checkout_sessions_to_expire() WHERE checkout_session_id = 'cs_pi_4'$$,
    '0', 'expired checkout session is marked');

-- Webhook event log ---------------------------------------------------------------------
SELECT pg_temp.expect_value($$SELECT record_payment_event('evt_1', 'payment.paid', false, '{}')::text$$, 'true', 'webhook event is logged');
SELECT pg_temp.expect_value($$SELECT record_payment_event('evt_1', 'payment.paid', false, '{}')::text$$, 'false', 'a redelivered event is detected');
SELECT pg_temp.expect_error($$SELECT count(*) FROM payment_events$$, '42501', 'the app role cannot read the event log directly');

ROLLBACK;
\echo 'All payments tests passed.'
