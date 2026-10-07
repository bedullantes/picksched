/**
 * Role-based access matrix: every API endpoint called by every kind of user.
 *
 *   anon         not signed in
 *   player       the player who made the bookings
 *   otherPlayer  a different player
 *   owner        the owner of the court (role "admin")
 *   rivalOwner   an owner of a different facility
 *
 * Owners have full access to their own facility; players only to booking
 * endpoints and their own bookings. Nobody (owners included) can confirm a
 * booking that hasn't been paid or change one while it's in checkout.
 * State-changing calls that would succeed are covered by the workflow tests;
 * here they are marked `skip` so the fixtures stay unchanged.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { at, manilaDate, signUp, startTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof startTestApp>>;
type Actor = 'anon' | 'player' | 'otherPlayer' | 'owner' | 'rivalOwner';
type Expect = number | 'skip';

let ctx: Ctx;
const agents = {} as Record<Exclude<Actor, 'anon'>, Awaited<ReturnType<typeof signUp>>>;
const f = {} as { court: string; pending: string; confirmed: string; block: string; date: string };

beforeAll(async () => {
  ctx = await startTestApp();
  agents.player = await signUp(ctx.baseUrl, 'player', 'rbac-player');
  agents.otherPlayer = await signUp(ctx.baseUrl, 'player', 'rbac-other');
  agents.owner = await signUp(ctx.baseUrl, 'admin', 'rbac-owner');
  agents.rivalOwner = await signUp(ctx.baseUrl, 'admin', 'rbac-rival');
  f.court = (await ctx.admin.query(
    `INSERT INTO courts (owner_id, name, hourly_rate) VALUES ($1, 'RBAC Court', 40000) RETURNING id`, [agents.owner.id])).rows[0].id;
  await ctx.admin.query(`INSERT INTO courts (owner_id, name, hourly_rate) VALUES ($1, 'Rival Court', 40000)`, [agents.rivalOwner.id]);
  f.date = await manilaDate(ctx.admin, 2);

  const reserve = async (h: number) => {
    const res = await agents.player.agent.post('/api/bookings').send({ courtId: f.court, startTime: at(f.date, h), endTime: at(f.date, h + 1) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.booking.id as string;
  };
  f.pending = await reserve(9);
  expect((await agents.player.agent.post(`/api/bookings/${f.pending}/checkout`)).status).toBe(200);
  f.confirmed = await reserve(11);
  await agents.player.agent.post(`/api/bookings/${f.confirmed}/checkout`);
  const { checkout_session_id: cs } = (await ctx.admin.query(
    'SELECT checkout_session_id FROM transactions WHERE booking_id = $1', [f.confirmed])).rows[0];
  await ctx.paymongoFake.pay(cs, 'gcash', 'paid');
  const block = await agents.owner.agent.post('/api/maintenance-blocks')
    .send({ courtId: f.court, startTime: at(f.date, 14), endTime: at(f.date, 15), reason: 'Resurfacing' });
  expect(block.status, JSON.stringify(block.body)).toBe(201);
  f.block = block.body.block.id;
});

afterAll(async () => {
  await ctx?.close();
});

interface Row {
  name: string;
  call: () => { method: 'get' | 'post' | 'patch' | 'delete'; url: string; body?: object };
  expect: Record<Actor, Expect>;
}

const rows: Row[] = [
  // Analytics and facility management: owners only.
  { name: 'GET /dashboard', call: () => ({ method: 'get', url: '/api/dashboard' }),
    expect: { anon: 401, player: 403, otherPlayer: 403, owner: 200, rivalOwner: 200 } },
  { name: 'GET /availability?mine=1 (facility schedule)', call: () => ({ method: 'get', url: `/api/availability?start=${f.date}&mine=1` }),
    expect: { anon: 403, player: 403, otherPlayer: 403, owner: 200, rivalOwner: 200 } },
  { name: 'GET /maintenance-blocks', call: () => ({ method: 'get', url: '/api/maintenance-blocks' }),
    expect: { anon: 401, player: 403, otherPlayer: 403, owner: 200, rivalOwner: 200 } },
  { name: 'POST /maintenance-blocks', call: () => ({ method: 'post', url: '/api/maintenance-blocks',
    body: { courtId: f.court, startTime: at(f.date, 16), endTime: at(f.date, 17) } }),
    expect: { anon: 401, player: 403, otherPlayer: 403, owner: 'skip', rivalOwner: 403 } },
  { name: 'DELETE /maintenance-blocks/:id', call: () => ({ method: 'delete', url: `/api/maintenance-blocks/${f.block}` }),
    expect: { anon: 401, player: 403, otherPlayer: 403, owner: 'skip', rivalOwner: 404 } },

  // Public browsing.
  { name: 'GET /courts', call: () => ({ method: 'get', url: '/api/courts' }),
    expect: { anon: 200, player: 200, otherPlayer: 200, owner: 200, rivalOwner: 200 } },
  { name: 'GET /availability', call: () => ({ method: 'get', url: `/api/availability?start=${f.date}` }),
    expect: { anon: 200, player: 200, otherPlayer: 200, owner: 200, rivalOwner: 200 } },

  // Own account and history.
  { name: 'GET /auth/me', call: () => ({ method: 'get', url: '/api/auth/me' }),
    expect: { anon: 401, player: 200, otherPlayer: 200, owner: 200, rivalOwner: 200 } },
  { name: 'GET /notifications', call: () => ({ method: 'get', url: '/api/notifications' }),
    expect: { anon: 401, player: 200, otherPlayer: 200, owner: 200, rivalOwner: 200 } },
  { name: 'GET /events (live updates)', call: () => ({ method: 'get', url: '/api/events' }),
    expect: { anon: 401, player: 'skip', otherPlayer: 'skip', owner: 'skip', rivalOwner: 'skip' } },

  // Bookings.
  { name: 'POST /bookings (reserve)', call: () => ({ method: 'post', url: '/api/bookings',
    body: { courtId: f.court, startTime: at(f.date, 9), endTime: at(f.date, 10) } }),
    expect: { anon: 401, player: 409, otherPlayer: 409, owner: 409, rivalOwner: 409 } }, // slot taken: no one bypasses the hold
  { name: 'GET /bookings/:id', call: () => ({ method: 'get', url: `/api/bookings/${f.pending}` }),
    expect: { anon: 401, player: 200, otherPlayer: 404, owner: 200, rivalOwner: 404 } },
  { name: 'POST /bookings/:id/checkout', call: () => ({ method: 'post', url: `/api/bookings/${f.pending}/checkout` }),
    expect: { anon: 401, player: 200, otherPlayer: 404, owner: 403, rivalOwner: 404 } },
  { name: 'POST /bookings/:id/payment/verify', call: () => ({ method: 'post', url: `/api/bookings/${f.pending}/payment/verify` }),
    expect: { anon: 401, player: 200, otherPlayer: 404, owner: 200, rivalOwner: 404 } },
  { name: 'POST /bookings/:id/confirm (unpaid, in checkout)', call: () => ({ method: 'post', url: `/api/bookings/${f.pending}/confirm` }),
    expect: { anon: 401, player: 403, otherPlayer: 403, owner: 409, rivalOwner: 404 } },
  { name: 'PATCH /bookings/:id (in checkout)', call: () => ({ method: 'patch', url: `/api/bookings/${f.pending}`,
    body: { startTime: at(f.date, 12), endTime: at(f.date, 13) } }),
    expect: { anon: 401, player: 403, otherPlayer: 403, owner: 409, rivalOwner: 404 } },
  { name: 'PATCH /bookings/:id (confirmed)', call: () => ({ method: 'patch', url: `/api/bookings/${f.confirmed}`,
    body: { startTime: at(f.date, 12), endTime: at(f.date, 13) } }),
    expect: { anon: 401, player: 403, otherPlayer: 403, owner: 'skip', rivalOwner: 404 } },
  { name: 'POST /bookings/:id/cancel (in checkout)', call: () => ({ method: 'post', url: `/api/bookings/${f.pending}/cancel` }),
    expect: { anon: 401, player: 'skip', otherPlayer: 404, owner: 409, rivalOwner: 404 } },
  { name: 'POST /bookings/:id/cancel (confirmed)', call: () => ({ method: 'post', url: `/api/bookings/${f.confirmed}/cancel` }),
    expect: { anon: 401, player: 'skip', otherPlayer: 404, owner: 'skip', rivalOwner: 404 } },
];

const actors: Actor[] = ['anon', 'player', 'otherPlayer', 'owner', 'rivalOwner'];

describe.each(rows)('$name', (row) => {
  it.each(actors.filter((a) => row.expect[a] !== 'skip'))('%s', async (actor) => {
    const { method, url, body } = row.call();
    const client = actor === 'anon' ? request(ctx.baseUrl) : agents[actor].agent;
    let req = client[method](url);
    if (body) req = req.send(body);
    const res = await req;
    expect(res.status, `${actor} ${method.toUpperCase()} ${url}: ${JSON.stringify(res.body)}`).toBe(row.expect[actor]);
  });
});

describe('after the matrix', () => {
  it('left the bookings untouched', async () => {
    const r = (await ctx.admin.query(
      `SELECT id, status::text, payment_status::text FROM bookings WHERE id = ANY($1) ORDER BY start_time`,
      [[f.pending, f.confirmed]])).rows;
    expect(r.map((x) => [x.status, x.payment_status])).toEqual([['pending_payment', 'processing'], ['confirmed', 'paid']]);
  });

  it("scopes owners' data to their own facility", async () => {
    const rival = await agents.rivalOwner.agent.get(`/api/availability?start=${f.date}&mine=1`);
    expect(JSON.stringify(rival.body)).not.toContain(f.pending);
    expect((await agents.rivalOwner.agent.get('/api/maintenance-blocks')).body.blocks).toEqual([]);
    const dash = await agents.rivalOwner.agent.get('/api/dashboard');
    expect(dash.body.courts).toEqual({ registered: 1, active: 1 });
    expect(dash.body.overview.nextSevenDays.bookings).toBe(0);
  });

  it("doesn't expose who booked to other players", async () => {
    const res = await request(ctx.baseUrl).get(`/api/availability?start=${f.date}`);
    expect(JSON.stringify(res.body)).not.toContain(agents.player.email);
    const other = await agents.otherPlayer.agent.get(`/api/availability?start=${f.date}`);
    expect(JSON.stringify(other.body)).not.toContain(agents.player.email);
  });
});
