/**
 * Seeds demo data for local development (safe to re-run):
 *   owner@demo.test / player@demo.test / player2@demo.test, password "pickleball123"
 *   three courts, a few bookings tomorrow and a maintenance block.
 * Usage: DATABASE_URL=postgres://... npm run seed:demo -w api
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL');
const db = new pg.Client({ connectionString: url });
await db.connect();

const hash = await bcrypt.hash('pickleball123', 10);
async function user(email: string, role: 'admin' | 'player') {
  const existing = await db.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
  if (existing.rows[0]) return existing.rows[0].id as string;
  return (await db.query('INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
    [email, hash, role])).rows[0].id as string;
}
const owner = await user('owner@demo.test', 'admin');
const player = await user('player@demo.test', 'player');
const player2 = await user('player2@demo.test', 'player');

const courts: string[] = [];
for (const [name, rate, location] of [
  ['Court 1', 40000, 'Indoor'], ['Court 2', 40000, 'Indoor'], ['Court 3 (Outdoor)', 30000, 'Outdoor'],
] as const) {
  const row = (await db.query(
    `INSERT INTO courts (owner_id, name, hourly_rate, location) VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [owner, name, rate, location])).rows[0];
  courts.push(row.id);
}

const tomorrow = (await db.query(`SELECT ((now() AT TIME ZONE 'Asia/Manila')::date + 1)::text AS d`)).rows[0].d;
const at = (h: number) => `${tomorrow} ${String(h).padStart(2, '0')}:00+08`;
const seedBooking = async (court: string, who: string, h: number, len: number, status: 'pending' | 'confirmed') => {
  await db.query(
    `INSERT INTO bookings (court_id, player_id, start_time, end_time, status, payment_status)
     SELECT $1, $2, $3::timestamptz, $4::timestamptz, $5, CASE WHEN $5 = 'confirmed' THEN 'paid' ELSE 'unpaid' END::booking_payment_status
     WHERE NOT EXISTS (SELECT 1 FROM bookings WHERE court_id = $1 AND start_time = $3::timestamptz AND status <> 'cancelled')`,
    [court, who, at(h), at(h + len), status]).catch(() => undefined);
};
await seedBooking(courts[0], player, 8, 2, 'confirmed');
await seedBooking(courts[0], player2, 17, 1, 'confirmed');
await seedBooking(courts[1], player2, 9, 1, 'confirmed');
await seedBooking(courts[2], player, 18, 1, 'confirmed');
await db.query(
  `INSERT INTO court_blocks (court_id, start_time, end_time, reason)
   SELECT $1, $2::timestamptz, $3::timestamptz, 'Net replacement'
   WHERE NOT EXISTS (SELECT 1 FROM court_blocks WHERE court_id = $1 AND start_time = $2::timestamptz)`,
  [courts[1], at(13), at(15)]).catch(() => undefined);

await db.end();
console.log(`Seeded demo data (bookings on ${tomorrow}). Password for all demo users: pickleball123`);
