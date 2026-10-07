import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { ScheduleEvents } from '../src/events.js';
import { at, manilaDate, signUp, startTestApp, testConfig } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof startTestApp>>;
type User = Awaited<ReturnType<typeof signUp>>;

let ctx: Ctx;
let owner: User;
let otherOwner: User;
let alice: User;
let bob: User;
let courtId: string;
let otherCourtId: string;
let tomorrow: string;

const slotAt = (slots: any[], startTime: string, cId = courtId) =>
  slots.find((s) => s.courtId === cId && s.startTime === startTime);

async function availability(user: User, query: Record<string, string>) {
  const res = await user.agent.get('/api/availability').query(query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

beforeAll(async () => {
  ctx = await startTestApp();
  owner = await signUp(ctx.baseUrl, 'admin', 'owner');
  otherOwner = await signUp(ctx.baseUrl, 'admin', 'owner2');
  alice = await signUp(ctx.baseUrl, 'player', 'alice');
  bob = await signUp(ctx.baseUrl, 'player', 'bob');
  courtId = (await ctx.admin.query(
    `INSERT INTO courts (owner_id, name, hourly_rate) VALUES ($1, 'Center Court', 50000) RETURNING id`,
    [owner.id])).rows[0].id;
  otherCourtId = (await ctx.admin.query(
    `INSERT INTO courts (owner_id, name, hourly_rate) VALUES ($1, 'Rival Court', 30000) RETURNING id`,
    [otherOwner.id])).rows[0].id;
  tomorrow = await manilaDate(ctx.admin, 1);
});

afterAll(async () => {
  await ctx?.close();
});

describe('authentication', () => {
  it('returns the signed-in user', async () => {
    const res = await alice.agent.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: alice.id, email: alice.email, role: 'player' });
  });

  it('rejects a wrong password', async () => {
    const res = await request(ctx.baseUrl).post('/api/auth/login')
      .send({ email: alice.email, password: 'wrong password!' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('logs in with the right password', async () => {
    const res = await request(ctx.baseUrl).post('/api/auth/login')
      .send({ email: alice.email.toUpperCase(), password: 'correct horse battery' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie'][0]).toMatch(/picksched_session=.*HttpOnly/);
  });

  it('rejects a duplicate email', async () => {
    const res = await request(ctx.baseUrl).post('/api/auth/register')
      .send({ email: alice.email, password: 'another password' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('requires sign-in for bookings and live updates', async () => {
    expect((await request(ctx.baseUrl).post('/api/bookings').send({})).status).toBe(401);
    expect((await request(ctx.baseUrl).get('/api/events')).status).toBe(401);
  });

  it('ignores a tampered session cookie', async () => {
    const res = await request(ctx.baseUrl).get('/api/auth/me')
      .set('Cookie', 'picksched_session=eyJzdWIiOiJ4Iiwicm9sZSI6ImFkbWluIiwiZXhwIjo5OTk5OTk5OTk5fQ.AAAA');
    expect(res.status).toBe(401);
  });
});

describe('availability', () => {
  it('returns every slot of the day, all open', async () => {
    const body = await availability(alice, { start: tomorrow, days: '1', courtId });
    expect(body.slots).toHaveLength(16);
    expect(body.slots[0].startTime).toBe(at(tomorrow, 6));
    expect(body.slots[15].endTime).toBe(at(tomorrow, 22));
    expect(new Set(body.slots.map((s: any) => s.status))).toEqual(new Set(['available']));
    expect(body.rules).toEqual({ minLeadMinutes: 60, holdMinutes: 3 });
    expect(body.courts[0]).toMatchObject({ name: 'Center Court', hourlyRate: 50000, opensAt: '06:00' });
  });

  it('returns 7 days for the week view', async () => {
    const body = await availability(alice, { start: tomorrow, days: '7', courtId });
    expect(body.slots).toHaveLength(16 * 7);
    expect(new Set(body.slots.map((s: any) => s.date)).size).toBe(7);
  });

  it('marks past days unavailable', async () => {
    const yesterday = await manilaDate(ctx.admin, -1);
    const body = await availability(alice, { start: yesterday, courtId });
    expect(new Set(body.slots.map((s: any) => s.status))).toEqual(new Set(['unavailable']));
  });

  it('rejects malformed dates', async () => {
    const res = await alice.agent.get('/api/availability').query({ start: '2026-02-30' });
    expect(res.status).toBe(400);
  });

  it("only lets owners request their facility view", async () => {
    const res = await alice.agent.get('/api/availability').query({ start: tomorrow, mine: '1' });
    expect(res.status).toBe(403);
    const own = await availability(owner, { start: tomorrow, mine: '1' });
    expect(own.courts.map((c: any) => c.id)).toEqual([courtId]);
  });
});

describe('booking a slot', () => {
  it('holds an open slot for the player', async () => {
    const res = await alice.agent.post('/api/bookings')
      .send({ courtId, startTime: at(tomorrow, 9), endTime: at(tomorrow, 10) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.booking).toMatchObject({
      courtId, courtName: 'Center Court', status: 'pending_payment', totalAmount: 50000, currency: 'PHP',
    });
    expect(res.body.booking.holdExpiresAt).toBeTruthy();
  });

  it('shows the booking as mine to its player, booked to others, with details for the owner', async () => {
    const mine = slotAt((await availability(alice, { start: tomorrow, courtId })).slots, at(tomorrow, 9));
    expect(mine.status).toBe('mine');
    expect(mine.booking.status).toBe('pending_payment');

    const theirs = slotAt((await availability(bob, { start: tomorrow, courtId })).slots, at(tomorrow, 9));
    expect(theirs.status).toBe('booked');
    expect(theirs.booking).toBeUndefined();

    const ownerView = slotAt((await availability(owner, { start: tomorrow, mine: '1' })).slots, at(tomorrow, 9));
    expect(ownerView.status).toBe('booked');
    expect(ownerView.booking.playerEmail).toBe(alice.email);
  });

  it('rejects a slot that is already taken', async () => {
    const res = await bob.agent.post('/api/bookings')
      .send({ courtId, startTime: at(tomorrow, 9), endTime: at(tomorrow, 10) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
    expect(res.body.error.message).toMatch(/no longer available/);
  });

  it('lets exactly one of many simultaneous requests win', async () => {
    const players = await Promise.all(Array.from({ length: 8 }, (_, i) => signUp(ctx.baseUrl, 'player', `racer${i}`)));
    const results = await Promise.all(players.map((p) =>
      p.agent.post('/api/bookings').send({ courtId, startTime: at(tomorrow, 11), endTime: at(tomorrow, 12) })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
  });

  it('enforces the 1-hour advance rule', async () => {
    const soon = new Date(Date.now() + 30 * 60_000);
    soon.setUTCMinutes(0, 0, 0);
    const res = await alice.agent.post('/api/bookings')
      .send({ courtId, startTime: soon.toISOString(), endTime: new Date(soon.getTime() + 3_600_000).toISOString() });
    expect(res.status).toBe(400);
    expect(['TOO_SOON', 'SLOT_IN_PAST']).toContain(res.body.error.code);
  });

  it('rejects past times', async () => {
    const yesterday = await manilaDate(ctx.admin, -1);
    const res = await alice.agent.post('/api/bookings')
      .send({ courtId, startTime: at(yesterday, 9), endTime: at(yesterday, 10) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SLOT_IN_PAST');
  });

  it('rejects times that do not match the court slots', async () => {
    const res = await alice.agent.post('/api/bookings')
      .send({ courtId, startTime: at(tomorrow, 14, 30), endTime: at(tomorrow, 15, 30) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SLOT');
  });

  it('accepts a multi-slot booking and prices it', async () => {
    const res = await bob.agent.post('/api/bookings')
      .send({ courtId, startTime: at(tomorrow, 19), endTime: at(tomorrow, 21) });
    expect(res.status).toBe(201);
    expect(res.body.booking.totalAmount).toBe(100000);
  });

  it('validates the request body', async () => {
    const res = await alice.agent.post('/api/bookings')
      .send({ courtId, startTime: at(tomorrow, 10), endTime: at(tomorrow, 9) });
    expect(res.status).toBe(400);
  });
});

describe('maintenance blocks', () => {
  let blockId: string;

  it('cannot be created by players', async () => {
    const res = await alice.agent.post('/api/maintenance-blocks')
      .send({ courtId, startTime: at(tomorrow, 12), endTime: at(tomorrow, 14) });
    expect(res.status).toBe(403);
  });

  it("cannot be created on another owner's court", async () => {
    const res = await owner.agent.post('/api/maintenance-blocks')
      .send({ courtId: otherCourtId, startTime: at(tomorrow, 12), endTime: at(tomorrow, 14) });
    expect(res.status).toBe(403);
  });

  it('are created by the owner and appear as maintenance', async () => {
    const res = await owner.agent.post('/api/maintenance-blocks')
      .send({ courtId, startTime: at(tomorrow, 12), endTime: at(tomorrow, 14), reason: 'Net replacement' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    blockId = res.body.block.id;

    const playerView = slotAt((await availability(bob, { start: tomorrow, courtId })).slots, at(tomorrow, 13));
    expect(playerView.status).toBe('maintenance');
    expect(playerView.block).toBeUndefined();

    const ownerView = slotAt((await availability(owner, { start: tomorrow, mine: '1' })).slots, at(tomorrow, 12));
    expect(ownerView).toMatchObject({ status: 'maintenance', block: { id: blockId, reason: 'Net replacement' } });
  });

  it('block bookings', async () => {
    const res = await bob.agent.post('/api/bookings')
      .send({ courtId, startTime: at(tomorrow, 13), endTime: at(tomorrow, 14) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COURT_UNDER_MAINTENANCE');
  });

  it('cannot cover existing bookings', async () => {
    const res = await owner.agent.post('/api/maintenance-blocks')
      .send({ courtId, startTime: at(tomorrow, 9), endTime: at(tomorrow, 10) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BLOCK_OVERLAPS_BOOKINGS');
  });

  it('are listed for the owner and can be removed', async () => {
    const list = await owner.agent.get('/api/maintenance-blocks').query({ courtId });
    expect(list.body.blocks.map((b: any) => b.id)).toContain(blockId);
    expect((await owner.agent.delete(`/api/maintenance-blocks/${blockId}`)).status).toBe(204);
    const slot = slotAt((await availability(bob, { start: tomorrow, courtId })).slots, at(tomorrow, 13));
    expect(slot.status).toBe('available');
  });

  it('race with a booking for the same time: exactly one wins', async () => {
    const [block, booking] = await Promise.all([
      owner.agent.post('/api/maintenance-blocks')
        .send({ courtId, startTime: at(tomorrow, 17), endTime: at(tomorrow, 18) }),
      bob.agent.post('/api/bookings').send({ courtId, startTime: at(tomorrow, 17), endTime: at(tomorrow, 18) }),
    ]);
    expect([block.status, booking.status].sort()).toEqual([201, 409]);
  });
});

describe('owner booking management', () => {
  let bookingId: string;

  beforeAll(async () => {
    const res = await alice.agent.post('/api/bookings')
      .send({ courtId, startTime: at(tomorrow, 7), endTime: at(tomorrow, 8) });
    bookingId = res.body.booking.id;
  });

  it('players cannot edit bookings', async () => {
    const res = await alice.agent.patch(`/api/bookings/${bookingId}`)
      .send({ startTime: at(tomorrow, 15), endTime: at(tomorrow, 16) });
    expect(res.status).toBe(403);
  });

  it('owner cannot change a booking while the player is checking out', async () => {
    for (const res of [
      await owner.agent.patch(`/api/bookings/${bookingId}`).send({ startTime: at(tomorrow, 15), endTime: at(tomorrow, 16) }),
      await owner.agent.post(`/api/bookings/${bookingId}/confirm`),
      await owner.agent.post(`/api/bookings/${bookingId}/cancel`),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BOOKING_IN_CHECKOUT');
    }
    // Simulate the payment completing, for the tests below.
    await ctx.admin.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [bookingId]);
  });

  it('owner moves a booking to a new time', async () => {
    const res = await owner.agent.patch(`/api/bookings/${bookingId}`)
      .send({ startTime: at(tomorrow, 15), endTime: at(tomorrow, 16) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.booking.startTime).toBe(at(tomorrow, 15));
  });

  it('owner cannot move a booking onto another booking', async () => {
    const res = await owner.agent.patch(`/api/bookings/${bookingId}`)
      .send({ startTime: at(tomorrow, 9), endTime: at(tomorrow, 10) });
    expect(res.status).toBe(409);
  });

  it('owner cancels a confirmed booking', async () => {
    const confirmed = await owner.agent.post(`/api/bookings/${bookingId}/confirm`);
    expect(confirmed.body.booking.status).toBe('confirmed');
    const cancelled = await owner.agent.post(`/api/bookings/${bookingId}/cancel`);
    expect(cancelled.body.booking.status).toBe('cancelled');
  });

  it("other owners can't see the booking", async () => {
    expect((await otherOwner.agent.get(`/api/bookings/${bookingId}`)).status).toBe(404);
  });
});

describe('checkout', () => {
  let bookingId: string;

  beforeAll(async () => {
    const res = await alice.agent.post('/api/bookings')
      .send({ courtId, startTime: at(tomorrow, 16), endTime: at(tomorrow, 17) });
    bookingId = res.body.booking.id;
  });

  it('confirms the hold is still valid', async () => {
    const res = await alice.agent.post(`/api/bookings/${bookingId}/checkout`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'awaiting_payment', payment: { amount: 50000, currency: 'PHP' } });
  });

  it("is only for the booking's player", async () => {
    expect((await bob.agent.post(`/api/bookings/${bookingId}/checkout`)).status).toBe(404);
    expect((await owner.agent.post(`/api/bookings/${bookingId}/checkout`)).status).toBe(403);
  });

  it('reports an expired hold', async () => {
    await ctx.admin.query(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [bookingId]);
    const res = await alice.agent.post(`/api/bookings/${bookingId}/checkout`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');
    const slot = slotAt((await availability(bob, { start: tomorrow, courtId })).slots, at(tomorrow, 16));
    expect(slot.status).toBe('available');
  });
});

describe('live updates', () => {
  it('pushes a schedule-changed event when a booking is made', async () => {
    const cookie = (await request(ctx.baseUrl).post('/api/auth/login')
      .send({ email: bob.email, password: 'correct horse battery' })).headers['set-cookie'][0].split(';')[0];
    const controller = new AbortController();
    const res = await fetch(`${ctx.baseUrl}/api/events`, { headers: { cookie }, signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (needle: string) => {
      while (!buffer.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += decoder.decode(value);
      }
    };
    await readUntil('event: ready');

    await alice.agent.post('/api/bookings').send({ courtId, startTime: at(tomorrow, 18), endTime: at(tomorrow, 19) });
    await readUntil('event: schedule-changed');
    const data = JSON.parse(buffer.split('event: schedule-changed\ndata: ')[1].split('\n')[0]);
    expect(data).toEqual({ courtId, startTime: at(tomorrow, 18), endTime: at(tomorrow, 19) });
    controller.abort();
  });
});

describe('database errors', () => {
  it('survives the database dropping its connections, and live updates resume', async () => {
    const resynced = new Promise<void>((resolve) => ctx.events.once('resync', () => resolve()));
    expect((await bob.agent.get('/api/availability').query({ start: tomorrow, courtId })).status).toBe(200);
    await ctx.admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`);
    await new Promise((r) => setTimeout(r, 100));
    expect((await bob.agent.get('/api/availability').query({ start: tomorrow, courtId })).status).toBe(200);
    await resynced; // the change listener reconnected and told clients to refetch
  });

  it('returns a friendly 503 when the database is unreachable', async () => {
    const config = testConfig({ databaseUrl: 'postgres://nobody@127.0.0.1:1/none' });
    const db = createPool(config.databaseUrl);
    const app = createApp({ db, config, events: new ScheduleEvents(config.databaseUrl) });
    const res = await request(app).get('/api/availability').query({ start: tomorrow });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DB_UNAVAILABLE');
    expect(res.body.error.message).toMatch(/temporarily unavailable/);
    await db.end();
  });
});
