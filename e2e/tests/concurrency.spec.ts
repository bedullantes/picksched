/**
 * QA-04 Concurrent double-booking: two players (and a burst of API requests)
 * going for the same slot. Exactly one reservation may succeed.
 */
import { expect, request as playwrightRequest, test } from '@playwright/test';
import { APP_URL } from '../env';
import { localDate, openDate, registerViaApi, registerViaUi, slot, sql, uniqueEmail } from './support';

const at = (date: string, h: number) => `${date}T${String(h).padStart(2, '0')}:00:00+08:00`;

test('two players reserving the same slot at the same moment: one wins, the other is told it was taken', async ({ browser }) => {
  const date = await localDate(5);
  const pages = await Promise.all([0, 1].map(async (i) => {
    const page = await browser.newPage({ baseURL: APP_URL });
    await registerViaUi(page, { email: uniqueEmail(`race-${i}`) });
    await openDate(page, date);
    await slot(page, 'Court 1', '3:00 PM').click();
    await expect(page.getByRole('button', { name: /Reserve & continue/ })).toBeEnabled();
    return page;
  }));

  // Both click "Reserve" together.
  await Promise.all(pages.map((p) => p.getByRole('button', { name: /Reserve & continue/ }).click()));

  const outcomes = await Promise.all(pages.map(async (p) => {
    const won = p.waitForURL('**/bookings/*/checkout', { timeout: 10_000 }).then(() => 'reserved');
    const lost = p.getByText(/no longer available|just taken by someone else/).first().waitFor({ timeout: 10_000 }).then(() => 'rejected');
    return Promise.any([won, lost]);
  }));
  expect(outcomes.sort()).toEqual(['rejected', 'reserved']);

  const rows = await sql(
    `SELECT status::text FROM bookings b JOIN courts c ON c.id = b.court_id
     WHERE c.name = 'Court 1' AND b.start_time = $1::timestamptz AND b.status <> 'cancelled'`, [at(date, 15)]);
  expect(rows).toEqual([{ status: 'pending_payment' }]);
  await Promise.all(pages.map((p) => p.close()));
});

test('a burst of 10 simultaneous API reservations for one slot yields exactly one booking', async () => {
  const date = await localDate(5);
  const [{ id: courtId }] = await sql(`SELECT id FROM courts WHERE name = 'Court 2'`);
  const players = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
    const ctx = await playwrightRequest.newContext({ baseURL: APP_URL });
    await registerViaApi(ctx, uniqueEmail(`burst-${i}`));
    return ctx;
  }));
  const results = await Promise.all(players.map((p) =>
    p.post('/api/bookings', { data: { courtId, startTime: at(date, 16), endTime: at(date, 18) } })));
  const statuses = results.map((r) => r.status()).sort();
  expect(statuses).toEqual([201, ...Array(9).fill(409)]);
  for (const r of results.filter((x) => x.status() === 409)) {
    expect((await r.json()).error.code).toBe('SLOT_UNAVAILABLE');
  }
  // Overlapping (not identical) ranges are rejected too.
  const overlap = await players[0].post('/api/bookings', { data: { courtId, startTime: at(date, 17), endTime: at(date, 19) } });
  expect(overlap.status()).toBe(409);
  const [{ n }] = await sql(
    `SELECT count(*)::int AS n FROM bookings WHERE court_id = $1 AND status <> 'cancelled'
       AND tstzrange(start_time, end_time) && tstzrange($2::timestamptz, $3::timestamptz)`, [courtId, at(date, 16), at(date, 19)]);
  expect(n).toBe(1);
  await Promise.all(players.map((p) => p.dispose()));
});
