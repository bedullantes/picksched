/**
 * QA-06 SMS/email on booking state change, and delivery failures:
 * invalid contact details, a rejected phone number, a provider outage.
 * Notifications never block or undo a confirmed booking.
 */
import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test';
import { APP_URL } from '../env';
import {
  bookingRow, controlMessaging, fastForwardHold, localDate, messagesFor, registerViaApi, resetMessaging, sql, uniqueEmail,
} from './support';

const at = (date: string, h: number) => `${date}T${String(h).padStart(2, '0')}:00:00+08:00`;
let date: string;
let courtId: string;
const contexts: APIRequestContext[] = [];

async function player(phone?: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: APP_URL });
  contexts.push(ctx);
  const email = uniqueEmail('notify');
  await registerViaApi(ctx, email, 'player', phone);
  return { ctx, email };
}

async function reserveAndPay(ctx: APIRequestContext, h: number, pay = true) {
  const res = await ctx.post('/api/bookings', { data: { courtId, startTime: at(date, h), endTime: at(date, h + 1) } });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).booking.id as string;
  const { payment } = await (await ctx.post(`/api/bookings/${id}/checkout`)).json();
  if (pay) await fetch(payment.checkoutUrl, { method: 'POST', body: new URLSearchParams({ action: 'gcash:paid' }), redirect: 'manual' });
  return id;
}

const notificationRows = (bookingId: string) => sql(
  `SELECT n.kind, n.channel, n.status, n.attempts, n.recipient_address, n.last_error, u.email
   FROM notifications n JOIN users u ON u.id = n.recipient_id WHERE n.booking_id = $1 ORDER BY n.kind, n.channel`, [bookingId]);

test.beforeAll(async () => {
  date = await localDate(7);
  [{ id: courtId }] = await sql(`SELECT id FROM courts WHERE name = 'Court 3 (Outdoor)'`);
});
test.afterEach(resetMessaging);
test.afterAll(async () => {
  await Promise.all(contexts.map((c) => c.dispose()));
});

test('nothing is sent while a booking is pending, failed or expired; only confirmation triggers messages', async () => {
  const { ctx, email } = await player('09175550111');
  const id = await reserveAndPay(ctx, 7, false);
  await fastForwardHold(id);
  await expect.poll(async () => (await bookingRow(id)).status, { timeout: 15_000 }).toBe('cancelled');
  await new Promise((r) => setTimeout(r, 2000)); // a couple of dispatcher cycles
  expect(await notificationRows(id)).toEqual([]);
  const sent = await messagesFor(email);
  expect(sent.emails.length + (await messagesFor('+639175550111')).sms.length).toBe(0);
});

test('confirmation sends email + SMS to the player and an alert to the owner, each once', async () => {
  const { ctx, email } = await player('0917-555-0112');
  const t0 = Date.now();
  const id = await reserveAndPay(ctx, 8);
  await expect.poll(async () => (await notificationRows(id)).every((n) => n.status === 'sent'), { timeout: 120_000 }).toBe(true);
  const rows = await notificationRows(id);
  expect(rows.map((r) => `${r.kind}/${r.channel}/${r.email === email ? 'player' : 'owner'}`)).toEqual([
    'booking_confirmed/email/player', 'booking_confirmed/sms/player', 'booking_received/email/owner',
  ]);
  const { emails } = await messagesFor(email);
  const { sms } = await messagesFor('+639175550112');
  expect(emails).toHaveLength(1);
  expect(sms).toHaveLength(1);
  expect(emails[0].receivedAt - t0).toBeLessThan(120_000);
  expect(sms[0].receivedAt - t0).toBeLessThan(120_000);
  for (const field of ['Court 3 (Outdoor)', 'Booking reference']) expect(emails[0].text).toContain(field);
  // A second (duplicate) webhook delivery doesn't send again.
  await new Promise((r) => setTimeout(r, 2000));
  expect((await messagesFor(email)).emails).toHaveLength(1);
});

test('invalid contact details are rejected when entered', async () => {
  const anon = await playwrightRequest.newContext({ baseURL: APP_URL });
  contexts.push(anon);
  const badPhone = await anon.post('/api/auth/register', { data: { email: uniqueEmail('badphone'), password: 'pickleball123', phone: '12345' } });
  expect(badPhone.status()).toBe(400);
  expect((await badPhone.json()).error.code).toBe('INVALID_PHONE');
  const badEmail = await anon.post('/api/auth/register', { data: { email: 'not-an-email', password: 'pickleball123' } });
  expect(badEmail.status()).toBe(400);
  const { ctx } = await player();
  const patch = await ctx.patch('/api/auth/me', { data: { phone: 'call me maybe' } });
  expect(patch.status()).toBe(400);
});

test('an undeliverable phone number fails the SMS only: email still sent, booking stays confirmed', async () => {
  await controlMessaging({ twilioStatus: 400, twilioErrorCode: 21211 });
  const { ctx, email } = await player('09175550113');
  const id = await reserveAndPay(ctx, 9);
  await expect.poll(async () => (await bookingRow(id)).status).toBe('confirmed');
  await expect.poll(async () => {
    const rows = await notificationRows(id);
    return rows.map((r) => `${r.channel}:${r.status}`).sort().join(',');
  }, { timeout: 120_000 }).toBe('email:sent,email:sent,sms:failed');
  const smsRow = (await notificationRows(id)).find((r) => r.channel === 'sms')!;
  expect(smsRow.attempts).toBe(1); // a rejected number is not retried
  expect(smsRow.last_error).toMatch(/21211|not a valid phone/i);
  expect((await messagesFor(email)).emails).toHaveLength(1);
  expect(await bookingRow(id)).toMatchObject({ status: 'confirmed', payment_status: 'paid' });
});

test('an email that the provider rejects is marked failed without affecting the booking', async () => {
  await controlMessaging({ sendgridStatus: 400 });
  const { ctx } = await player();
  const id = await reserveAndPay(ctx, 10);
  await expect.poll(async () => (await notificationRows(id)).filter((r) => r.status === 'failed').length, { timeout: 120_000 }).toBe(2);
  expect(await bookingRow(id)).toMatchObject({ status: 'confirmed', payment_status: 'paid' });
});

test('a provider outage is retried and the message still arrives within 2 minutes', async () => {
  await controlMessaging({ sendgridStatus: 503 });
  const { ctx, email } = await player();
  const t0 = Date.now();
  const id = await reserveAndPay(ctx, 11);
  await expect.poll(async () => (await notificationRows(id)).find((r) => r.email === email)?.attempts ?? 0, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  expect((await notificationRows(id)).find((r) => r.email === email)?.status).toBe('pending');
  expect((await bookingRow(id)).status).toBe('confirmed'); // confirmed regardless of the outage
  await controlMessaging({ sendgridStatus: 202 }); // provider recovers
  await expect.poll(async () => (await messagesFor(email)).emails.length, { timeout: 120_000 }).toBe(1);
  const [{ receivedAt }] = (await messagesFor(email)).emails;
  expect(receivedAt - t0).toBeLessThan(120_000);
  const row = (await notificationRows(id)).find((r) => r.email === email)!;
  expect(row.status).toBe('sent');
  expect(row.attempts).toBeGreaterThanOrEqual(2);
});
