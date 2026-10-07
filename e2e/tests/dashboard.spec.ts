/**
 * QA-05a Dashboard in real time: an owner's dashboard reflects paid bookings
 * as they happen, and unpaid holds are not counted.
 * (QA-05b, the reconciliation against the transaction log, is reconciliation.spec.ts.)
 */
import { expect, request as playwrightRequest, test, type APIRequestContext, type Page } from '@playwright/test';
import { APP_URL } from '../env';
import { bookingRow, localDate, loginViaUi, registerViaApi, sql, uniqueEmail } from './support';

const at = (date: string, h: number) => `${date}T${String(h).padStart(2, '0')}:00:00+08:00`;
const tile = (page: Page, label: string) => page.locator('.stat-tile', { has: page.locator('.stat-label', { hasText: new RegExp(`^${label}$`) }) });

async function book(player: APIRequestContext, courtId: string, date: string, h: number, len: number, pay: boolean) {
  const res = await player.post('/api/bookings', { data: { courtId, startTime: at(date, h), endTime: at(date, h + len) } });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).booking.id as string;
  const checkout = await (await player.post(`/api/bookings/${id}/checkout`)).json();
  if (pay) {
    await fetch(checkout.payment.checkoutUrl, { method: 'POST', body: new URLSearchParams({ action: 'gcash:paid' }), redirect: 'manual' });
    await expect.poll(async () => (await bookingRow(id)).status).toBe('confirmed');
  }
  return id;
}

let ownerEmail: string;
let owner: APIRequestContext;
let player: APIRequestContext;
let courts: string[];
let in4: string;

test.beforeAll(async () => {
  ownerEmail = uniqueEmail('dash-owner');
  owner = await playwrightRequest.newContext({ baseURL: APP_URL });
  await registerViaApi(owner, ownerEmail, 'admin');
  const [{ id: ownerId }] = await sql(`SELECT id FROM users WHERE email = $1`, [ownerEmail]);
  // Courts are provisioned directly (there's no court-management screen yet); added 60 days ago.
  courts = [];
  for (const name of ['QA Court A', 'QA Court B']) {
    const [c] = await sql(
      `INSERT INTO courts (owner_id, name, hourly_rate, created_at) VALUES ($1, $2, 50000, now() - interval '60 days') RETURNING id`,
      [ownerId, name]);
    courts.push(c.id);
  }
  player = await playwrightRequest.newContext({ baseURL: APP_URL });
  await registerViaApi(player, uniqueEmail('dash-player'));
  in4 = await localDate(4);
});
test.afterAll(async () => {
  await owner?.dispose();
  await player?.dispose();
});

test('the dashboard updates in real time when a payment confirms a booking', async ({ page }) => {
  await loginViaUi(page, ownerEmail);
  await page.goto('/dashboard');
  await expect(tile(page, 'Bookings, next 7 days').locator('.stat-value')).toHaveText('0');
  await expect(tile(page, 'Revenue').locator('.stat-value')).toHaveText(/^₱0(\.00)?$/);

  // An unpaid hold is not counted.
  await book(player, courts[0], in4, 8, 1, false);
  await page.waitForTimeout(1500);
  await expect(tile(page, 'Bookings, next 7 days').locator('.stat-value')).toHaveText('0');

  // A paid 2-hour booking appears without reloading the page.
  await book(player, courts[0], in4, 10, 2, true);
  await expect(tile(page, 'Bookings, next 7 days').locator('.stat-value')).toHaveText('1');
  await expect(tile(page, 'Occupancy, next 7 days').locator('.stat-detail')).toHaveText('2 of 224 court-hours booked');
  await expect(tile(page, 'Revenue').locator('.stat-value')).toHaveText(/^₱1,000(\.00)?$/); // paid today, 2h x ₱500

  await book(player, courts[1], in4, 18, 1, true);
  await expect(tile(page, 'Bookings, next 7 days').locator('.stat-value')).toHaveText('2');
  await expect(tile(page, 'Occupancy, next 7 days').locator('.stat-detail')).toHaveText('3 of 224 court-hours booked');
  await expect(tile(page, 'Revenue').locator('.stat-value')).toHaveText(/^₱1,500(\.00)?$/);
});
