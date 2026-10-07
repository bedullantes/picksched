/**
 * Applies db/migrations/*.sql in order, skipping ones already applied.
 * Usage: DATABASE_URL=postgres://... npm run migrate -w api
 * The user needs privileges to create extensions and roles (migration 002);
 * in staging/production set MIGRATION_DATABASE_URL to such an account and
 * keep DATABASE_URL for the app's less privileged user. Uses the same TLS
 * settings as the server (DATABASE_SSL, DATABASE_CA_CERT).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { scriptDatabase } from './db-connection.js';

const db = scriptDatabase({ migration: true });
const dir = path.resolve(import.meta.dirname, '../../db/migrations');
const client = db.client();
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
