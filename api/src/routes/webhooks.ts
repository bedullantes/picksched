import express, { Router } from 'express';
import type { Deps } from '../context.js';
import { handleWebhookEvent } from '../payments.js';
import { verifyWebhookSignature } from '../paymongo.js';

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

  return r;
}
