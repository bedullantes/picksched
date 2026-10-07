/**
 * QA-02 PayMongo success and failure paths, including an interrupted payment
 * session (browser closed during the PayMongo redirect) and an abandoned one.
 */
import { expect, test, type Page } from '@playwright/test';
import { APP_URL, PAYMONGO_URL, SECRETS } from '../env';
import {
  bookingRow, fastForwardHold, goToPayMongo, localDate, messagesFor, openDate, registerViaUi, reserve, signedInPage,
  slot, sql, uniqueEmail,
} from './support';

let date: string;
test.beforeAll(async () => {
  date = await localDate(3);
});

async function newPlayer(page: Page, tag: string) {
  const email = uniqueEmail(tag);
  await registerViaUi(page, { email });
  await openDate(page, date);
  return email;
}

async function paymongoSession(id: string) {
  const res = await fetch(`${PAYMONGO_URL}/v1/checkout_sessions/${id}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${SECRETS.paymongoKey}:`).toString('base64')}` },
  });
  return (await res.json()).data.attributes as { status: string; payments: unknown[] };
}

test('a declined payment shows "Payment failed" and a retry with Maya succeeds', async ({ page }) => {
  const email = await newPlayer(page, 'declined');
  const id = await reserve(page, 'Court 1', '9:00 AM');
  const firstUrl = await goToPayMongo(page);

  await page.getByRole('button', { name: 'Simulate a declined payment' }).click();
  await expect(page.getByText('Your last payment attempt failed')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel and return to merchant' }).click();
  await page.waitForURL(`**/bookings/${id}/payment?result=cancelled`);
  await expect(page.getByRole('heading', { name: 'Payment failed' })).toBeVisible();
  await expect(page.getByText(/haven't been charged/)).toBeVisible();

  let b = await bookingRow(id);
  expect(b).toMatchObject({ status: 'pending_payment', payment_status: 'failed', tx_status: 'failed' });
  expect(b.confirmed_at).toBeNull();
  expect((await messagesFor(email)).emails).toHaveLength(0); // nothing sent for a failure

  await page.getByRole('link', { name: 'Try again' }).click();
  const retryUrl = await goToPayMongo(page);
  expect(retryUrl).toBe(firstUrl); // the same PayMongo session is reused
  await page.getByRole('button', { name: 'Pay with Maya' }).click();
  await expect(page.getByRole('heading', { name: 'Payment successful' })).toBeVisible();

  b = await bookingRow(id);
  expect(b).toMatchObject({ status: 'confirmed', payment_status: 'paid', tx_status: 'paid', payment_method: 'paymaya' });
  const [{ n }] = await sql(`SELECT count(*)::int AS n FROM transactions WHERE booking_id = $1`, [id]);
  expect(n).toBe(1); // one transaction per booking, updated in place
  await expect.poll(async () => (await messagesFor(email)).emails.length, { timeout: 120_000 }).toBe(1);
});

test('leaving PayMongo without paying keeps the hold; releasing it frees the slot', async ({ page }) => {
  await newPlayer(page, 'cancelled');
  const id = await reserve(page, 'Court 2', '9:00 AM');
  await goToPayMongo(page);
  await page.getByRole('button', { name: 'Cancel and return to merchant' }).click();
  await page.waitForURL(`**/bookings/${id}/payment?result=cancelled`);
  await expect(page.getByRole('heading', { name: 'Payment not completed' })).toBeVisible();
  await expect(page.getByText(/Your slot is held for another/)).toBeVisible();
  expect((await bookingRow(id)).status).toBe('pending_payment');

  await page.getByRole('button', { name: 'Release slot' }).click();
  await expect.poll(async () => (await bookingRow(id)).status).toBe('cancelled');
  await page.goto('/bookings');
  await openDate(page, date);
  await expect(slot(page, 'Court 2', '9:00 AM')).toHaveAccessibleName(/Available/);
});

test('interrupted session: browser closed on PayMongo, the player resumes the same checkout', async ({ browser, page }) => {
  const email = await newPlayer(page, 'interrupted');
  const id = await reserve(page, 'Court 3 (Outdoor)', '9:00 AM');
  const payUrl = await goToPayMongo(page);
  await page.context().close(); // the browser is closed mid-redirect

  // The hold survives: still pending, slot not given to anyone else.
  const held = await bookingRow(id);
  expect(held.status).toBe('pending_payment');
  expect(new Date(held.expires_at).getTime()).toBeGreaterThan(Date.now());

  // The player comes back (new browser session) and finishes paying.
  const again = await signedInPage(browser, email);
  await again.goto(`/bookings/${id}/checkout`);
  const resumedUrl = await goToPayMongo(again);
  expect(resumedUrl).toBe(payUrl);
  await again.getByRole('button', { name: 'Pay with GCash' }).click();
  await expect(again.getByRole('heading', { name: 'Payment successful' })).toBeVisible();
  expect(await bookingRow(id)).toMatchObject({ status: 'confirmed', payment_status: 'paid' });
  await again.context().close();
});

test('interrupted after paying: the webhook confirms even though the player never returns', async ({ page }) => {
  const email = await newPlayer(page, 'paid-no-return');
  const id = await reserve(page, 'Court 1', '11:00 AM');
  await goToPayMongo(page);
  // The redirect back to the app never completes (tab closed / network lost).
  await page.route(`${APP_URL}/bookings/**`, (route) => route.abort());
  await page.getByRole('button', { name: 'Pay with GCash' }).click().catch(() => {});
  await page.context().close();

  await expect.poll(async () => (await bookingRow(id)).status, { timeout: 15_000 }).toBe('confirmed');
  expect(await bookingRow(id)).toMatchObject({ payment_status: 'paid', tx_status: 'paid' });
  await expect.poll(async () => (await messagesFor(email)).emails.length, { timeout: 120_000 }).toBe(1);
});

test('abandoned payment: the hold expires after 15 minutes and the slot is released', async ({ browser, page }) => {
  const email = await newPlayer(page, 'abandoned');
  const id = await reserve(page, 'Court 2', '11:00 AM');
  const payUrl = await goToPayMongo(page);
  const csId = payUrl.split('/').at(-1)!;

  const held = await bookingRow(id);
  const holdMinutes = (new Date(held.expires_at).getTime() - Date.now()) / 60_000;
  expect(holdMinutes).toBeGreaterThan(13); // the hold lasts 15 minutes from reservation
  expect(holdMinutes).toBeLessThanOrEqual(15);

  await fastForwardHold(id); // as if 15 minutes passed
  await expect.poll(async () => (await bookingRow(id)).status, { timeout: 15_000 }).toBe('cancelled');
  await expect.poll(async () => (await paymongoSession(csId)).status, { timeout: 15_000 }).toBe('expired');
  expect((await bookingRow(id)).payment_status).not.toBe('paid');

  // PayMongo no longer accepts payment for it.
  await page.goto(payUrl);
  await expect(page.getByText('This checkout session has expired.')).toBeVisible();
  // Returning to the app shows the slot was released.
  await page.goto(`/bookings/${id}/payment?result=success`);
  await expect(page.getByRole('heading', { name: 'Payment not completed' })).toBeVisible();
  await expect(page.getByText(/so the slot was released/)).toBeVisible();

  // Someone else can now book it, and the first player got no confirmation.
  const other = await browser.newPage({ baseURL: APP_URL });
  await registerViaUi(other, { email: uniqueEmail('after-abandon') });
  await openDate(other, date);
  await expect(slot(other, 'Court 2', '11:00 AM')).toHaveAccessibleName(/Available/);
  expect((await messagesFor(email)).emails).toHaveLength(0);
  await other.close();
});
