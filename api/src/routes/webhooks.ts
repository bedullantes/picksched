import express, { Router } from 'express';
import type { Deps } from '../context.js';
import { handleWebhookEvent } from '../payments.js';
import { verifyWebhookSignature } from '../paymongo.js';
import { verifyTwilioSignature } from '../messaging/twilio.js';
import { withUser } from '../db.js';

/**
 * POST /api/webhooks/paymongo
 *
 * Register this URL in the PayMongo dashboard (or via the Webhooks API) for:
 *   checkout_session.payment.paid, payment.paid, payment.failed, payment.refunded
 *
 * Needs the raw request body to check the Paymongo-Signature header, so this
 * router is mounted before the app's JSON body parser.
 */
export function webhookRoutes(deps: Deps) {
  const r = Router();

  r.post('/paymongo', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    const cfg = deps.config.paymongo;
    if (!cfg) {
      res.status(503).json({ error: { code: 'PAYMENTS_UNAVAILABLE', message: 'Payments are not configured.' } });
      return;
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const check = verifyWebhookSignature(raw, req.get('Paymongo-Signature'), cfg.webhookSecret, { live: cfg.live });
    if (!check.ok) {
      console.warn(`Rejected PayMongo webhook: ${check.reason}`);
      res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature.' } });
      return;
    }

    let body: any;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Body is not valid JSON.' } });
      return;
    }
    const event = body?.data;
    const attrs = event?.attributes;
    if (typeof event?.id !== 'string' || typeof attrs?.type !== 'string' || !attrs.data) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Not a PayMongo event.' } });
      return;
    }
    if (Boolean(attrs.livemode) !== cfg.live) {
      res.status(400).json({ error: { code: 'MODE_MISMATCH', message: 'Event mode does not match the configured keys.' } });
      return;
    }

    // Errors propagate as 500, so PayMongo retries the delivery.
    const result = await handleWebhookEvent(deps, {
      id: event.id, type: attrs.type, livemode: Boolean(attrs.livemode), resource: attrs.data, raw: body,
    });
    res.json({ received: true, result });
  });

  /**
   * POST /api/webhooks/twilio/status — Twilio delivery receipts for SMS
   * (sent with TWILIO_STATUS_CALLBACK_URL). Verified with X-Twilio-Signature.
   */
  r.post('/twilio/status', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
    const twilio = deps.config.notifications.sms.twilio;
    if (!twilio?.statusCallbackUrl) {
      res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'Twilio status callbacks are not configured.' } });
      return;
    }
    const params = Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k, String(v)]));
    if (!verifyTwilioSignature(twilio.authToken, twilio.statusCallbackUrl, params, req.get('X-Twilio-Signature'))) {
      console.warn('Rejected Twilio status callback: bad signature');
      res.status(403).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature.' } });
      return;
    }
    if (params.MessageSid && params.MessageStatus) {
      const error = params.ErrorCode ? `Twilio ${params.ErrorCode}: ${params.MessageStatus}` : null;
      await withUser(deps.db, null, deps.config.dbStatementTimeoutMs, (tx) =>
        tx.query('SELECT record_notification_delivery($1, $2, $3, $4)', ['twilio', params.MessageSid, params.MessageStatus, error]));
      if (params.MessageStatus === 'undelivered' || params.MessageStatus === 'failed') {
        console.error(`[notifications] SMS ${params.MessageSid} ${params.MessageStatus}${error ? ` (${error})` : ''}`);
      }
    }
    res.status(204).end();
  });

  return r;
}
