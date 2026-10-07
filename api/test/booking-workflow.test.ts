import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expireStaleHolds } from '../src/jobs.js';
import { at, manilaDate, signUp, startTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof startTestApp>>;
type User = Awaited<ReturnType<typeof signUp>>;

let ctx: Ctx;
let owner: User;
let alice: User;
let bob: User;
let courtId: string;
let tomorrow: string;

const reserve = (user: User, body: object, key?: string) => {
  const req = user.agent.post('/api/bookings');
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
};

const slotBody = (h: number, len = 1) => ({ courtId, startTime: at(tomorrow, h), endTime: at(tomorrow, h + len) });

async function activeBookingsAt(h: number): Promise<number> {
  return Number((await ctx.admin.query(
    `SELECT count(*) FROM bookings WHERE court_id = $1 AND start_time = $2 AND status <> 'cancelled'`,
    [courtId, at(tomorrow, h)])).rows[0].count);
}

beforeAll(async () => {
  ctx = await startTestApp();
  owner = await signUp(ctx.baseUrl, 'admin', 'wf-owner');
  alice = await signUp(ctx.baseUrl, 'player', 'wf-alice');
  bob = await signUp(ctx.baseUrl, 'player', 'wf-bob');
  courtId = (await ctx.admin.query(
    `INSERT INTO courts (owner_id, name, hourly_rate) VALUES ($1, 'Workflow Court', 60000) RETURNING id`,
    [owner.id])).rows[0].id;
  tomorrow = await manilaDate(ctx.admin, 1);
});

afterAll(async () => {
  await ctx?.close();
});

describe('reservation', () => {
  it('creates a pending_payment booking with expires_at 15 minutes out, ready for payment', async () => {
    const before = Date.now();
    const res = await reserve(alice, slotBody(7));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      booking: { status: 'pending_payment', courtId, playerId: alice.id, totalAmount: 60000 },
      payment: { provider: 'paymongo', amount: 60000, currency: 'PHP' },
      next: 'payment',
      replayed: false,
    });

    const row = (await ctx.admin.query(
      'SELECT status, expires_at, created_at FROM bookings WHERE id = $1', [res.body.booking.id])).rows[0];
    expect(row.status).toBe('pending_payment');
    const holdMs = row.expires_at.getTime() - row.created_at.getTime();
    expect(holdMs).toBe(15 * 60_000);
    expect(row.expires_at.getTime()).toBeGreaterThan(before);
    expect(res.body.payment.expiresAt).toBe(row.expires_at.toISOString());
    expect(res.body.booking.expiresAt).toBe(row.expires_at.toISOString());
  });

  it('accepts a date and local start time in the court time zone', async () => {
    const res = await reserve(alice, { courtId, date: tomorrow, time: '13:00', durationMinutes: 120 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.booking).toMatchObject({ startTime: at(tomorrow, 13), endTime: at(tomorrow, 15), totalAmount: 120000 });
  });

  it('defaults to one slot when no duration is given', async () => {
    const res = await reserve(bob, { courtId, date: tomorrow, time: '16:00' });
    expect(res.status).toBe(201);
    expect(res.body.booking.endTime).toBe(at(tomorrow, 17));
  });

  it('owners can see a booking in checkout', async () => {
    const res = await owner.agent.get('/api/availability').query({ start: tomorrow, mine: '1' });
    const slot = res.body.slots.find((s: any) => s.startTime === at(tomorrow, 7));
    expect(slot).toMatchObject({ status: 'booked', booking: { status: 'pending_payment', playerEmail: alice.email } });
  });
});

describe('input validation', () => {
  it.each([
    ['malformed court id', { courtId: 'court-1', date: '2099-01-01', time: '09:00' }, 'BAD_REQUEST'],
    ['impossible date', { courtId: '00000000-0000-0000-0000-000000000001', date: '2099-02-30', time: '09:00' }, 'BAD_REQUEST'],
    ['malformed time', { courtId: '00000000-0000-0000-0000-000000000001', date: '2099-01-01', time: '25:00' }, 'BAD_REQUEST'],
    ['missing time', { courtId: '00000000-0000-0000-0000-000000000001', date: '2099-01-01' }, 'BAD_REQUEST'],
    ['end before start', { courtId: '00000000-0000-0000-0000-000000000001', startTime: '2099-01-01T10:00:00Z', endTime: '2099-01-01T09:00:00Z' }, 'BAD_REQUEST'],
  ])('rejects %s with 400', async (_label, body, code) => {
    const res = await reserve(alice, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  it('rejects a past date with 400', async () => {
    const yesterday = await manilaDate(ctx.admin, -1);
    const res = await reserve(alice, { courtId, date: yesterday, time: '10:00' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SLOT_IN_PAST');
  });

  it('rejects a time off the slot grid or outside opening hours with 400', async () => {
    expect((await reserve(alice, { courtId, date: tomorrow, time: '10:30' })).body.error.code).toBe('INVALID_SLOT');
    expect((await reserve(alice, { courtId, date: tomorrow, time: '23:00' })).status).toBe(400);
  });

  it('rejects an unknown court with 404', async () => {
    const res = await reserve(alice, { courtId: randomUUID(), date: tomorrow, time: '10:00' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('COURT_NOT_FOUND');
  });

  it('requires sign-in', async () => {
    const { default: request } = await import('supertest');
    expect((await request(ctx.baseUrl).post('/api/bookings').send(slotBody(8))).status).toBe(401);
  });
});

describe('concurrency', () => {
  it('rejects a held slot with 409 Slot Unavailable', async () => {
    const res = await reserve(bob, slotBody(7));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'SLOT_UNAVAILABLE', message: expect.stringMatching(/no longer available/) });
  });

  it('lets exactly one of 10 simultaneous reservations through', async () => {
    const players = await Promise.all(Array.from({ length: 10 }, (_, i) => signUp(ctx.baseUrl, 'player', `wf-race${i}`)));
    const results = await Promise.all(players.map((p) => reserve(p, slotBody(9))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await activeBookingsAt(9)).toBe(1);
  });

  it('rejects overlapping multi-slot reservations made at the same time', async () => {
    const [a, b] = await Promise.all([reserve(alice, slotBody(18, 2)), reserve(bob, slotBody(19, 2))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });
});

describe('retries after a network timeout (Idempotency-Key)', () => {
  it('returns the original reservation instead of a conflict', async () => {
    const key = randomUUID();
    const first = await reserve(alice, slotBody(10), key);
    expect(first.status).toBe(201);
    expect(first.body.booking.id).toBe(key);

    const retry = await reserve(alice, slotBody(10), key);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ replayed: true, booking: { id: key, status: 'pending_payment' } });
    expect(await activeBookingsAt(10)).toBe(1);
  });

  it('handles the retry arriving while the first request is still running', async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => reserve(alice, slotBody(11), key)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.booking.id))).toEqual(new Set([key]));
    expect(await activeBookingsAt(11)).toBe(1);
  });

  it('refuses to reuse a key for a different slot', async () => {
    const key = randomUUID();
    expect((await reserve(alice, slotBody(12), key)).status).toBe(201);
    const res = await reserve(alice, slotBody(20), key);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it("doesn't let another player replay someone else's key", async () => {
    const key = randomUUID();
    expect((await reserve(alice, slotBody(17), key)).status).toBe(201);
    const res = await reserve(bob, slotBody(17), key);
    expect(res.status).toBe(409);
  });

  it('rejects a malformed key', async () => {
    const res = await reserve(alice, slotBody(21), 'not-a-uuid');
    expect(res.status).toBe(400);
  });
});

describe('abandoned checkouts', () => {
  it('expire and free the slot', async () => {
    const res = await reserve(alice, slotBody(8));
    const id = res.body.booking.id;
    await ctx.admin.query(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);

    expect(await expireStaleHolds(ctx)).toBeGreaterThanOrEqual(1);
    const row = (await ctx.admin.query('SELECT status, cancelled_at FROM bookings WHERE id = $1', [id])).rows[0];
    expect(row.status).toBe('cancelled');
    expect(row.cancelled_at).not.toBeNull();

    expect((await alice.agent.post(`/api/bookings/${id}/checkout`)).body.error.code).toBe('BOOKING_CANCELLED');
    expect((await reserve(bob, slotBody(8))).status).toBe(201);
  });

  it('a player can abandon their own checkout', async () => {
    const res = await reserve(alice, slotBody(6));
    const cancelled = await alice.agent.post(`/api/bookings/${res.body.booking.id}/cancel`);
    expect(cancelled.body.booking.status).toBe('cancelled');
    expect(await activeBookingsAt(6)).toBe(0);
  });
});
