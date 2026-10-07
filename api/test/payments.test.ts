import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchNotifications, type NotificationMessage } from '../src/notifications.js';
import { runPaymentMaintenance } from '../src/payments.js';
import { signWebhook } from '../src/paymongo.js';
import { expireStaleHolds } from '../src/jobs.js';
import { at, manilaDate, PAYMONGO_WEBHOOK_SECRET, signUp, startTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof startTestApp>>;
type User = Awaited<ReturnType<typeof signUp>>;

let ctx: Ctx;
let owner: User;
let alice: User;
let bob: User;
let courtId: string;
let tomorrow: string;

async function reserve(user: User, h: number): Promise<string> {
  const res = await user.agent.post('/api/bookings')
    .send({ courtId, startTime: at(tomorrow, h), endTime: at(tomorrow, h + 1) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.booking.id;
}

async function checkout(user: User, bookingId: string) {
  return user.agent.post(`/api/bookings/${bookingId}/checkout`);
}

async function sessionIdFor(bookingId: string): Promise<string> {
  return (await ctx.admin.query('SELECT checkout_session_id FROM transactions WHERE booking_id = $1', [bookingId])).rows[0]
    .checkout_session_id;
}

const db = async (sql: string, params: unknown[] = []) => (await ctx.admin.query(sql, params)).rows;

function webhook(body: object, signature?: string) {
  const raw = JSON.stringify(body);
  return request(ctx.baseUrl).post('/api/webhooks/paymongo')
    .set('Content-Type', 'application/json')
    .set('Paymongo-Signature', signature ?? signWebhook(raw, PAYMONGO_WEBHOOK_SECRET))
    .send(raw);
}

const event = (type: string, data: object, id = `evt_${Math.random().toString(16).slice(2)}`, livemode = false) =>
  ({ data: { id, type: 'event', attributes: { type, livemode, data } } });

beforeAll(async () => {
  ctx = await startTestApp();
  owner = await signUp(ctx.baseUrl, 'admin', 'pay-owner');
  alice = await signUp(ctx.baseUrl, 'player', 'pay-alice');
  bob = await signUp(ctx.baseUrl, 'player', 'pay-bob');
  courtId = (await ctx.admin.query(
    `INSERT INTO courts (owner_id, name, hourly_rate) VALUES ($1, 'Pay Court', 60000) RETURNING id`, [owner.id])).rows[0].id;
  tomorrow = await manilaDate(ctx.admin, 1);
});

afterAll(async () => {
  await ctx?.close();
});

describe('starting checkout', () => {
  let bookingId: string;

  it('opens a PayMongo checkout session for GCash and Maya and returns its URL', async () => {
    bookingId = await reserve(alice, 6);
    const res = await checkout(alice, bookingId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      state: 'awaiting_payment',
      payment: { provider: 'paymongo', amount: 60000, currency: 'PHP', methods: ['gcash', 'paymaya'] },
    });
    expect(res.body.payment.checkoutUrl).toBe(`${ctx.paymongoFake.baseUrl}/checkout/${res.body.payment.checkoutSessionId}`);

    const session = ctx.paymongoFake.sessions.get(res.body.payment.checkoutSessionId)!;
    expect(session).toMatchObject({
      amount: 60000, currency: 'PHP', methods: ['gcash', 'paymaya'], reference: bookingId,
      successUrl: `http://app.test/bookings/${bookingId}/payment?result=success`,
      cancelUrl: `http://app.test/bookings/${bookingId}/payment?result=cancelled`,
      metadata: { booking_id: bookingId },
    });
    expect(session.name).toMatch(/^Pay Court · /);

    const [b] = await db('SELECT status, payment_status, payment_intent_id FROM bookings WHERE id = $1', [bookingId]);
    expect(b).toEqual({ status: 'pending_payment', payment_status: 'processing', payment_intent_id: session.paymentIntentId });
    const [t] = await db('SELECT status, provider_ref_id, checkout_session_id, amount FROM transactions WHERE booking_id = $1', [bookingId]);
    expect(t).toMatchObject({ status: 'pending', provider_ref_id: session.paymentIntentId, checkout_session_id: session.id, amount: '60000' });
  });

  it('reuses the same session on repeated or simultaneous clicks', async () => {
    const results = await Promise.all([checkout(alice, bookingId), checkout(alice, bookingId), checkout(alice, bookingId)]);
    expect(new Set(results.map((r) => r.body.payment.checkoutSessionId)).size).toBe(1);
    expect([...ctx.paymongoFake.sessions.values()].filter((s) => s.reference === bookingId)).toHaveLength(1);
  });

  it('is only for the player who made the booking', async () => {
    expect((await checkout(bob, bookingId)).status).toBe(404);
    expect((await checkout(owner, bookingId)).status).toBe(403);
  });

  it('is not available to admins, even for their own reservations', async () => {
    const own = (await owner.agent.post('/api/bookings')
      .send({ courtId, startTime: at(tomorrow, 21), endTime: at(tomorrow, 22) })).body.booking.id;
    const res = await checkout(owner, own);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only players can pay for bookings.');
  });

  it("doesn't let the owner bypass payment", async () => {
    const res = await owner.agent.post(`/api/bookings/${bookingId}/confirm`);
    expect(res.status).toBe(409);
    const [b] = await db('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    expect(b.status).toBe('pending_payment');
  });
});

describe('successful payment', () => {
  let bookingId: string;
  const sent: NotificationMessage[] = [];

  it('is confirmed automatically by the PayMongo webhook', async () => {
    bookingId = await reserve(alice, 7);
    await checkout(alice, bookingId);
    await ctx.paymongoFake.pay(await sessionIdFor(bookingId), 'gcash', 'paid');

    const [b] = await db('SELECT status, payment_status FROM bookings WHERE id = $1', [bookingId]);
    expect(b).toEqual({ status: 'confirmed', payment_status: 'paid' });
    expect(ctx.paymongoFake.deliveries.slice(-2)).toEqual([
      { type: 'payment.paid', status: 200 }, { type: 'checkout_session.payment.paid', status: 200 },
    ]);
  });

  it('logs the payment details, PayMongo fee and platform commission', async () => {
    const [t] = await db(
      `SELECT status, payment_id, payment_method, amount, provider_fee, commission_rate_bps, platform_fee, owner_net,
              processed_at IS NOT NULL AS processed, provider_payload->>'type' AS payload_type
       FROM transactions WHERE booking_id = $1`, [bookingId]);
    expect(t).toMatchObject({
      status: 'paid', payment_method: 'gcash', amount: '60000',
      provider_fee: '1500',        // GCash 2.5%
      commission_rate_bps: 500,
      platform_fee: '3000',        // 5% of 60000
      owner_net: '55500',          // 60000 - 1500 - 3000
      processed: true,
    });
    expect(t.payment_id).toMatch(/^pay_/);
    const events = await db(
      `SELECT type, result FROM payment_events e JOIN transactions t ON t.id = e.transaction_id
       WHERE t.booking_id = $1 ORDER BY received_at`, [bookingId]);
    expect(events.map((e) => e.type)).toEqual(['payment.paid', 'checkout_session.payment.paid']);
    expect(events[0].result).toBe('booking confirmed, payment paid');
  });

  it('shows the player their payment and the owner the fee breakdown', async () => {
    const mine = (await alice.agent.get(`/api/bookings/${bookingId}`)).body.booking;
    expect(mine).toMatchObject({ status: 'confirmed', paymentStatus: 'paid', payment: { status: 'paid', method: 'gcash', amount: 60000 } });
    expect(mine.payment.platformFee).toBeUndefined();
    const theirs = (await owner.agent.get(`/api/bookings/${bookingId}`)).body.booking;
    expect(theirs.payment).toMatchObject({ providerFee: 1500, platformFee: 3000, ownerNet: 55500 });
  });

  it('notifies the player and the court owner', async () => {
    await dispatchNotifications(ctx.deps, { send: async (m) => void sent.push(m) });
    const forBooking = sent.filter((m) => m.data.id === bookingId);
    expect(forBooking.map((m) => [m.kind, m.to]).sort()).toEqual([
      ['booking_confirmed', alice.email], ['booking_received', owner.email],
    ]);
    expect(forBooking.find((m) => m.kind === 'booking_confirmed')!.subject).toBe('Booking confirmed: Pay Court');
    expect((await alice.agent.get('/api/notifications')).body.notifications[0]).toMatchObject({
      kind: 'booking_confirmed', bookingId, subject: 'Booking confirmed: Pay Court',
    });
  });

  it('checkout reports the booking as confirmed afterwards', async () => {
    expect((await checkout(alice, bookingId)).body.state).toBe('confirmed');
  });
});

describe('failed payment', () => {
  let bookingId: string;

  it('leaves the booking pending payment, so the player can retry', async () => {
    bookingId = await reserve(alice, 8);
    await checkout(alice, bookingId);
    await ctx.paymongoFake.pay(await sessionIdFor(bookingId), 'paymaya', 'failed');

    const [b] = await db('SELECT status, payment_status FROM bookings WHERE id = $1', [bookingId]);
    expect(b).toEqual({ status: 'pending_payment', payment_status: 'failed' });
    const res = await alice.agent.get(`/api/bookings/${bookingId}`);
    expect(res.body.booking.payment).toMatchObject({
      status: 'failed', method: 'paymaya', failureCode: 'payment_declined',
      failureMessage: 'The payment was declined by the e-wallet.',
    });
  });

  it('a later successful attempt in the same session confirms it', async () => {
    const again = await checkout(alice, bookingId);
    expect(again.body.payment.checkoutSessionId).toBe(await sessionIdFor(bookingId));
    await ctx.paymongoFake.pay(await sessionIdFor(bookingId), 'paymaya', 'paid');
    const [b] = await db('SELECT status, payment_status FROM bookings WHERE id = $1', [bookingId]);
    expect(b).toEqual({ status: 'confirmed', payment_status: 'paid' });
    const [t] = await db('SELECT provider_fee, owner_net, failure_code FROM transactions WHERE booking_id = $1', [bookingId]);
    expect(t).toEqual({ provider_fee: '1200', owner_net: '55800', failure_code: null }); // Maya 2%
  });
});

describe('webhook security', () => {
  let paidEvent: object;

  beforeAll(async () => {
    const bookingId = await reserve(bob, 9);
    await checkout(bob, bookingId);
    ctx.paymongoFake.state.deliverWebhooks = false;
    const payment = await ctx.paymongoFake.pay(await sessionIdFor(bookingId), 'gcash', 'paid');
    ctx.paymongoFake.state.deliverWebhooks = true;
    paidEvent = event('payment.paid', payment, 'evt_security_test');
  });

  it('rejects a missing or wrong signature', async () => {
    const raw = JSON.stringify(paidEvent);
    const missing = await request(ctx.baseUrl).post('/api/webhooks/paymongo').set('Content-Type', 'application/json').send(raw);
    expect(missing.status).toBe(401);
    expect((await webhook(paidEvent, signWebhook(raw, 'whsk_wrong_secret'))).status).toBe(401);
  });

  it('rejects a body changed after signing', async () => {
    const sig = signWebhook(JSON.stringify(paidEvent), PAYMONGO_WEBHOOK_SECRET);
    const tampered = JSON.parse(JSON.stringify(paidEvent));
    tampered.data.attributes.data.attributes.amount = 1;
    expect((await webhook(tampered, sig)).status).toBe(401);
  });

  it('rejects a replayed old signature', async () => {
    const raw = JSON.stringify(paidEvent);
    const old = signWebhook(raw, PAYMONGO_WEBHOOK_SECRET, false, Math.floor(Date.now() / 1000) - 3600);
    expect((await webhook(paidEvent, old)).status).toBe(401);
  });

  it('rejects a live-mode signature when using test keys', async () => {
    const raw = JSON.stringify(paidEvent);
    expect((await webhook(paidEvent, signWebhook(raw, PAYMONGO_WEBHOOK_SECRET, true))).status).toBe(401);
  });

  it('nothing was confirmed by the rejected requests', async () => {
    const [b] = await db(`SELECT b.status FROM bookings b WHERE b.start_time = $1 AND b.court_id = $2`, [at(tomorrow, 9), courtId]);
    expect(b.status).toBe('pending_payment');
  });

  it('accepts a correctly signed event once, and ignores redelivery', async () => {
    const first = await webhook(paidEvent);
    expect(first.body).toEqual({ received: true, result: 'booking confirmed, payment paid' });
    const again = await webhook(paidEvent);
    expect(again.body).toEqual({ received: true, result: 'duplicate' });
  });

  it('acknowledges events for payments it does not know', async () => {
    const res = await webhook(event('payment.paid', {
      id: 'pay_other', type: 'payment', attributes: { status: 'paid', amount: 100, payment_intent_id: 'pi_not_ours' },
    }));
    expect(res.body).toEqual({ received: true, result: 'unknown payment intent' });
  });
});

describe('returning before the webhook arrives', () => {
  it('verify asks PayMongo directly and confirms the booking', async () => {
    const bookingId = await reserve(alice, 10);
    await checkout(alice, bookingId);
    ctx.paymongoFake.state.deliverWebhooks = false;
    await ctx.paymongoFake.pay(await sessionIdFor(bookingId), 'gcash', 'paid');
    ctx.paymongoFake.state.deliverWebhooks = true;

    expect((await alice.agent.get(`/api/bookings/${bookingId}`)).body.booking.status).toBe('pending_payment');
    const res = await alice.agent.post(`/api/bookings/${bookingId}/payment/verify`);
    expect(res.status).toBe(200);
    expect(res.body.booking).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
  });

  it('verify leaves an unpaid booking pending', async () => {
    const bookingId = await reserve(alice, 11);
    await checkout(alice, bookingId);
    const res = await alice.agent.post(`/api/bookings/${bookingId}/payment/verify`);
    expect(res.body.booking).toMatchObject({ status: 'pending_payment', paymentStatus: 'processing' });
  });
});

describe('abandoned and late payments', () => {
  it('an unpaid booking expires, and its PayMongo session is closed', async () => {
    const bookingId = await reserve(bob, 12);
    await checkout(bob, bookingId);
    const sessionId = await sessionIdFor(bookingId);
    await db(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [bookingId]);
    await expireStaleHolds(ctx.deps);

    const [b] = await db('SELECT status, payment_status FROM bookings WHERE id = $1', [bookingId]);
    expect(b).toEqual({ status: 'cancelled', payment_status: 'expired' });
    const result = await runPaymentMaintenance(ctx.deps);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(ctx.paymongoFake.sessions.get(sessionId)!.status).toBe('expired');
    const [t] = await db('SELECT status, failure_code FROM transactions WHERE booking_id = $1', [bookingId]);
    expect(t).toEqual({ status: 'failed', failure_code: 'checkout_expired' });
    expect((await checkout(bob, bookingId)).body.error.code).toBe('BOOKING_CANCELLED');
  });

  it('a payment that lands after the hold expired is refunded, not confirmed', async () => {
    const bookingId = await reserve(bob, 13);
    await checkout(bob, bookingId);
    await db(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [bookingId]);
    await expireStaleHolds(ctx.deps);
    await ctx.paymongoFake.pay(await sessionIdFor(bookingId), 'gcash', 'paid'); // before the session got closed

    const [b] = await db('SELECT status, payment_status FROM bookings WHERE id = $1', [bookingId]);
    expect(b).toEqual({ status: 'cancelled', payment_status: 'refunded' });
    const [t] = await db('SELECT status, refund_id, payment_id FROM transactions WHERE booking_id = $1', [bookingId]);
    expect(t.status).toBe('refunded');
    expect(ctx.paymongoFake.refunds).toContainEqual({ id: t.refund_id, paymentId: t.payment_id, amount: 60000 });
    const [n] = await db(`SELECT count(*)::int AS n FROM notifications WHERE booking_id = $1 AND kind = 'payment_refunded'`, [bookingId]);
    expect(n.n).toBe(1);
  });
});

describe('PayMongo outages', () => {
  it('a timeout returns a friendly 504 and keeps the hold', async () => {
    const bookingId = await reserve(alice, 14);
    ctx.paymongoFake.state.apiDelayMs = 3000; // client timeout is 2000ms in tests
    const res = await checkout(alice, bookingId);
    ctx.paymongoFake.state.apiDelayMs = 0;
    expect(res.status).toBe(504);
    expect(res.body.error).toMatchObject({ code: 'PAYMENT_PROVIDER_TIMEOUT', message: expect.stringMatching(/still held/) });
    const [b] = await db('SELECT status, payment_status FROM bookings WHERE id = $1', [bookingId]);
    expect(b).toEqual({ status: 'pending_payment', payment_status: 'unpaid' });
    expect((await checkout(alice, bookingId)).status).toBe(200); // retry works
  });

  it('a PayMongo error returns a friendly 502', async () => {
    const bookingId = await reserve(alice, 15);
    ctx.paymongoFake.state.failNextApiCalls = 1;
    const res = await checkout(alice, bookingId);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');
  });

  it('without PayMongo configured, checkout is unavailable but booking still works', async () => {
    const bare = await startTestApp({ paymongo: undefined });
    try {
      const carol = await signUp(bare.baseUrl, 'player', 'pay-carol');
      const res = await carol.agent.post('/api/bookings')
        .send({ courtId, startTime: at(tomorrow, 16), endTime: at(tomorrow, 17) });
      expect(res.status).toBe(201);
      const pay = await carol.agent.post(`/api/bookings/${res.body.booking.id}/checkout`);
      expect(pay.status).toBe(503);
      expect(pay.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
      const hook = await request(bare.baseUrl).post('/api/webhooks/paymongo').send('{}');
      expect(hook.status).toBe(503);
    } finally {
      await bare.close();
    }
  });
});
