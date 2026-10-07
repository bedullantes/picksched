import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { at, manilaDate, signUp, startTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof startTestApp>>;
type User = Awaited<ReturnType<typeof signUp>>;

let ctx: Ctx;
let owner: User;
let rival: User;
let player: User;
let courtA: string;
let courtB: string;
let today: string;
let tomorrow: string;

const db = async (sql: string, params: unknown[] = []) => (await ctx.admin.query(sql, params)).rows;

/** Inserts a booking directly (and optionally its paid transaction), as if it had gone through checkout. */
async function seedBooking(court: string, date: string, h1: number, h2: number, status: string, paid?: { fee: number; when?: string }) {
  const [b] = await db(
    `INSERT INTO bookings (court_id, player_id, start_time, end_time, status, cancelled_at)
     VALUES ($1, $2, $3, $4, $5::booking_status, CASE WHEN $5::text = 'cancelled' THEN now() END) RETURNING id`,
    [court, player.id, at(date, h1), at(date, h2), status]);
  if (paid) {
    await db(
      `INSERT INTO transactions (booking_id, amount, status, provider_ref_id, processed_at, provider_fee)
       VALUES ($1, 0, 'paid', $2, COALESCE($3::timestamptz, now()), $4)`,
      [b.id, `pi_${b.id}`, paid.when ?? null, paid.fee]);
  }
  return b.id as string;
}

beforeAll(async () => {
  ctx = await startTestApp();
  owner = await signUp(ctx.baseUrl, 'admin', 'dash-owner');
  rival = await signUp(ctx.baseUrl, 'admin', 'dash-rival');
  player = await signUp(ctx.baseUrl, 'player', 'dash-player');
  const add = async (o: User, name: string, active = true) => (await db(
    `INSERT INTO courts (owner_id, name, hourly_rate, is_active, created_at) VALUES ($1, $2, 50000, $3, now() - interval '60 days') RETURNING id`,
    [o.id, name, active]))[0].id as string;
  courtA = await add(owner, 'Dash A');
  courtB = await add(owner, 'Dash B');
  await add(owner, 'Dash closed', false);
  const rivalCourt = await add(rival, 'Rival');
  today = await manilaDate(ctx.admin, 0);
  tomorrow = await manilaDate(ctx.admin, 1);
  const in3 = await manilaDate(ctx.admin, 3);
  const in9 = await manilaDate(ctx.admin, 9);
  const yesterday = await manilaDate(ctx.admin, -1);

  // Today: 2 confirmed (3h total) + an unpaid hold and a cancelled booking (not counted)
  await seedBooking(courtA, today, 20, 22, 'confirmed', { fee: 2500 });
  await seedBooking(courtB, today, 21, 22, 'confirmed', { fee: 1250 });
  await seedBooking(courtA, today, 18, 19, 'pending_payment');
  await seedBooking(courtB, today, 18, 19, 'cancelled');
  // Upcoming
  await seedBooking(courtA, tomorrow, 9, 10, 'confirmed', { fee: 1250 });
  await seedBooking(courtB, in3, 9, 10, 'confirmed', { fee: 1250 });
  await seedBooking(courtB, in9, 9, 10, 'confirmed', { fee: 1250 }); // outside the 7-day window
  // Paid yesterday for a booking yesterday
  await seedBooking(courtA, yesterday, 9, 11, 'confirmed', { fee: 2500, when: at(yesterday, 8) });
  // A refunded payment (not revenue)
  const refunded = await seedBooking(courtB, tomorrow, 12, 13, 'cancelled');
  await db(`INSERT INTO transactions (booking_id, amount, status, provider_ref_id, processed_at) VALUES ($1, 0, 'refunded', 'pi_refund', now())`, [refunded]);
  // Another owner's activity
  await seedBooking(rivalCourt, today, 9, 12, 'confirmed', { fee: 3750 });
});

afterAll(async () => {
  await ctx?.close();
});

describe('access', () => {
  it('requires sign-in', async () => {
    expect((await request(ctx.baseUrl).get('/api/dashboard')).status).toBe(401);
  });

  it('is for court owners only', async () => {
    const res = await player.agent.get('/api/dashboard');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('metrics', () => {
  it("summarizes today and the next 7 days for the owner's courts", async () => {
    const res = await owner.agent.get('/api/dashboard');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ timezone: 'Asia/Manila', currency: 'PHP', today, courts: { registered: 3, active: 2 } });

    const t = res.body.overview.today;
    expect(t.bookings).toBe(2);
    expect(t.occupancy).toEqual({ bookedHours: 3, availableHours: 32, rate: 3 / 32 }); // 2 active courts x 16h
    expect(res.body.overview.nextSevenDays.bookings).toBe(4); // today 2 + tomorrow 1 + day 3 1
    expect(res.body.overview.nextSevenDays.occupancy.availableHours).toBe(7 * 32);
  });

  it('reports revenue from paid transactions in the selected range', async () => {
    const yesterday = await manilaDate(ctx.admin, -1);
    const res = await owner.agent.get('/api/dashboard').query({ start: yesterday, end: yesterday });
    expect(res.body.range.revenue).toEqual({ payments: 1, gross: 100000, providerFees: 2500, platformFees: 5000, net: 92500 });

    // Payments recorded today (seeded with now()): 5 bookings x 1h-2h, refunded one excluded
    const todays = await owner.agent.get('/api/dashboard').query({ start: today, end: today });
    expect(todays.body.range.revenue).toMatchObject({ payments: 5, gross: 300000 }); // 2h + 1h + 1h + 1h + 1h at 500/h
  });

  it('returns one row per day for the trend charts', async () => {
    const start = await manilaDate(ctx.admin, -6);
    const res = await owner.agent.get('/api/dashboard').query({ start, end: today });
    expect(res.body.range).toMatchObject({ start, end: today });
    expect(res.body.daily).toHaveLength(7);
    const last = res.body.daily.at(-1);
    expect(last).toMatchObject({ date: today, bookings: 2, bookedHours: 3, availableHours: 32, activeCourts: 2, payments: 5, revenue: 300000 });
    expect(last.occupancyRate).toBeCloseTo(0.09375);
    expect(res.body.daily.at(-2)).toMatchObject({ bookings: 1, bookedHours: 2, revenue: 100000 });
  });

  it('defaults to the last 30 days', async () => {
    const res = await owner.agent.get('/api/dashboard');
    expect(res.body.range).toMatchObject({ start: await manilaDate(ctx.admin, -29), end: today });
    expect(res.body.daily).toHaveLength(30);
  });

  it("never includes another owner's courts", async () => {
    const res = await rival.agent.get('/api/dashboard').query({ start: today, end: today });
    expect(res.body.courts).toEqual({ registered: 1, active: 1 });
    expect(res.body.overview.today).toMatchObject({ bookings: 1, occupancy: { bookedHours: 3, availableHours: 16 } });
    expect(res.body.range.revenue.gross).toBe(150000);
  });

  it('counts a real PayMongo payment as revenue', async () => {
    const before = (await owner.agent.get('/api/dashboard').query({ start: today, end: today })).body.range.revenue.gross;
    const booking = await player.agent.post('/api/bookings').send({ courtId: courtB, startTime: at(tomorrow, 15), endTime: at(tomorrow, 16) });
    await player.agent.post(`/api/bookings/${booking.body.booking.id}/checkout`);
    const [{ checkout_session_id: cs }] = await db('SELECT checkout_session_id FROM transactions WHERE booking_id = $1', [booking.body.booking.id]);
    await ctx.paymongoFake.pay(cs, 'gcash', 'paid');
    const after = (await owner.agent.get('/api/dashboard').query({ start: today, end: today })).body;
    expect(after.range.revenue.gross).toBe(before + 50000);
  });
});

describe('validation and empty data', () => {
  it('rejects an end date before the start date', async () => {
    const res = await owner.agent.get('/api/dashboard').query({ start: today, end: await manilaDate(ctx.admin, -1) });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'INVALID_RANGE', message: "The end date can't be earlier than the start date." });
  });

  it('rejects malformed dates and ranges over a year', async () => {
    expect((await owner.agent.get('/api/dashboard').query({ start: '2026-13-01' })).status).toBe(400);
    const long = await owner.agent.get('/api/dashboard').query({ start: '2024-01-01', end: '2025-06-01' });
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe('RANGE_TOO_LONG');
  });

  it('returns zeros, not errors, for an owner with no courts', async () => {
    const fresh = await signUp(ctx.baseUrl, 'admin', 'dash-fresh');
    const res = await fresh.agent.get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.courts).toEqual({ registered: 0, active: 0 });
    expect(res.body.overview.today).toEqual({
      bookings: 0,
      occupancy: { bookedHours: 0, availableHours: 0, rate: null },
      revenue: { payments: 0, gross: 0, providerFees: 0, platformFees: 0, net: 0 },
    });
  });
});
