import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

/**
 * Creates a fresh test database and applies every migration in db/migrations.
 * TEST_DATABASE_URL must point at a server where the user can create
 * databases and roles (the database name in the URL is used only to connect).
 */
export default async function setup({ provide }: { provide: (k: string, v: string) => void }) {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    throw new Error('Set TEST_DATABASE_URL, e.g. postgres://postgres@127.0.0.1:5432/postgres');
  }
  const dbName = `picksched_api_test_${process.pid}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  admin.on('error', (e) => console.error('admin client error', e.message));
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  const dir = path.resolve(import.meta.dirname, '../../db/migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.query(readFileSync(path.join(dir, file), 'utf8'));
  }
  await db.end();
  provide('databaseUrl', url.toString());

  return async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
