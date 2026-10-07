/**
 * QA-05b Dashboard occupancy and revenue vs. the bookings and transaction logs.
 *
 * Runs after every other spec (see the "reconciliation" project), so the demo
 * facility's data includes all bookings and payments the suite just made.
 * Figures are recomputed here independently of the app's SQL and compared
 * with GET /api/dashboard; the result is saved to
 * test-results/dashboard-reconciliation.json for the QA report.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test';
import { APP_URL, DEMO } from '../env';
import { localDate, loginViaApi, sql } from './support';

/**
 * Independent reconciliation for one owner over [start, end]: per local day,
 * booked hours from confirmed bookings and revenue from paid transactions,
 * compared with what GET /api/dashboard reports.
 */
async function reconcile(owner: APIRequestContext, ownerEmail: string, start: string, end: string) {
  const dash = await (await owner.get(`/api/dashboard?start=${start}&end=${end}`)).json();
  const [{ id: ownerId }] = await sql(`SELECT id FROM users WHERE email = $1`, [ownerEmail]);
  const expected = await sql(
    `WITH days AS (SELECT d::date AS day FROM generate_series($2::date, $3::date, interval '1 day') d),
     c AS (SELECT * FROM courts WHERE owner_id = $1),
     cap AS (
       SELECT d.day, count(*) AS courts, sum(extract(epoch FROM c.closes_at - c.opens_at) / 3600) AS hours
       FROM days d JOIN c ON c.is_active AND (c.created_at AT TIME ZONE c.timezone)::date <= d.day GROUP BY d.day),
     blocks AS (
       SELECT (cb.start_time AT TIME ZONE c.timezone)::date AS day, sum(extract(epoch FROM cb.end_time - cb.start_time) / 3600) AS hours
       FROM court_blocks cb JOIN c ON c.id = cb.court_id AND c.is_active GROUP BY 1),
     booked AS (
       SELECT (b.start_time AT TIME ZONE c.timezone)::date AS day, count(*) AS n,
              sum(extract(epoch FROM b.end_time - b.start_time) / 3600) AS hours
       FROM bookings b JOIN c ON c.id = b.court_id WHERE b.status = 'confirmed' GROUP BY 1),
     paid AS (
       SELECT (t.processed_at AT TIME ZONE c.timezone)::date AS day, count(*) AS n, sum(t.amount) AS gross,
              sum(COALESCE(t.owner_net, t.amount)) AS net
       FROM transactions t JOIN bookings b ON b.id = t.booking_id JOIN c ON c.id = b.court_id
       WHERE t.status = 'paid' GROUP BY 1)
     SELECT d.day::text AS date,
            COALESCE(booked.n, 0)::int AS bookings,
            COALESCE(booked.hours, 0)::float AS "bookedHours",
            (COALESCE(cap.hours, 0) - COALESCE(blocks.hours, 0))::float AS "availableHours",
            COALESCE(paid.n, 0)::int AS payments,
            COALESCE(paid.gross, 0)::bigint::float AS revenue,
            COALESCE(paid.net, 0)::bigint::float AS "netRevenue"
     FROM days d LEFT JOIN cap USING (day) LEFT JOIN blocks USING (day) LEFT JOIN booked USING (day) LEFT JOIN paid USING (day)
     ORDER BY d.day`, [ownerId, start, end]);
  // Every confirmed booking must have a paid transaction, and every paid transaction a confirmed booking.
  const [integrity] = await sql(
    `SELECT count(*) FILTER (WHERE b.status = 'confirmed' AND t.status IS DISTINCT FROM 'paid')::int AS confirmed_without_payment,
            count(*) FILTER (WHERE t.status = 'paid' AND b.status <> 'confirmed')::int AS paid_without_confirmation,
            count(*) FILTER (WHERE b.status = 'confirmed')::int AS confirmed_bookings,
            count(*) FILTER (WHERE t.status = 'paid')::int AS paid_transactions
     FROM bookings b JOIN courts c ON c.id = b.court_id LEFT JOIN transactions t ON t.booking_id = b.id
     WHERE c.owner_id = $1`, [ownerId]);
  const reported = dash.daily.map((d: any) => ({
    date: d.date, bookings: d.bookings, bookedHours: d.bookedHours, availableHours: d.availableHours,
    payments: d.payments, revenue: d.revenue, netRevenue: d.netRevenue,
  }));
  return { owner: ownerEmail, range: { start, end }, expected, reported, integrity, totals: dash.range };
}

function saveReport(name: string, data: unknown) {
  const dir = path.resolve(import.meta.dirname, '../test-results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2));
}

const owners = async () => (await sql<{ email: string }>(
  `SELECT DISTINCT u.email FROM users u JOIN courts c ON c.owner_id = u.id ORDER BY u.email`)).map((r) => r.email);

test('occupancy and revenue reconcile with the bookings and transaction logs for every owner', async ({}, info) => {
  const start = await localDate(-29);
  const end = await localDate(7);
  const reports = [];
  for (const email of await owners()) {
    const ctx = await playwrightRequest.newContext({ baseURL: APP_URL });
    await loginViaApi(ctx, email);
    reports.push(await reconcile(ctx, email, start, end));
    await ctx.dispose();
  }
  expect(reports.map((r) => r.owner)).toContain(DEMO.owner);

  for (const r of reports) {
    expect(r.reported, `${r.owner}: daily figures`).toEqual(r.expected);
    expect(r.integrity.confirmed_without_payment, `${r.owner}: confirmed bookings with no paid transaction`).toBe(0);
    expect(r.integrity.paid_without_confirmation, `${r.owner}: paid transactions on unconfirmed bookings`).toBe(0);
  }
  const summary = reports.map((r) => ({
    owner: r.owner, range: r.range, integrity: r.integrity,
    dashboard: { bookings: r.totals.bookings, occupancy: r.totals.occupancy, revenue: r.totals.revenue },
    independent: {
      bookedHours: r.expected.reduce((s: number, d: any) => s + d.bookedHours, 0),
      availableHours: r.expected.reduce((s: number, d: any) => s + d.availableHours, 0),
      payments: r.expected.reduce((s: number, d: any) => s + d.payments, 0),
      gross: r.expected.reduce((s: number, d: any) => s + d.revenue, 0),
    },
    daysCompared: r.expected.length,
    daysWithActivity: r.expected.filter((d: any) => d.bookings || d.payments).map((d: any) => d.date),
  }));
  for (const s of summary) {
    expect(s.dashboard.occupancy.bookedHours).toBe(s.independent.bookedHours);
    expect(s.dashboard.occupancy.availableHours).toBe(s.independent.availableHours);
    expect(s.dashboard.revenue.gross).toBe(s.independent.gross);
    expect(s.dashboard.revenue.payments).toBe(s.independent.payments);
  }
  saveReport('dashboard-reconciliation', { generatedAt: new Date().toISOString(), summary, detail: reports });
  await info.attach('dashboard-reconciliation', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
});
