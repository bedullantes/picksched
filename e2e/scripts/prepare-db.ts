/**
 * Creates a fresh end-to-end database, applies every migration and seeds the
 * demo data. Runs before the API starts (see playwright.config.ts).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { ADMIN_DATABASE_URL, DATABASE_NAME, DATABASE_URL } from '../env.js';

const admin = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DATABASE_NAME} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DATABASE_NAME}`);
await admin.end();

const apiDir = path.resolve(import.meta.dirname, '../../api');
const run = (script: string) => execFileSync('npx', ['tsx', script], {
  cwd: apiDir, env: { ...process.env, DATABASE_URL }, stdio: 'inherit',
});
run('scripts/migrate.ts');
run('scripts/seed-demo.ts');
console.log(`End-to-end database ${DATABASE_NAME} is ready.`);
