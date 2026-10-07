/**
 * Helpers shared by the end-to-end specs: database access for verification,
 * sign-in, calendar navigation and the messaging simulator.
 */
import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import pg from 'pg';
import { APP_URL, DATABASE_URL, DEMO, MESSAGING_URL } from '../env';

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });

/** Runs SQL against the test database as the superuser (for verification only). */
export async function sql<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(text, params)).rows as T[];
}

/** A Manila calendar date (YYYY-MM-DD) `offset` days from today. */
export async function localDate(offset: number): Promise<string> {
  const [r] = await sql<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Asia/Manila')::date + $1::int)::text AS d`, [offset]);
  return r.d;
}

/** Each test gets fresh accounts so runs don't interfere. */
export const uniqueEmail = (tag: string) => `${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@e2e.test`;
export const PASSWORD = 'pickleball123';

/** Creates an account through the sign-up form (the real player path). */
export async function registerViaUi(page: Page, opts: { email: string; phone?: string; role?: 'player' | 'admin' }) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.getByLabel('Email').fill(opts.email);
  await page.getByLabel('Password').fill(PASSWORD);
  if (opts.phone) await page.getByLabel(/Mobile number/).fill(opts.phone);
  if (opts.role === 'admin') await page.getByLabel('Court owner').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/bookings');
}

export async function loginViaUi(page: Page, email: string, password = PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/bookings');
}

/** Signs in through the API on the page's context (shares the session cookie). */
export async function loginViaApi(request: APIRequestContext, email: string, password = PASSWORD) {
  const res = await request.post('/api/auth/login', { data: { email, password } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).user as { id: string; email: string; role: string };
}

export async function registerViaApi(request: APIRequestContext, email: string, role: 'player' | 'admin' = 'player', phone?: string) {
  const res = await request.post('/api/auth/register', { data: { email, password: PASSWORD, role, phone } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).user as { id: string; email: string; role: string };
}

/** A new signed-in browser page for an existing account. */
export async function signedInPage(browser: Browser, email: string) {
  const context = await browser.newContext({ baseURL: APP_URL, timezoneId: 'Asia/Manila' });
  const page = await context.newPage();
  await loginViaUi(page, email);
  return page;
}

/** Search step: pick a date on the calendar and wait for its slots. */
export async function openDate(page: Page, date: string) {
  await page.locator('.slot').first().waitFor();
  await page.getByLabel('Date', { exact: true }).fill(date);
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue(date);
  await page.locator('.slot').first().waitFor();
}

/** A calendar slot button, e.g. slot(page, 'Court 1', '9:00 AM'). Its accessible name ends with its status. */
export const slot = (page: Page, court: string, time: string) =>
  page.getByRole('button', { name: new RegExp(`^${court.replace(/[()]/g, '\\$&')}, ${time} – [^,]+, `) });

/** Select step: open the slot and reserve it; returns the new booking id (now on the checkout page). */
export async function reserve(page: Page, court: string, time: string) {
  await slot(page, court, time).click();
  await page.getByRole('button', { name: /Reserve & continue/ }).click();
  await page.waitForURL('**/bookings/*/checkout');
  return new URL(page.url()).pathname.split('/').at(-2)!;
}

/** Payment step: from checkout, go to the PayMongo hosted page. */
export async function goToPayMongo(page: Page) {
  await page.getByRole('button', { name: /^Pay ₱/ }).click();
  await page.waitForURL(/\/checkout\/cs_/);
  return page.url();
}

export async function bookingRow(id: string) {
  const [b] = await sql(
    `SELECT b.status::text, b.payment_status::text, b.payment_intent_id, b.confirmed_at, b.expires_at, b.total_amount,
            t.status::text AS tx_status, t.amount AS tx_amount, t.payment_method, t.checkout_session_id, t.platform_fee,
            t.provider_fee, t.owner_net
     FROM bookings b LEFT JOIN transactions t ON t.booking_id = b.id WHERE b.id = $1`, [id]);
  return b;
}

/** Makes a hold look 15 minutes old, so the background jobs expire it now (instead of waiting). */
export async function fastForwardHold(id: string) {
  await sql(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
}

// ---------------------------------------------------------------------------
// SendGrid / Twilio simulator

export interface Sent {
  emails: { to: string; subject: string; text: string; customArgs: Record<string, string>; receivedAt: number }[];
  sms: { to: string; body: string; receivedAt: number }[];
}

export async function sentMessages(): Promise<Sent> {
  return (await fetch(`${MESSAGING_URL}/_sent`)).json() as Promise<Sent>;
}

export async function messagesFor(address: string) {
  const s = await sentMessages();
  return { emails: s.emails.filter((e) => e.to === address), sms: s.sms.filter((m) => m.to === address) };
}

/** Makes the simulated providers answer with errors (or recover). */
export async function controlMessaging(state: Partial<{ sendgridStatus: number; twilioStatus: number; twilioErrorCode: number; delayMs: number }>) {
  const res = await fetch(`${MESSAGING_URL}/_control`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state),
  });
  return res.json();
}

export const resetMessaging = () => controlMessaging({ sendgridStatus: 202, twilioStatus: 201, delayMs: 0 });

export { DEMO };

/** Runs one statement as the application's restricted database role, as a given user (row-level security applies). */
export async function sqlAsApp(userId: string, text: string, params: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
    await client.query('SET LOCAL ROLE picksched_app');
    const res = await client.query(text, params);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Collects Content-Security-Policy violations reported by the browser on this page. */
export function watchCspViolations(page: Page) {
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
  });
  page.on('pageerror', (err) => {
    if (/Content Security Policy/i.test(err.message)) violations.push(err.message);
  });
  return violations;
}
