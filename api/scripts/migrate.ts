/**
 * Applies db/migrations/*.sql in order, skipping ones already applied.
 * Usage: DATABASE_URL=postgres://... npm run migrate -w api
 * The user needs privileges to create extensions and roles (migration 002).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL');

const dir = path.resolve(import.meta.dirname, '../../db/migrations');
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
const applied = new Set((await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));

for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  if (applied.has(file)) continue;
  process.stdout.write(`Applying ${file}... `);
  // Each migration file manages its own transaction (BEGIN/COMMIT).
  await client.query(readFileSync(path.join(dir, file), 'utf8'));
  await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
  console.log('done');
}
await client.end();
console.log('Database is up to date.');
