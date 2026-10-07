-- =============================================================================
-- PickSched — Migration 006: Email (SendGrid) and SMS (Twilio) notifications
-- Depends on: 001–005
-- =============================================================================
--
-- 1. users.phone (E.164, optional): where SMS confirmations go.
-- 2. bookings.confirmed_at, confirmation_email_sent_at,
--    confirmation_sms_sent_at: audit trail for the player's confirmation.
-- 3. notifications get a channel (email | sms), a delivery status and the
--    provider's message id. One row per recipient per channel, so email and
--    SMS are delivered, retried and audited independently.
-- 4. claim_notifications() returns fresh booking details and status, so a
--    message reflects the current court, date and time, and confirmation
--    messages are skipped if the booking is no longer confirmed.
-- 5. Retry backoff: 15s, 30s, 60s, 120s, 240s (up to 6 attempts).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- users.phone
-- -----------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN phone TEXT,
    ADD CONSTRAINT users_phone_e164_chk CHECK (phone ~ '^\+[1-9][0-9]{7,14}$');

GRANT UPDATE (phone) ON users TO picksched_app;

-- -----------------------------------------------------------------------------
-- bookings: confirmation audit fields
-- -----------------------------------------------------------------------------
ALTER TABLE bookings
    ADD COLUMN confirmed_at               TIMESTAMPTZ,
    ADD COLUMN confirmation_email_sent_at TIMESTAMPTZ,
    ADD COLUMN confirmation_sms_sent_at   TIMESTAMPTZ;

UPDATE bookings SET confirmed_at = updated_at WHERE status = 'confirmed';

CREATE FUNCTION bookings_set_confirmed_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed' THEN
        NEW.confirmed_at := now();
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER bookings_set_confirmed_at
    BEFORE UPDATE OF status ON bookings
    FOR EACH ROW EXECUTE FUNCTION bookings_set_confirmed_at();

-- -----------------------------------------------------------------------------
-- notifications: channel and delivery tracking
-- -----------------------------------------------------------------------------
--   pending    queued or waiting for a retry
--   sent       accepted by the provider (SendGrid / Twilio)
--   delivered  provider reported delivery to the handset (Twilio status callback)
--   failed     gave up: permanent error, too many attempts, or undelivered
--   skipped    not sent on purpose (booking no longer confirmed, no phone number)
ALTER TABLE notifications
    ADD COLUMN channel             TEXT NOT NULL DEFAULT 'email',
    ADD COLUMN status              TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN provider            TEXT,
    ADD COLUMN provider_message_id TEXT,
    ADD COLUMN recipient_address   TEXT,   -- email or phone the message went to
    ADD COLUMN delivered_at        TIMESTAMPTZ,
    ADD COLUMN failed_at           TIMESTAMPTZ,
    ADD CONSTRAINT notifications_channel_chk CHECK (channel IN ('email', 'sms')),
    ADD CONSTRAINT notifications_status_chk CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'skipped'));

UPDATE notifications SET status = CASE WHEN sent_at IS NOT NULL THEN 'sent' ELSE 'pending' END;

ALTER TABLE notifications DROP CONSTRAINT notifications_once;
ALTER TABLE notifications ADD CONSTRAINT notifications_once UNIQUE (kind, booking_id, recipient_id, channel);
CREATE UNIQUE INDEX notifications_provider_message_key ON notifications (provider, provider_message_id)
    WHERE provider_message_id IS NOT NULL;
DROP INDEX notifications_unsent_idx;
CREATE INDEX notifications_pending_idx ON notifications (created_at) WHERE status = 'pending';

-- Confirmation (player) and booking alert (owner) go out by email and, when
-- the recipient has a phone number, by SMS. Refund notices are email only.
CREATE OR REPLACE FUNCTION enqueue_booking_notifications(p_booking_id UUID, p_kind TEXT) RETURNS void
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

    INSERT INTO notifications (recipient_id, kind, booking_id, payload, channel)
    SELECT r.recipient_id, r.kind, v.id, to_jsonb(v), ch.channel
    FROM (
        SELECT v.player_id AS recipient_id, CASE WHEN p_kind = 'booking_confirmed' THEN 'booking_confirmed' ELSE p_kind END AS kind
        UNION ALL
        SELECT v.owner_id, 'booking_received' WHERE p_kind = 'booking_confirmed'
    ) r
    JOIN users u ON u.id = r.recipient_id
    CROSS JOIN LATERAL (
        SELECT 'email' AS channel
        UNION ALL
        SELECT 'sms' WHERE u.phone IS NOT NULL AND r.kind IN ('booking_confirmed', 'booking_received')
    ) ch
    ON CONFLICT ON CONSTRAINT notifications_once DO NOTHING;
END
$$;

-- Claims due notifications for delivery, with current booking details.
-- Safe with several dispatchers (rows are locked and skipped).
DROP FUNCTION claim_notifications(INTEGER);
CREATE FUNCTION claim_notifications(p_limit INTEGER)
RETURNS TABLE (
    id              UUID,
    kind            TEXT,
    channel         TEXT,
    attempts        INTEGER,
    recipient_role  user_role,
    recipient_email TEXT,
    recipient_phone TEXT,
    booking_id      UUID,
    booking_status  booking_status,
    court_name      TEXT,
    court_location  TEXT,
    timezone        TEXT,
    start_time      TIMESTAMPTZ,
    end_time        TIMESTAMPTZ,
    total_amount    BIGINT,
    currency        CHAR(3),
    payload         JSONB
)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH claimed AS (
        UPDATE notifications n
        SET attempts = n.attempts + 1, last_attempt_at = now()
        WHERE n.id IN (
            SELECT x.id FROM notifications x
            WHERE x.status = 'pending'
              AND (x.last_attempt_at IS NULL
                   OR x.last_attempt_at < now() - make_interval(secs => 15 * power(2, x.attempts - 1)))
            ORDER BY x.created_at
            LIMIT p_limit
            FOR UPDATE SKIP LOCKED
        )
        RETURNING n.*
    )
    SELECT c.id, c.kind, c.channel, c.attempts, u.role, u.email, u.phone,
           b.id, b.status, ct.name, ct.location, ct.timezone, b.start_time, b.end_time, b.total_amount, b.currency,
           c.payload
    FROM claimed c
    JOIN users u ON u.id = c.recipient_id
    LEFT JOIN bookings b ON b.id = c.booking_id
    LEFT JOIN courts ct ON ct.id = b.court_id
    ORDER BY c.created_at
$$;

-- Most attempts per notification before it is marked failed.
CREATE FUNCTION notification_max_attempts() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$ SELECT 6 $$;

CREATE FUNCTION mark_notification_sent(p_id UUID, p_provider TEXT, p_message_id TEXT, p_address TEXT) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n notifications;
BEGIN
    UPDATE notifications
    SET status = 'sent', sent_at = now(), provider = p_provider, provider_message_id = p_message_id,
        recipient_address = p_address, last_error = NULL
    WHERE id = p_id
    RETURNING * INTO n;
    IF n.kind = 'booking_confirmed' THEN
        UPDATE bookings
        SET confirmation_email_sent_at = CASE WHEN n.channel = 'email' THEN COALESCE(confirmation_email_sent_at, now())
                                              ELSE confirmation_email_sent_at END,
            confirmation_sms_sent_at   = CASE WHEN n.channel = 'sms' THEN COALESCE(confirmation_sms_sent_at, now())
                                              ELSE confirmation_sms_sent_at END
        WHERE id = n.booking_id;
    END IF;
END
$$;

-- Records a failed attempt. Permanent errors (e.g. an invalid number) and the
-- last allowed attempt mark the notification failed; otherwise it is retried.
CREATE FUNCTION mark_notification_failed(p_id UUID, p_error TEXT, p_permanent BOOLEAN) RETURNS TEXT
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE notifications
    SET last_error = p_error,
        status = CASE WHEN p_permanent OR attempts >= notification_max_attempts() THEN 'failed' ELSE 'pending' END,
        failed_at = CASE WHEN p_permanent OR attempts >= notification_max_attempts() THEN now() END
    WHERE id = p_id
    RETURNING status
$$;

CREATE FUNCTION mark_notification_skipped(p_id UUID, p_reason TEXT) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE notifications SET status = 'skipped', last_error = p_reason WHERE id = p_id
$$;

-- Kept for existing callers (migration 005).
CREATE OR REPLACE FUNCTION mark_notification_result(p_id UUID, p_error TEXT) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_error IS NULL THEN
        PERFORM mark_notification_sent(p_id, NULL, NULL, NULL);
    ELSE
        PERFORM mark_notification_failed(p_id, p_error, FALSE);
    END IF;
END
$$;

-- Delivery receipts from the provider (Twilio status callbacks).
--   delivered            -> delivered
--   undelivered / failed -> failed (with the provider's error code)
--   anything else        -> ignored (queued, sent, ...)
CREATE FUNCTION record_notification_delivery(p_provider TEXT, p_message_id TEXT, p_status TEXT, p_error TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_status = 'delivered' THEN
        UPDATE notifications SET status = 'delivered', delivered_at = now()
        WHERE provider = p_provider AND provider_message_id = p_message_id AND status IN ('sent', 'delivered');
    ELSIF p_status IN ('undelivered', 'failed') THEN
        UPDATE notifications SET status = 'failed', failed_at = now(), last_error = COALESCE(p_error, p_status)
        WHERE provider = p_provider AND provider_message_id = p_message_id AND status IN ('sent', 'delivered');
    ELSE
        RETURN FALSE;
    END IF;
    RETURN FOUND;
END
$$;

REVOKE EXECUTE ON FUNCTION
    claim_notifications(INTEGER), mark_notification_sent(UUID, TEXT, TEXT, TEXT),
    mark_notification_failed(UUID, TEXT, BOOLEAN), mark_notification_skipped(UUID, TEXT),
    record_notification_delivery(TEXT, TEXT, TEXT, TEXT)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    claim_notifications(INTEGER), mark_notification_sent(UUID, TEXT, TEXT, TEXT),
    mark_notification_failed(UUID, TEXT, BOOLEAN), mark_notification_skipped(UUID, TEXT),
    record_notification_delivery(TEXT, TEXT, TEXT, TEXT)
TO picksched_app;

COMMIT;
