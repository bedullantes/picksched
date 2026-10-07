-- =============================================================================
-- PickSched — Migration 005: PayMongo payments (GCash / Maya)
-- Depends on: 001–004
-- =============================================================================
--
-- 1. The checkout hold is 15 minutes (booking_hold_interval()), the time a
--    player has to pay through PayMongo before the slot is released.
-- 2. bookings gains payment_intent_id and payment_status.
-- 3. transactions logs what PayMongo returns: checkout session, payment id,
--    method (gcash / paymaya), PayMongo's fee, the platform commission and
--    the owner's net, failure details and the raw PayMongo object.
-- 4. payment_events: an append-only log of every verified webhook event,
--    which also deduplicates PayMongo's retries.
-- 5. Platform commission (platform_commission_bps()) is calculated by a
--    trigger when a transaction becomes paid, and stored with the rate used.
-- 6. notifications: an outbox. Confirming a booking queues messages for the
--    player and the court owner; the API dispatches them.
-- 7. Only players can start a payment; owners can't confirm unpaid bookings
--    (migration 004), so a booking is confirmed only by a successful payment.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION booking_hold_interval() RETURNS INTERVAL
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '15 minutes' $$;

-- Platform commission in basis points (500 = 5%). Change it by replacing this
-- function; each transaction stores the rate it was charged at.
CREATE FUNCTION platform_commission_bps() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$ SELECT 500 $$;

-- -----------------------------------------------------------------------------
-- bookings: payment fields
-- -----------------------------------------------------------------------------
--   unpaid      no payment started
--   processing  PayMongo checkout opened, waiting for the result
--   paid        payment succeeded
--   failed      last payment attempt failed (the player can retry until expires_at)
--   expired     the hold ran out before a successful payment
--   refunded    the payment was refunded
CREATE TYPE booking_payment_status AS ENUM ('unpaid', 'processing', 'paid', 'failed', 'expired', 'refunded');

ALTER TABLE bookings
    ADD COLUMN payment_intent_id TEXT,
    ADD COLUMN payment_status booking_payment_status NOT NULL DEFAULT 'unpaid';

CREATE UNIQUE INDEX bookings_payment_intent_key ON bookings (payment_intent_id) WHERE payment_intent_id IS NOT NULL;

UPDATE bookings b
SET payment_status = CASE t.status WHEN 'paid' THEN 'paid' WHEN 'refunded' THEN 'refunded'
                                   WHEN 'failed' THEN 'failed' ELSE 'processing' END::booking_payment_status,
    payment_intent_id = t.provider_ref_id
FROM transactions t
WHERE t.booking_id = b.id;

-- A booking cancelled because its hold ran out shows payment_status 'expired'.
CREATE FUNCTION bookings_mark_payment_expired() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'cancelled' AND OLD.status = 'pending_payment'
       AND OLD.expires_at <= now()
       AND NEW.payment_status IN ('unpaid', 'processing', 'failed') THEN
        NEW.payment_status := 'expired';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER bookings_mark_payment_expired
    BEFORE UPDATE OF status ON bookings
    FOR EACH ROW EXECUTE FUNCTION bookings_mark_payment_expired();

-- -----------------------------------------------------------------------------
-- transactions: PayMongo details and fees
-- -----------------------------------------------------------------------------
ALTER TABLE transactions
    ADD COLUMN provider            TEXT    NOT NULL DEFAULT 'paymongo',
    ADD COLUMN checkout_session_id TEXT,
    ADD COLUMN checkout_url        TEXT,
    ADD COLUMN payment_id          TEXT,      -- PayMongo payment ("pay_...") that succeeded or failed last
    ADD COLUMN payment_method      TEXT,      -- 'gcash' | 'paymaya'
    ADD COLUMN provider_fee        BIGINT,    -- PayMongo's fee, centavos
    ADD COLUMN commission_rate_bps INTEGER,   -- platform commission rate applied
    ADD COLUMN platform_fee        BIGINT,    -- platform commission, centavos
    ADD COLUMN owner_net           BIGINT,    -- amount - provider_fee - platform_fee
    ADD COLUMN failure_code        TEXT,
    ADD COLUMN failure_message     TEXT,
    ADD COLUMN refund_id           TEXT,
    ADD COLUMN provider_payload    JSONB,     -- latest PayMongo object for this payment
    ADD CONSTRAINT transactions_checkout_session_key UNIQUE (checkout_session_id),
    ADD CONSTRAINT transactions_payment_method_chk CHECK (payment_method IN ('gcash', 'paymaya')),
    ADD CONSTRAINT transactions_fees_chk CHECK (
        status NOT IN ('paid', 'refunded')
        OR (commission_rate_bps IS NOT NULL AND platform_fee IS NOT NULL AND owner_net IS NOT NULL)
    );

-- Earlier migrations didn't record fees. Backfill settled rows so the new check holds.
UPDATE transactions
SET commission_rate_bps = platform_commission_bps(),
    platform_fee = round(amount * platform_commission_bps() / 10000.0),
    owner_net = amount - round(amount * platform_commission_bps() / 10000.0)
WHERE status IN ('paid', 'refunded') AND platform_fee IS NULL;

-- Commission is calculated when a transaction becomes paid, whatever path
-- records the payment, using the rate in effect at that moment.
--   owner_net = amount - PayMongo fee - platform commission
CREATE FUNCTION transactions_compute_fees() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'paid' AND NEW.platform_fee IS NULL THEN
        NEW.commission_rate_bps := platform_commission_bps();
        NEW.platform_fee := round(NEW.amount * NEW.commission_rate_bps / 10000.0);
        NEW.owner_net := NEW.amount - NEW.platform_fee - COALESCE(NEW.provider_fee, 0);
    ELSIF NEW.status = 'refunded' AND NEW.platform_fee IS NULL THEN
        -- refunded without a recorded payment: nothing earned
        NEW.commission_rate_bps := 0;
        NEW.platform_fee := 0;
        NEW.owner_net := 0;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER transactions_compute_fees
    BEFORE INSERT OR UPDATE OF status ON transactions
    FOR EACH ROW EXECUTE FUNCTION transactions_compute_fees();

-- -----------------------------------------------------------------------------
-- payment_events: every verified PayMongo webhook, deduplicated by event id
-- -----------------------------------------------------------------------------
CREATE TABLE payment_events (
    id             TEXT        PRIMARY KEY,   -- PayMongo event id ("evt_...")
    type           TEXT        NOT NULL,
    livemode       BOOLEAN     NOT NULL,
    transaction_id UUID        REFERENCES transactions (id) ON DELETE RESTRICT,
    payload        JSONB       NOT NULL,
    received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at   TIMESTAMPTZ,
    result         TEXT
);
CREATE INDEX payment_events_transaction_idx ON payment_events (transaction_id);
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;  -- only reachable through the functions below

-- -----------------------------------------------------------------------------
-- notifications: outbox
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind            TEXT        NOT NULL,  -- booking_confirmed | booking_received | payment_refunded
    booking_id      UUID        REFERENCES bookings (id) ON DELETE CASCADE,
    payload         JSONB       NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at         TIMESTAMPTZ,
    attempts        INTEGER     NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    last_error      TEXT,
    CONSTRAINT notifications_once UNIQUE (kind, booking_id, recipient_id)
);
CREATE INDEX notifications_unsent_idx ON notifications (created_at) WHERE sent_at IS NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_own ON notifications FOR SELECT TO picksched_app
    USING (recipient_id = app_current_user_id());
GRANT SELECT ON notifications TO picksched_app;

CREATE FUNCTION enqueue_booking_notifications(p_booking_id UUID, p_kind TEXT) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v RECORD;
BEGIN
    SELECT b.id, b.player_id, b.start_time, b.end_time, b.total_amount, b.currency,
           c.id AS court_id, c.name AS court_name, c.owner_id, c.timezone
    INTO v
    FROM bookings b JOIN courts c ON c.id = b.court_id
    WHERE b.id = p_booking_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF p_kind = 'booking_confirmed' THEN
        INSERT INTO notifications (recipient_id, kind, booking_id, payload) VALUES
            (v.player_id, 'booking_confirmed', v.id, to_jsonb(v)),
            (v.owner_id,  'booking_received',  v.id, to_jsonb(v))
        ON CONFLICT ON CONSTRAINT notifications_once DO NOTHING;
    ELSE
        INSERT INTO notifications (recipient_id, kind, booking_id, payload)
        VALUES (v.player_id, p_kind, v.id, to_jsonb(v))
        ON CONFLICT ON CONSTRAINT notifications_once DO NOTHING;
    END IF;
END
$$;

-- Any transition to confirmed queues the confirmation messages.
CREATE FUNCTION bookings_notify_confirmed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed' THEN
        PERFORM enqueue_booking_notifications(NEW.id, 'booking_confirmed');
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER bookings_notify_confirmed
    AFTER UPDATE OF status ON bookings
    FOR EACH ROW EXECUTE FUNCTION bookings_notify_confirmed();

-- Claims up to p_limit unsent notifications for delivery (safe with several
-- dispatchers: rows are locked and skipped). Failed sends are retried with
-- backoff, up to 5 attempts.
CREATE FUNCTION claim_notifications(p_limit INTEGER)
RETURNS TABLE (id UUID, kind TEXT, recipient_email TEXT, recipient_role user_role, payload JSONB, attempts INTEGER)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE notifications n
    SET attempts = n.attempts + 1, last_attempt_at = now()
    FROM users u
    WHERE u.id = n.recipient_id
      AND n.id IN (
        SELECT id FROM notifications
        WHERE sent_at IS NULL
          AND attempts < 5
          AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(secs => 30 * power(2, attempts)))
        ORDER BY created_at
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
      )
    RETURNING n.id, n.kind, u.email, u.role, n.payload, n.attempts
$$;

CREATE FUNCTION mark_notification_result(p_id UUID, p_error TEXT) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE notifications
    SET sent_at = CASE WHEN p_error IS NULL THEN now() END,
        last_error = p_error
    WHERE id = p_id
$$;

-- -----------------------------------------------------------------------------
-- Starting a payment (player only)
-- -----------------------------------------------------------------------------
-- Locks and returns the booking's transaction, creating it if needed. Call it,
-- create the PayMongo checkout session if the row has none, then call
-- attach_checkout_session() in the same database transaction. The row lock
-- stops a double click from opening two checkout sessions.
CREATE FUNCTION begin_payment(p_booking_id UUID) RETURNS transactions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    b bookings;
    t transactions;
BEGIN
    SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
    IF NOT FOUND OR NOT app_can_view_booking(p_booking_id) THEN
        RAISE EXCEPTION 'booking % not found', p_booking_id USING ERRCODE = 'no_data_found';
    END IF;
    IF b.player_id IS DISTINCT FROM app_current_user_id()
       OR NOT EXISTS (SELECT 1 FROM users WHERE id = app_current_user_id() AND role = 'player') THEN
        RAISE EXCEPTION 'only the player who made this booking can pay for it'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF b.status <> 'pending_payment' THEN
        RAISE EXCEPTION 'booking % is %', p_booking_id, b.status USING ERRCODE = 'check_violation';
    END IF;
    IF b.expires_at <= now() THEN
        RAISE EXCEPTION 'the hold on booking % has expired', p_booking_id USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO transactions (booking_id, amount) VALUES (b.id, b.total_amount)
    ON CONFLICT (booking_id) DO NOTHING;
    SELECT * INTO t FROM transactions WHERE booking_id = b.id FOR UPDATE;
    RETURN t;
END
$$;

CREATE FUNCTION attach_checkout_session(
    p_booking_id UUID, p_checkout_session_id TEXT, p_payment_intent_id TEXT, p_checkout_url TEXT, p_payload JSONB
) RETURNS transactions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    t transactions;
BEGIN
    PERFORM begin_payment(p_booking_id);  -- same checks and lock
    UPDATE transactions
    SET checkout_session_id = p_checkout_session_id,
        provider_ref_id = p_payment_intent_id,
        checkout_url = p_checkout_url,
        provider_payload = p_payload,
        status = 'pending', processed_at = NULL, failure_code = NULL, failure_message = NULL
    WHERE booking_id = p_booking_id
    RETURNING * INTO t;
    UPDATE bookings SET payment_intent_id = p_payment_intent_id, payment_status = 'processing'
    WHERE id = p_booking_id;
    RETURN t;
END
$$;

-- -----------------------------------------------------------------------------
-- Applying payment results
-- -----------------------------------------------------------------------------
-- Applies a payment result for the PayMongo payment intent p_intent_id.
--   paid      transaction paid, fees and commission calculated; a
--             pending_payment booking becomes confirmed. If the booking was
--             already cancelled (hold expired first), refund_needed is true.
--             If the amount doesn't match, the booking isn't confirmed and
--             refund_needed is true.
--   failed    transaction failed; the booking stays pending_payment so the
--             player can retry until the hold expires.
--   refunded  transaction refunded; booking cancelled.
-- Repeating a result is a no-op. With p_strict (record_payment_result), an
-- impossible change raises 23514; webhooks pass false and ignore
-- out-of-order events (e.g. a failed attempt reported after a success).
CREATE FUNCTION apply_payment_result(
    p_intent_id      TEXT,
    p_status         transaction_status,
    p_payment_id     TEXT    DEFAULT NULL,
    p_payment_method TEXT    DEFAULT NULL,
    p_amount         BIGINT  DEFAULT NULL,
    p_provider_fee   BIGINT  DEFAULT NULL,
    p_failure_code   TEXT    DEFAULT NULL,
    p_failure_msg    TEXT    DEFAULT NULL,
    p_payload        JSONB   DEFAULT NULL,
    p_strict         BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    transaction_id     UUID,
    booking_id         UUID,
    booking_status     booking_status,
    transaction_status transaction_status,
    refund_needed      BOOLEAN,
    payment_id         TEXT,
    amount             BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
    t transactions;
    b bookings;
    v_wrong_amount BOOLEAN := FALSE;
BEGIN
    IF p_status = 'pending' THEN
        RAISE EXCEPTION 'a payment result cannot be pending' USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO t FROM transactions WHERE provider_ref_id = p_intent_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'transaction % not found', p_intent_id USING ERRCODE = 'no_data_found';
    END IF;
    SELECT * INTO b FROM bookings WHERE id = t.booking_id FOR UPDATE;

    IF t.status = 'refunded' AND p_status <> 'refunded' THEN
        IF p_strict THEN
            RAISE EXCEPTION 'transaction % is refunded', p_intent_id USING ERRCODE = 'check_violation';
        END IF;
    ELSIF t.status = 'paid' AND p_status NOT IN ('paid', 'refunded') THEN
        IF p_strict THEN
            RAISE EXCEPTION 'transaction % is paid', p_intent_id USING ERRCODE = 'check_violation';
        END IF;
    ELSIF t.status = p_status THEN
        NULL;  -- duplicate
    ELSIF p_status = 'paid' THEN
        v_wrong_amount := p_amount IS NOT NULL AND p_amount <> t.amount;
        UPDATE transactions
        SET status = 'paid', processed_at = now(),
            payment_id = COALESCE(p_payment_id, payment_id),
            payment_method = COALESCE(p_payment_method, payment_method),
            provider_fee = p_provider_fee,
            -- recalculated by transactions_compute_fees with this payment's fee
            commission_rate_bps = NULL, platform_fee = NULL, owner_net = NULL,
            failure_code = CASE WHEN v_wrong_amount THEN 'amount_mismatch' END,
            failure_message = CASE WHEN v_wrong_amount
                THEN format('paid %s, expected %s', p_amount, t.amount) END,
            provider_payload = COALESCE(p_payload, provider_payload)
        WHERE id = t.id;
        UPDATE bookings SET payment_status = 'paid' WHERE id = b.id;
        IF b.status = 'pending_payment' AND NOT v_wrong_amount THEN
            UPDATE bookings SET status = 'confirmed' WHERE id = b.id;
        END IF;
    ELSIF p_status = 'failed' THEN
        UPDATE transactions
        SET status = 'failed', processed_at = now(),
            payment_id = COALESCE(p_payment_id, payment_id),
            payment_method = COALESCE(p_payment_method, payment_method),
            failure_code = p_failure_code, failure_message = p_failure_msg,
            provider_payload = COALESCE(p_payload, provider_payload)
        WHERE id = t.id;
        IF b.payment_status IN ('unpaid', 'processing', 'failed') THEN
            UPDATE bookings SET payment_status = (CASE WHEN b.status = 'cancelled' THEN 'expired' ELSE 'failed' END)::booking_payment_status
            WHERE id = b.id;
        END IF;
    ELSIF p_status = 'processing' THEN
        UPDATE transactions SET status = 'processing', processed_at = NULL,
            provider_payload = COALESCE(p_payload, provider_payload)
        WHERE id = t.id;
    ELSIF p_status = 'refunded' THEN
        UPDATE transactions SET status = 'refunded', processed_at = now(),
            provider_payload = COALESCE(p_payload, provider_payload)
        WHERE id = t.id;
        UPDATE bookings SET payment_status = 'refunded' WHERE id = b.id;
        IF b.status <> 'cancelled' THEN
            UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = b.id;
        END IF;
    END IF;

    RETURN QUERY
    SELECT tx.id, bk.id, bk.status, tx.status,
           (tx.status = 'paid' AND tx.refund_id IS NULL
            AND (bk.status = 'cancelled' OR tx.failure_code IS NOT DISTINCT FROM 'amount_mismatch')),
           tx.payment_id, tx.amount
    FROM transactions tx JOIN bookings bk ON bk.id = tx.booking_id
    WHERE tx.id = t.id;
END
$$;

-- Kept for existing callers (migration 002); now also records fees.
CREATE OR REPLACE FUNCTION record_payment_result(p_provider_ref_id TEXT, p_status transaction_status)
RETURNS booking_status
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT booking_status FROM apply_payment_result(p_provider_ref_id, p_status, p_strict => TRUE)
$$;

-- Records that a refund was issued for a payment that can't be honored.
CREATE FUNCTION mark_refunded(p_intent_id TEXT, p_refund_id TEXT, p_payload JSONB) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_booking UUID;
BEGIN
    UPDATE transactions SET refund_id = p_refund_id WHERE provider_ref_id = p_intent_id;
    SELECT r.booking_id INTO v_booking FROM apply_payment_result(p_intent_id, 'refunded', p_payload => p_payload) r;
    PERFORM enqueue_booking_notifications(v_booking, 'payment_refunded');
END
$$;

-- Payments that must be refunded: paid after the booking was already
-- cancelled (late payment on an expired hold), or for the wrong amount.
-- Bookings an owner cancels after payment are not included; refunding those
-- is a business decision.
CREATE FUNCTION refunds_due()
RETURNS TABLE (payment_intent_id TEXT, payment_id TEXT, amount BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT t.provider_ref_id, t.payment_id, t.amount
    FROM transactions t JOIN bookings b ON b.id = t.booking_id
    WHERE t.status = 'paid' AND t.refund_id IS NULL AND t.payment_id IS NOT NULL
      AND ((b.status = 'cancelled' AND b.cancelled_at <= t.processed_at) OR t.failure_code = 'amount_mismatch')
$$;

-- Open PayMongo checkout sessions whose booking was released: expire them at
-- PayMongo so the player can't pay for a slot they no longer hold.
CREATE FUNCTION checkout_sessions_to_expire()
RETURNS TABLE (transaction_id UUID, checkout_session_id TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT t.id, t.checkout_session_id
    FROM transactions t JOIN bookings b ON b.id = t.booking_id
    WHERE b.status = 'cancelled' AND t.checkout_session_id IS NOT NULL
      AND t.status IN ('pending', 'processing', 'failed')
      AND t.failure_code IS DISTINCT FROM 'checkout_expired'
$$;

CREATE FUNCTION mark_checkout_expired(p_transaction_id UUID) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE transactions
    SET status = 'failed', processed_at = now(),
        failure_code = 'checkout_expired', failure_message = 'The booking hold expired before payment.'
    WHERE id = p_transaction_id AND status IN ('pending', 'processing', 'failed')
$$;

-- Webhook log. Returns false if the event was already received (PayMongo retry).
CREATE FUNCTION record_payment_event(p_id TEXT, p_type TEXT, p_livemode BOOLEAN, p_payload JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    INSERT INTO payment_events (id, type, livemode, payload) VALUES (p_id, p_type, p_livemode, p_payload);
    RETURN TRUE;
EXCEPTION WHEN unique_violation THEN
    RETURN FALSE;
END
$$;

CREATE FUNCTION finish_payment_event(p_id TEXT, p_transaction_id UUID, p_result TEXT) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE payment_events
    SET transaction_id = p_transaction_id, result = p_result, processed_at = now()
    WHERE id = p_id
$$;

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
    enqueue_booking_notifications(UUID, TEXT), claim_notifications(INTEGER), mark_notification_result(UUID, TEXT),
    begin_payment(UUID), attach_checkout_session(UUID, TEXT, TEXT, TEXT, JSONB),
    apply_payment_result(TEXT, transaction_status, TEXT, TEXT, BIGINT, BIGINT, TEXT, TEXT, JSONB, BOOLEAN),
    mark_refunded(TEXT, TEXT, JSONB), refunds_due(), checkout_sessions_to_expire(), mark_checkout_expired(UUID),
    record_payment_event(TEXT, TEXT, BOOLEAN, JSONB), finish_payment_event(TEXT, UUID, TEXT)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    claim_notifications(INTEGER), mark_notification_result(UUID, TEXT),
    begin_payment(UUID), attach_checkout_session(UUID, TEXT, TEXT, TEXT, JSONB),
    apply_payment_result(TEXT, transaction_status, TEXT, TEXT, BIGINT, BIGINT, TEXT, TEXT, JSONB, BOOLEAN),
    mark_refunded(TEXT, TEXT, JSONB), refunds_due(), checkout_sessions_to_expire(), mark_checkout_expired(UUID),
    record_payment_event(TEXT, TEXT, BOOLEAN, JSONB), finish_payment_event(TEXT, UUID, TEXT)
TO picksched_app;

COMMIT;
