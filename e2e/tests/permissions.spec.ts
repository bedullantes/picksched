/**
 * QA-03 Role-based access control. Owners (role "admin") have full access to
 * their facility; players are limited to booking endpoints and their own
 * history. Owners still can't bypass the booking and payment rules.
 */
import { createHmac } from 'node:crypto';
import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test';
import { APP_URL } from '../env';
import {
  bookingRow, DEMO, localDate, sqlAsApp, loginViaApi, loginViaUi, openDate, registerViaApi, registerViaUi, sql, uniqueEmail,
} from './support';

const at = (date: string, h: number) => `${date}T${String(h).padStart(2, '0')}:00:00+08:00`;
const contexts: APIRequestContext[] = [];
async function apiAs(email?: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: APP_URL });
  contexts.push(ctx);
  if (email) await loginViaApi(ctx, email);
  return ctx;
}
test.afterAll(async () => {
  await Promise.all(contexts.map((c) => c.dispose()));
});

let date: string;
let court1: string;
let pendingId: string; // player A's booking, in checkout
let confirmedId: string; // player A's paid booking
let playerA: string;
let playerB: string;

test.beforeAll(async () => {
  date = await localDate(6);
  // A dedicated court on the demo facility, so a re-run of this setup never collides with earlier bookings.
  const [{ id: ownerId }] = await sql(`SELECT id FROM users WHERE email = $1`, [DEMO.owner]);
  [{ id: court1 }] = await sql(
    `INSERT INTO courts (owner_id, name, hourly_rate) VALUES ($1, $2, 40000) RETURNING id`,
    [ownerId, `RBAC court ${Date.now().toString(36)}`]);
  playerA = uniqueEmail('rbac-a');
  playerB = uniqueEmail('rbac-b');
  const a = await apiAs();
  await registerViaApi(a, playerA);
  const b = await apiAs();
  await registerViaApi(b, playerB);

  const reserve = async (h: number) => {
    const res = await a.post('/api/bookings', { data: { courtId: court1, startTime: at(date, h), endTime: at(date, h + 1) } });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()).booking.id as string;
  };
  pendingId = await reserve(9);
  expect((await a.post(`/api/bookings/${pendingId}/checkout`)).status()).toBe(200);
  confirmedId = await reserve(11);
  const pay = await a.post(`/api/bookings/${confirmedId}/checkout`);
  const { payment } = await pay.json();
  // Pay on the PayMongo simulator's hosted page (no redirect following needed).
  await fetch(payment.checkoutUrl, { method: 'POST', body: new URLSearchParams({ action: 'gcash:paid' }), redirect: 'manual' });
  await expect.poll(async () => (await bookingRow(confirmedId)).status).toBe('confirmed');
});

test.describe('signed-out visitors', () => {
  test('are sent to sign-in from every app page', async ({ page }) => {
    for (const path of ['/dashboard', '/bookings', '/account', `/bookings/${pendingId}/checkout`]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
    }
  });

  test('get 401 from every protected API', async () => {
    const anon = await apiAs();
    const calls: [string, string][] = [
      ['GET', '/api/dashboard'], ['GET', '/api/auth/me'], ['POST', '/api/bookings'], ['GET', `/api/bookings/${pendingId}`],
      ['POST', `/api/bookings/${pendingId}/checkout`], ['POST', `/api/bookings/${pendingId}/cancel`],
      ['POST', `/api/bookings/${pendingId}/confirm`], ['GET', '/api/maintenance-blocks'], ['GET', '/api/notifications'],
      ['GET', '/api/events'], ['GET', '/api/availability?mine=1&start=' + date],
    ];
    for (const [method, url] of calls) {
      const res = await anon.fetch(url, { method, data: method === 'POST' ? {} : undefined });
      expect([401, 403], `${method} ${url}`).toContain(res.status());
    }
  });

  test('can browse courts and open slots, but see no personal data', async () => {
    const anon = await apiAs();
    const res = await anon.get(`/api/availability?start=${date}&days=1`);
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(playerA);
    expect(text).not.toContain('@');
    expect(text).not.toContain(pendingId);
    expect(await (await anon.get('/api/courts?mine=1')).json()).toEqual({ courts: [] });
  });
});

test.describe('players', () => {
  test('cannot open the dashboard and don\'t see it in the menu', async ({ page }) => {
    await loginViaUi(page, playerB);
    await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/unauthorized$/);
    await expect(page.getByRole('heading', { name: "You don't have access to this page" })).toBeVisible();
  });

  test('get 403 from analytics and owner-only endpoints', async () => {
    const p = await apiAs(playerB);
    const forbidden: [string, string, unknown?][] = [
      ['GET', '/api/dashboard'],
      ['GET', `/api/dashboard?start=${date}&end=${date}`],
      ['GET', `/api/availability?mine=1&start=${date}`],
      ['GET', '/api/maintenance-blocks'],
      ['POST', '/api/maintenance-blocks', { courtId: court1, startTime: at(date, 15), endTime: at(date, 16) }],
      ['POST', `/api/bookings/${pendingId}/confirm`],
      ['PATCH', `/api/bookings/${confirmedId}`, { startTime: at(date, 14), endTime: at(date, 15) }],
    ];
    for (const [method, url, data] of forbidden) {
      const res = await p.fetch(url, { method, data });
      expect(res.status(), `${method} ${url}`).toBe(403);
      expect((await res.json()).error.code).toBe('FORBIDDEN');
    }
  });

  test("can't see, pay for or cancel another player's booking", async () => {
    const p = await apiAs(playerB);
    expect((await p.get(`/api/bookings/${pendingId}`)).status()).toBe(404);
    expect([403, 404]).toContain((await p.post(`/api/bookings/${pendingId}/checkout`)).status());
    expect([403, 404]).toContain((await p.post(`/api/bookings/${pendingId}/cancel`)).status());
    expect([403, 404]).toContain((await p.post(`/api/bookings/${pendingId}/payment/verify`)).status());
    expect((await bookingRow(pendingId)).status).toBe('pending_payment');
  });

  test('see only their own notifications and booking details', async () => {
    const a = await apiAs(playerA);
    const own = await a.get(`/api/bookings/${confirmedId}`);
    expect(own.status()).toBe(200);
    expect((await own.json()).booking.isMine).toBe(true);
    const b = await apiAs(playerB);
    const theirs = await (await b.get('/api/notifications')).json();
    const all = JSON.stringify(theirs);
    expect(all).not.toContain(confirmedId);
  });

  test("calendar doesn't reveal other players' identities", async () => {
    const b = await apiAs(playerB);
    const res = await b.get(`/api/availability?start=${date}&days=1`);
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(playerA);
  });

  test('cannot register themselves as something other than player or owner', async () => {
    const anon = await apiAs();
    const res = await anon.post('/api/auth/register', { data: { email: uniqueEmail('x'), password: 'pickleball123', role: 'superadmin' } });
    expect(res.status()).toBe(400);
  });
});

test.describe('court owners', () => {
  test('have the dashboard and the full facility schedule', async ({ page }) => {
    await loginViaUi(page, DEMO.owner);
    await page.getByRole('link', { name: 'Dashboard' }).first().click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    const o = await apiAs(DEMO.owner);
    expect((await o.get('/api/dashboard')).status()).toBe(200);
    const sched = await o.get(`/api/availability?start=${date}&days=1&mine=1`);
    expect(sched.status()).toBe(200);
    expect(await sched.text()).toContain(playerA); // owners see who booked
    expect((await o.get('/api/maintenance-blocks')).status()).toBe(200);
  });

  test("can't confirm, move or cancel a booking that is in checkout", async () => {
    const o = await apiAs(DEMO.owner);
    const confirm = await o.post(`/api/bookings/${pendingId}/confirm`);
    expect(confirm.status()).toBe(409);
    expect((await confirm.json()).error.code).toBe('BOOKING_IN_CHECKOUT');
    const move = await o.patch(`/api/bookings/${pendingId}`, { data: { startTime: at(date, 13), endTime: at(date, 14) } });
    expect(move.status()).toBe(409);
    const cancel = await o.post(`/api/bookings/${pendingId}/cancel`);
    expect(cancel.status()).toBe(409);
    expect(await bookingRow(pendingId)).toMatchObject({ status: 'pending_payment', payment_status: 'processing' });
  });

  test("can't pay for a player's booking on their behalf", async () => {
    const o = await apiAs(DEMO.owner);
    const pay = await o.post(`/api/bookings/${pendingId}/checkout`);
    expect(pay.status()).toBe(403);
    expect((await bookingRow(pendingId)).status).toBe('pending_payment');
  });

  test("can't move a booking onto a slot that's already held", async () => {
    const o = await apiAs(DEMO.owner);
    const move = await o.patch(`/api/bookings/${confirmedId}`, { data: { startTime: at(date, 9), endTime: at(date, 10) } });
    expect(move.status()).toBe(409); // overlaps player A's pending hold
    expect((await move.json()).error.code).toBe('SLOT_UNAVAILABLE');
    expect((await bookingRow(confirmedId)).status).toBe('confirmed');
  });

  test("another owner can't see or change this facility's bookings or analytics", async () => {
    const rival = uniqueEmail('rival-owner');
    const r = await apiAs();
    await registerViaApi(r, rival, 'admin');
    expect((await r.get(`/api/bookings/${confirmedId}`)).status()).toBe(404);
    expect([403, 404]).toContain((await r.post(`/api/bookings/${confirmedId}/cancel`)).status());
    expect([403, 404]).toContain((await r.patch(`/api/bookings/${confirmedId}`, { data: { startTime: at(date, 15), endTime: at(date, 16) } })).status());
    const dash = await (await r.get('/api/dashboard')).json();
    expect(dash.courts).toEqual({ registered: 0, active: 0 });
    expect((await bookingRow(confirmedId)).status).toBe('confirmed');
  });
});

test.describe('payment confirmation can only come from PayMongo', () => {
  test('a forged or unsigned webhook is rejected and changes nothing', async () => {
    const [{ checkout_session_id: cs }] = await sql(`SELECT checkout_session_id FROM transactions WHERE booking_id = $1`, [pendingId]);
    const body = JSON.stringify({
      data: { id: 'evt_forged', type: 'event', attributes: {
        type: 'checkout_session.payment.paid', livemode: false,
        data: { id: cs, type: 'checkout_session', attributes: { status: 'active', payments: [{ id: 'pay_forged', attributes: { status: 'paid', amount: 1, source: { type: 'gcash' } } }] } },
      } },
    });
    const t = Math.floor(Date.now() / 1000);
    const forged = createHmac('sha256', 'not-the-real-secret').update(`${t}.${body}`).digest('hex');
    const anon = await apiAs();
    for (const headers of [{}, { 'Paymongo-Signature': `t=${t},te=${forged},li=` }] as Record<string, string>[]) {
      const res = await anon.post('/api/webhooks/paymongo', { headers: { 'content-type': 'application/json', ...headers }, data: body });
      expect(res.status()).toBe(401);
    }
    expect(await bookingRow(pendingId)).toMatchObject({ status: 'pending_payment', payment_status: 'processing' });
  });

  test('returning to the success URL without paying does not confirm', async ({ page }) => {
    await loginViaUi(page, playerA);
    await page.goto(`/bookings/${pendingId}/payment?result=success`);
    await expect(page.getByRole('heading', { name: /Processing payment|Still confirming your payment|Payment not completed/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Payment successful' })).toHaveCount(0);
    expect((await bookingRow(pendingId)).status).toBe('pending_payment');
  });

  test("the app's database role can't mark a booking paid directly, even for the court owner", async () => {
    const [{ id: ownerId }] = await sql(`SELECT id FROM users WHERE email = $1`, [DEMO.owner]);
    const [{ id: playerId }] = await sql(`SELECT id FROM users WHERE email = $1`, [playerA]);
    for (const who of [ownerId, playerId]) {
      const outcome = await sqlAsApp(who,
        `UPDATE bookings SET status = 'confirmed', payment_status = 'paid' WHERE id = $1`, [pendingId])
        .then((r) => `updated ${r.rowCount}`, (e) => `refused ${e.code}`);
      expect(outcome, who === ownerId ? 'owner' : 'player').toMatch(/^refused|^updated 0$/);
    }
    expect(await bookingRow(pendingId)).toMatchObject({ status: 'pending_payment', payment_status: 'processing' });
  });
});

test('players booking via the UI never see owner controls', async ({ page }) => {
  await registerViaUi(page, { email: uniqueEmail('ui-player') });
  await openDate(page, date);
  await expect(page.getByRole('heading', { name: 'Book a court' })).toBeVisible();
  await expect(page.getByText('Block time')).toHaveCount(0);
});
