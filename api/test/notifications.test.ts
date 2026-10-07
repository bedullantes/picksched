import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { normalizePhone } from '../src/messaging/phone.js';
import { bookingReference, renderMessage } from '../src/messaging/templates.js';
import { twilioSignature } from '../src/messaging/twilio.js';
import { at, manilaDate, signUp, startTestApp, TWILIO_TOKEN } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof startTestApp>>;
type User = Awaited<ReturnType<typeof signUp>>;

let ctx: Ctx;
let owner: User;
let player: User;
let courtId: string;
let tomorrow: string;

const db = async (sql: string, params: unknown[] = []) => (await ctx.admin.query(sql, params)).rows;

async function until<T>(fn: () => T | Promise<T>, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Reserves hour h, pays through the fake PayMongo, and returns the booking id and when the webhook landed. */
async function bookAndPay(user: User, h: number) {
  const res = await user.agent.post('/api/bookings').send({ courtId, startTime: at(tomorrow, h), endTime: at(tomorrow, h + 1) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body.booking.id as string;
  await user.agent.post(`/api/bookings/${id}/checkout`);
  const [{ checkout_session_id: cs }] = await db('SELECT checkout_session_id FROM transactions WHERE booking_id = $1', [id]);
  await ctx.paymongoFake.pay(cs, 'gcash', 'paid'); // resolves after PayMongo's webhooks were answered
  return { id, paidAt: Date.now() };
}

beforeAll(async () => {
  ctx = await startTestApp({}, { messaging: true });
  owner = await signUp(ctx.baseUrl, 'admin', 'nt-owner');
  player = await signUp(ctx.baseUrl, 'player', 'nt-player');
  await owner.agent.patch('/api/auth/me').send({ phone: '0918 111 2222' });
  await player.agent.patch('/api/auth/me').send({ phone: '+63 917 123 4567' });
  courtId = (await ctx.admin.query(
    `INSERT INTO courts (owner_id, name, hourly_rate, location) VALUES ($1, 'Riverside Court 2', 50000, 'Makati') RETURNING id`,
    [owner.id])).rows[0].id;
  tomorrow = await manilaDate(ctx.admin, 1);
});

afterAll(async () => {
  await ctx?.close();
});

describe('phone numbers', () => {
  it('normalizes Philippine mobile numbers to E.164', () => {
    for (const input of ['0917 123 4567', '09171234567', '917-123-4567', '63 917 123 4567', '+63 (917) 123-4567', '0063 917 123 4567']) {
      expect(normalizePhone(input), input).toBe('+639171234567');
    }
    expect(normalizePhone('+1 415 555 0100')).toBe('+14155550100');
    for (const bad of ['02 8123 4567', '0917 123', 'call me', '+63 2 8123 4567', '']) {
      expect(normalizePhone(bad), bad).toBeNull();
    }
  });

  it('can be given at sign-up', async () => {
    const res = await request(ctx.baseUrl).post('/api/auth/register')
      .send({ email: `nt-signup-${Date.now()}@example.com`, password: 'correct horse battery', phone: '0917 555 0000' });
    expect(res.status).toBe(201);
    expect(res.body.user.phone).toBe('+639175550000');
  });

  it('rejects an invalid number with a helpful message', async () => {
    const res = await player.agent.patch('/api/auth/me').send({ phone: '02 8123 4567' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_PHONE', message: expect.stringMatching(/valid mobile number/) });
  });

  it('is returned by /me and can be cleared', async () => {
    const someone = await signUp(ctx.baseUrl, 'player', 'nt-clear');
    expect((await someone.agent.patch('/api/auth/me').send({ phone: '09170000001' })).body.user.phone).toBe('+639170000001');
    expect((await someone.agent.get('/api/auth/me')).body.user.phone).toBe('+639170000001');
    expect((await someone.agent.patch('/api/auth/me').send({ phone: '' })).body.user.phone).toBeNull();
  });
});

describe('booking confirmation', () => {
  let booking: { id: string; paidAt: number };

  beforeAll(async () => {
    booking = await bookAndPay(player, 9);
    // Providers received the messages and the results were recorded.
    await until(async () => (await db(
      `SELECT 1 FROM notifications WHERE booking_id = $1 AND status = 'sent'`, [booking.id])).length === 4);
  });

  it('emails the player through SendGrid with court, date, time and reference', () => {
    const email = ctx.messagingFake!.emails.find((e) => e.to === player.email)!;
    expect(email).toMatchObject({
      from: { email: 'bookings@picksched.test', name: 'PickSched' },
      subject: 'Booking confirmed: Riverside Court 2',
      categories: ['picksched', 'booking_confirmed'],
    });
    const ref = bookingReference(booking.id);
    const date = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      .format(new Date(at(tomorrow, 9)));
    for (const body of [email.text, email.html]) {
      expect(body).toContain('Riverside Court 2');
      expect(body).toContain(date);
      expect(body).toContain('9:00 AM – 10:00 AM');
      expect(body).toContain(ref);
      expect(body).toContain(booking.id);
    }
    expect(email.text).toContain('Location: Makati');
  });

  it('texts the player through Twilio with the same details in one plain SMS segment', () => {
    const sms = ctx.messagingFake!.sms.find((m) => m.to === '+639171234567')!;
    expect(sms).toMatchObject({
      messagingServiceSid: 'MGfake',
      statusCallback: 'https://picksched.test/api/webhooks/twilio/status',
    });
    const shortDate = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric' })
      .format(new Date(at(tomorrow, 9)));
    expect(sms.body).toBe(`PickSched: Booking confirmed! Riverside Court 2, ${shortDate}, 9:00 AM-10:00 AM. Ref ${bookingReference(booking.id)}. See you on the court!`);
    expect(sms.body.length).toBeLessThanOrEqual(160);
    expect(sms.body).toMatch(/^[\x20-\x7e]+$/);
  });

  it('alerts the court owner by email and SMS', () => {
    expect(ctx.messagingFake!.emails.find((e) => e.to === owner.email)!.subject).toBe('New paid booking: Riverside Court 2');
    expect(ctx.messagingFake!.sms.find((m) => m.to === '+639181112222')!.body).toMatch(/^PickSched: New paid booking - Riverside Court 2, .*\(PHP 500\.00\)\. Ref PS-/);
  });

  it('goes out within seconds of the PayMongo callback (requirement: 2 minutes)', () => {
    const latest = Math.max(...[...ctx.messagingFake!.emails, ...ctx.messagingFake!.sms].map((m) => m.receivedAt));
    expect(latest - booking.paidAt).toBeLessThan(10_000);
  });

  it('records delivery for auditing', async () => {
    const [b] = await db(
      `SELECT status, confirmed_at IS NOT NULL AS confirmed, confirmation_email_sent_at IS NOT NULL AS emailed,
              confirmation_sms_sent_at IS NOT NULL AS texted FROM bookings WHERE id = $1`, [booking.id]);
    expect(b).toEqual({ status: 'confirmed', confirmed: true, emailed: true, texted: true });
    const rows = await db(
      `SELECT kind, channel, status, provider, provider_message_id, recipient_address FROM notifications
       WHERE booking_id = $1 ORDER BY kind, channel`, [booking.id]);
    expect(rows.map((r) => [r.kind, r.channel, r.status, r.provider, r.recipient_address])).toEqual([
      ['booking_confirmed', 'email', 'sent', 'sendgrid', player.email],
      ['booking_confirmed', 'sms', 'sent', 'twilio', '+639171234567'],
      ['booking_received', 'email', 'sent', 'sendgrid', owner.email],
      ['booking_received', 'sms', 'sent', 'twilio', '+639181112222'],
    ]);
    expect(rows.every((r) => r.provider_message_id)).toBe(true);
  });

  it('records Twilio delivery receipts, and rejects unsigned ones', async () => {
    const sms = ctx.messagingFake!.sms.find((m) => m.to === '+639171234567')!;
    const params = { MessageSid: sms.sid, MessageStatus: 'delivered', AccountSid: 'ACfake' };
    const url = 'https://picksched.test/api/webhooks/twilio/status';

    const forged = await request(ctx.baseUrl).post('/api/webhooks/twilio/status').type('form')
      .set('X-Twilio-Signature', twilioSignature('wrong-token', url, params)).send(params);
    expect(forged.status).toBe(403);

    const ok = await request(ctx.baseUrl).post('/api/webhooks/twilio/status').type('form')
      .set('X-Twilio-Signature', twilioSignature(TWILIO_TOKEN, url, params)).send(params);
    expect(ok.status).toBe(204);
    const [n] = await db('SELECT status, delivered_at IS NOT NULL AS d FROM notifications WHERE provider_message_id = $1', [sms.sid]);
    expect(n).toEqual({ status: 'delivered', d: true });
  });

  it('a player without a phone number gets email only', async () => {
    const noPhone = await signUp(ctx.baseUrl, 'player', 'nt-nophone');
    const b = await bookAndPay(noPhone, 11);
    await until(() => ctx.messagingFake!.emails.some((e) => e.to === noPhone.email));
    const rows = await db(`SELECT channel FROM notifications WHERE booking_id = $1 AND kind = 'booking_confirmed'`, [b.id]);
    expect(rows.map((r) => r.channel)).toEqual(['email']);
  });
});

describe('failures never affect the payment', () => {
  it('SendGrid and Twilio outages: booking still confirmed, failure logged, retried later', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctx.messagingFake!.state.sendgridStatus = 503;
    ctx.messagingFake!.state.twilioStatus = 500;
    try {
      const { id } = await bookAndPay(player, 13);
      expect(ctx.paymongoFake.deliveries.slice(-2).map((d) => d.status)).toEqual([200, 200]); // webhook answered OK
      const [b] = await db('SELECT status, payment_status FROM bookings WHERE id = $1', [id]);
      expect(b).toEqual({ status: 'confirmed', payment_status: 'paid' });
      expect((await player.agent.get(`/api/bookings/${id}`)).body.booking.status).toBe('confirmed');

      await until(async () => (await db(
        `SELECT 1 FROM notifications WHERE booking_id = $1 AND kind = 'booking_confirmed' AND attempts >= 1 AND last_error IS NOT NULL`, [id])).length === 2);
      const rows = await db(`SELECT channel, status, last_error FROM notifications WHERE booking_id = $1 AND kind = 'booking_confirmed' ORDER BY channel`, [id]);
      expect(rows).toEqual([
        { channel: 'email', status: 'pending', last_error: 'SendGrid returned 503: Simulated SendGrid error' },
        { channel: 'sms', status: 'pending', last_error: 'Twilio returned 500: 20500 Internal Server Error' },
      ]);
      expect(errors.mock.calls.some((c) => String(c[0]).includes('will retry'))).toBe(true);

      // Providers recover; the retry (after the 15s backoff, fast-forwarded here) delivers.
      ctx.messagingFake!.state.sendgridStatus = 202;
      ctx.messagingFake!.state.twilioStatus = 201;
      await db(`UPDATE notifications SET last_attempt_at = now() - interval '1 minute' WHERE booking_id = $1`, [id]);
      ctx.deps.notifier!.kick();
      await until(async () => (await db(
        `SELECT 1 FROM notifications WHERE booking_id = $1 AND status = 'sent'`, [id])).length === 4);
    } finally {
      ctx.messagingFake!.state.sendgridStatus = 202;
      ctx.messagingFake!.state.twilioStatus = 201;
      errors.mockRestore();
    }
  });

  it('a number Twilio rejects is not retried, and email still goes out', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctx.messagingFake!.state.twilioStatus = 400;
    try {
      const { id } = await bookAndPay(player, 15);
      await until(async () => (await db(
        `SELECT 1 FROM notifications WHERE booking_id = $1 AND kind = 'booking_confirmed' AND status <> 'pending'`, [id])).length === 2);
      const rows = await db(`SELECT channel, status, last_error FROM notifications WHERE booking_id = $1 AND kind = 'booking_confirmed' ORDER BY channel`, [id]);
      expect(rows[0]).toMatchObject({ channel: 'email', status: 'sent' });
      expect(rows[1]).toMatchObject({ channel: 'sms', status: 'failed', last_error: expect.stringContaining('21211') });
      expect(errors.mock.calls.some((c) => String(c[0]).includes('giving up'))).toBe(true);
      const [b] = await db('SELECT status FROM bookings WHERE id = $1', [id]);
      expect(b.status).toBe('confirmed');
    } finally {
      ctx.messagingFake!.state.twilioStatus = 201;
      errors.mockRestore();
    }
  });
});

describe('only confirmed bookings are notified', () => {
  it('skips the confirmation if the booking was cancelled before sending', async () => {
    ctx.deps.notifier!.stop(); // hold the queue so we can cancel first
    await ctx.deps.notifier!.idle();
    const saved = ctx.deps.notifier;
    ctx.deps.notifier = undefined;
    try {
      const { id } = await bookAndPay(player, 17);
      await db(`UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [id]);
      const before = ctx.messagingFake!.emails.length;
      saved!.kick();
      await saved!.idle();
      const rows = await db(`SELECT DISTINCT status, last_error FROM notifications WHERE booking_id = $1`, [id]);
      expect(rows).toEqual([{ status: 'skipped', last_error: 'booking is cancelled' }]);
      expect(ctx.messagingFake!.emails.length).toBe(before);
    } finally {
      ctx.deps.notifier = saved;
      saved!.start();
    }
  });

  it('nothing is sent for an unpaid or failed payment', async () => {
    const res = await player.agent.post('/api/bookings').send({ courtId, startTime: at(tomorrow, 19), endTime: at(tomorrow, 20) });
    const id = res.body.booking.id;
    await player.agent.post(`/api/bookings/${id}/checkout`);
    const [{ checkout_session_id: cs }] = await db('SELECT checkout_session_id FROM transactions WHERE booking_id = $1', [id]);
    await ctx.paymongoFake.pay(cs, 'gcash', 'failed');
    await new Promise((r) => setTimeout(r, 300));
    expect(await db('SELECT 1 FROM notifications WHERE booking_id = $1', [id])).toEqual([]);
  });
});

describe('message content', () => {
  const details = {
    bookingId: '3f2a9c1d-0000-4000-8000-000000000001', courtName: 'Court <1> & "Friends"', courtLocation: null,
    timezone: 'Asia/Manila', startTime: '2099-03-01T10:00:00.000Z', endTime: '2099-03-01T12:00:00.000Z',
    totalAmount: 120000, currency: 'PHP',
  };

  it('escapes court names in HTML email', () => {
    const m = renderMessage('booking_confirmed', details);
    expect(m.html).toContain('Court &lt;1&gt; &amp; &quot;Friends&quot;');
    expect(m.html).not.toContain('<1>');
  });

  it('keeps SMS in plain ASCII within 160 characters, even for long or accented court names', () => {
    const m = renderMessage('booking_received', {
      ...details, courtName: 'Cancha Niño — Paraiso Pickleball Club Premier Indoor Championship Court Number Twelve (Air-conditioned)',
    });
    expect(m.sms.length).toBeLessThanOrEqual(160);
    expect(m.sms).toMatch(/^[\x20-\x7e]+$/);
    expect(m.sms).toContain('Cancha Nino - Paraiso');
    expect(m.sms).toContain('Ref PS-3F2A9C1D');
    expect(m.sms).toContain('6:00 PM-8:00 PM'); // court-local time
  });
});
