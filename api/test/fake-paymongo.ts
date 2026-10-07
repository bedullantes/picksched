/**
 * A local stand-in for PayMongo, for tests and for development without
 * PayMongo keys. It implements the parts of the REST API the app uses
 * (checkout sessions, expire, refunds), serves a hosted checkout page with
 * GCash / Maya buttons, and sends signed webhooks the way PayMongo does.
 *
 * Not a full emulation: no real payment methods and no refund lifecycle.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { signWebhook } from '../src/paymongo.js';

interface FakePayment {
  id: string;
  type: 'payment';
  attributes: Record<string, any>;
}

interface FakeSession {
  id: string;
  paymentIntentId: string;
  status: 'active' | 'expired';
  amount: number;
  currency: string;
  name: string;
  methods: string[];
  successUrl: string;
  cancelUrl: string;
  reference: string;
  metadata: Record<string, string>;
  payments: FakePayment[];
}

export interface FakePayMongoOptions {
  secretKey: string;
  webhookSecret: string;
  /** Where to deliver webhooks (the app's /api/webhooks/paymongo). Can be set later. */
  webhookUrl?: string;
  port?: number;
}

const rid = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
const FEES: Record<string, number> = { gcash: 0.025, paymaya: 0.02 }; // PayMongo e-wallet rates

export async function startFakePayMongo(opts: FakePayMongoOptions) {
  const sessions = new Map<string, FakeSession>();
  const refunds: Array<{ id: string; paymentId: string; amount: number }> = [];
  const deliveries: Array<{ type: string; status: number }> = [];
  const state = {
    webhookUrl: opts.webhookUrl,
    /** Delay API responses (ms), to exercise client timeouts. */
    apiDelayMs: 0,
    /** Fail the next N API calls with 500. */
    failNextApiCalls: 0,
    /** When false, payments complete without sending webhooks (tests the verify fallback). */
    deliverWebhooks: true,
  };

  const sessionResource = (s: FakeSession) => ({
    id: s.id,
    type: 'checkout_session',
    attributes: {
      checkout_url: `${baseUrl}/checkout/${s.id}`,
      status: s.status,
      livemode: false,
      line_items: [{ amount: s.amount, currency: s.currency, name: s.name, quantity: 1 }],
      payment_method_types: s.methods,
      success_url: s.successUrl,
      cancel_url: s.cancelUrl,
      reference_number: s.reference,
      metadata: s.metadata,
      payment_intent: {
        id: s.paymentIntentId,
        type: 'payment_intent',
        attributes: {
          amount: s.amount, currency: s.currency,
          status: s.payments.some((p) => p.attributes.status === 'paid') ? 'succeeded' : 'awaiting_payment_method',
        },
      },
      payments: s.payments,
    },
  });

  async function sendEvent(type: string, data: unknown) {
    if (!state.deliverWebhooks || !state.webhookUrl) return;
    const body = JSON.stringify({
      data: { id: rid('evt'), type: 'event', attributes: { type, livemode: false, data, created_at: Math.floor(Date.now() / 1000) } },
    });
    const res = await fetch(state.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Paymongo-Signature': signWebhook(body, opts.webhookSecret) },
      body,
    });
    deliveries.push({ type, status: res.status });
  }

  /** Simulates the player paying (or failing to pay) on the hosted page. */
  async function pay(sessionId: string, method: 'gcash' | 'paymaya', outcome: 'paid' | 'failed') {
    const s = sessions.get(sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    if (s.status !== 'active') throw new Error(`session ${sessionId} is ${s.status}`);
    const fee = Math.round(s.amount * FEES[method]);
    const payment: FakePayment = {
      id: rid('pay'),
      type: 'payment',
      attributes: {
        amount: s.amount, currency: s.currency, fee, net_amount: s.amount - fee, status: outcome,
        source: { id: rid('src'), type: method }, payment_intent_id: s.paymentIntentId,
        failed_code: outcome === 'failed' ? 'payment_declined' : null,
        failed_message: outcome === 'failed' ? 'The payment was declined by the e-wallet.' : null,
        paid_at: outcome === 'paid' ? Math.floor(Date.now() / 1000) : null,
        livemode: false, metadata: s.metadata,
      },
    };
    s.payments.push(payment);
    if (outcome === 'paid') {
      await sendEvent('payment.paid', payment);
      await sendEvent('checkout_session.payment.paid', sessionResource(s));
    } else {
      await sendEvent('payment.failed', payment);
    }
    return payment;
  }

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const api = express.Router();
  api.use(async (req, res, next) => {
    const expected = `Basic ${Buffer.from(`${opts.secretKey}:`).toString('base64')}`;
    if (req.get('Authorization') !== expected) {
      res.status(401).json({ errors: [{ code: 'unauthorized', detail: 'Invalid API key.' }] });
      return;
    }
    if (state.apiDelayMs) await new Promise((r) => setTimeout(r, state.apiDelayMs));
    if (state.failNextApiCalls > 0) {
      state.failNextApiCalls--;
      res.status(500).json({ errors: [{ code: 'internal', detail: 'Simulated outage.' }] });
      return;
    }
    next();
  });

  api.post('/checkout_sessions', (req, res) => {
    const a = req.body?.data?.attributes ?? {};
    const item = a.line_items?.[0];
    const bad = !item || !Number.isInteger(item.amount) || item.amount < 2000 || !a.success_url || !a.cancel_url
      || !Array.isArray(a.payment_method_types) || a.payment_method_types.length === 0;
    if (bad) {
      res.status(400).json({ errors: [{ code: 'parameter_invalid', detail: 'Invalid checkout session.' }] });
      return;
    }
    const s: FakeSession = {
      id: rid('cs'), paymentIntentId: rid('pi'), status: 'active', amount: item.amount, currency: item.currency,
      name: item.name, methods: a.payment_method_types, successUrl: a.success_url, cancelUrl: a.cancel_url,
      reference: a.reference_number, metadata: a.metadata ?? {}, payments: [],
    };
    sessions.set(s.id, s);
    res.json({ data: sessionResource(s) });
  });

  api.get('/checkout_sessions/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return void res.status(404).json({ errors: [{ code: 'resource_not_found', detail: 'Not found.' }] });
    res.json({ data: sessionResource(s) });
  });

  api.post('/checkout_sessions/:id/expire', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return void res.status(404).json({ errors: [{ code: 'resource_not_found', detail: 'Not found.' }] });
    if (s.payments.some((p) => p.attributes.status === 'paid')) {
      return void res.status(400).json({ errors: [{ code: 'resource_failed_state', detail: 'Session already paid.' }] });
    }
    s.status = 'expired';
    res.json({ data: sessionResource(s) });
  });

  api.post('/refunds', (req, res) => {
    const a = req.body?.data?.attributes ?? {};
    const refund = { id: rid('ref'), paymentId: a.payment_id, amount: a.amount };
    refunds.push(refund);
    res.json({ data: { id: refund.id, type: 'refund', attributes: { status: 'pending', amount: a.amount, payment_id: a.payment_id } } });
  });

  app.use('/v1', api);

  // Hosted checkout page (what the player sees after the redirect).
  app.get('/checkout/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return void res.status(404).send('Checkout session not found');
    const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: s.currency }).format(s.amount / 100);
    const failed = s.payments.at(-1)?.attributes.status === 'failed';
    const btn = (method: string, label: string, outcome = 'paid', cls = '') =>
      `<button name="action" value="${method}:${outcome}" class="${cls}">${label}</button>`;
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PayMongo Checkout (test)</title>
<style>body{font-family:system-ui,sans-serif;background:#eef2f7;margin:0;display:grid;place-items:center;min-height:100vh}
.card{background:#fff;border-radius:14px;padding:28px;width:min(380px,92vw);box-shadow:0 8px 30px #0002}
h1{font-size:1rem;color:#555;margin:0}.amt{font-size:2rem;font-weight:800;margin:6px 0 4px}.item{color:#555;margin-bottom:18px}
button{display:block;width:100%;padding:12px;margin:8px 0;border-radius:10px;border:1px solid #ccd;font-weight:700;font-size:1rem;cursor:pointer;background:#fff}
.gcash{background:#0a56f0;color:#fff;border:none}.paymaya{background:#0c9b5b;color:#fff;border:none}.muted{color:#888;font-size:.85rem}
.err{background:#fee;color:#a00;padding:8px 10px;border-radius:8px}.test{background:#fff6d6;color:#7a5a00;padding:6px 10px;border-radius:8px;font-size:.8rem}</style></head>
<body><form class="card" method="post" action="/checkout/${s.id}">
<p class="test">TEST MODE · local PayMongo simulator</p>
<h1>Pay PickSched</h1><div class="amt">${peso}</div><div class="item">${s.name}</div>
${s.status !== 'active' ? '<p class="err">This checkout session has expired.</p>' : `
${failed ? '<p class="err">Your last payment attempt failed. You can try again.</p>' : ''}
${s.methods.includes('gcash') ? btn('gcash', 'Pay with GCash', 'paid', 'gcash') : ''}
${s.methods.includes('paymaya') ? btn('paymaya', 'Pay with Maya', 'paid', 'paymaya') : ''}
${btn('gcash', 'Simulate a declined payment', 'failed')}
<button name="action" value="cancel">Cancel and return to merchant</button>`}
<p class="muted">No real money moves in test mode.</p></form></body></html>`);
  });

  app.post('/checkout/:id', async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return void res.status(404).send('Not found');
    const action = String(req.body.action ?? '');
    if (action === 'cancel' || s.status !== 'active') return void res.redirect(303, s.cancelUrl);
    const [method, outcome] = action.split(':') as ['gcash' | 'paymaya', 'paid' | 'failed'];
    await pay(s.id, method, outcome);
    res.redirect(303, outcome === 'paid' ? s.successUrl : `/checkout/${s.id}`);
  });

  const server = app.listen(opts.port ?? 0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    apiBase: `${baseUrl}/v1`,
    state,
    sessions,
    refunds,
    deliveries,
    pay,
    sendEvent,
    sessionResource: (id: string) => sessionResource(sessions.get(id)!),
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export type FakePayMongo = Awaited<ReturnType<typeof startFakePayMongo>>;
