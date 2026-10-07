/**
 * Pre-launch check for an environment. Run it with the same environment
 * variables / secrets as the server (e.g. as a release or init job):
 *
 *   APP_ENV=production npm run preflight -w api
 *
 * It validates the configuration rules for that environment, then connects
 * to the database exactly like the server and checks: TLS is in use (and
 * verified where required), every pooled connection is encrypted, the login
 * role can't bypass row-level security, it can act as picksched_app, and all
 * migrations are applied. Prints no secrets. Exits 1 if anything fails.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { checkConnection, createPool, describeDatabase, withUser } from '../src/db.js';
import { detectAppEnv, loadEnvFiles, resolveSecretFiles } from '../src/env.js';

let failures = 0;
const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const bad = (msg: string) => { failures++; console.log(`  ✘ ${msg}`); };
const warn = (msg: string) => console.log(`  ! ${msg}`);

const appEnv = detectAppEnv();
const envFiles = loadEnvFiles(appEnv);
const fromFiles = resolveSecretFiles();
const strict = appEnv !== 'development';
console.log(`Preflight for APP_ENV=${appEnv}`);
console.log(`  config sources: environment${envFiles.length ? ` + ${envFiles.join(', ')}` : ''}${fromFiles.length ? `; from files: ${fromFiles.join(', ')}` : ''}`);

console.log('\nConfiguration');
let config;
try {
  config = loadConfig(appEnv);
  ok(`valid for ${appEnv}`);
  const pm = config.paymongo;
  ok(`PayMongo: ${pm ? (pm.live ? 'live keys' : 'test keys') + (pm.apiBase.startsWith('https://api.paymongo.com') ? '' : ` via ${pm.apiBase}`) : 'disabled'}`);
  ok(`Email: ${config.notifications.email.provider}${config.notifications.email.sendgrid?.sandbox ? ' (sandbox)' : ''}; SMS: ${config.notifications.sms.provider}`);
  ok(`Cookies secure: ${config.secureCookies}; HSTS: ${config.security.hsts}; HTTPS redirect: ${config.security.httpsRedirect}; logs: ${config.logging.format}`);
} catch (err) {
  bad((err as Error).message.replace(/\n/g, '\n    '));
  console.log('\nPreflight FAILED');
  process.exit(1);
}

console.log('\nDatabase');
const target = describeDatabase(config.databaseUrl);
console.log(`  target: ${target.user}@${target.host}:${target.port}/${target.database} (sslMode=${config.database.sslMode}, pool max ${config.database.poolMax})`);
const db = createPool(config.databaseUrl, config.database);
try {
  const info = await checkConnection(db);
  ok(`connected (PostgreSQL ${info.serverVersion})`);
  if (info.tls) ok(`encrypted with ${info.tlsVersion}${config.database.sslMode === 'verify-full' ? ', server certificate verified' : ' (certificate NOT verified)'}`);
  else if (strict) bad('connection is NOT encrypted');
  else warn('connection is not encrypted (fine for local development)');

  const n = Math.min(5, config.database.poolMax);
  const all = await Promise.all(Array.from({ length: n }, () => checkConnection(db)));
  if (all.every((r) => r.tls === info.tls)) ok(`connection pool: ${n} concurrent connections opened (max ${config.database.poolMax})`);
  else bad('pooled connections differ in encryption');

  const [role] = (await db.query(
    `SELECT current_user AS name, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls,
            pg_has_role(current_user, 'picksched_app', 'MEMBER') AS app_member,
            (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owned_tables
     FROM pg_roles r WHERE r.rolname = current_user`)).rows;
  if (role.superuser || role.bypass_rls || role.owned_tables > 0) {
    const why = role.superuser ? 'is a superuser' : role.bypass_rls ? 'has BYPASSRLS' : `owns ${role.owned_tables} tables`;
    (strict ? bad : warn)(`login role "${role.name}" ${why}: use a dedicated role that is only a member of picksched_app (see docs/deployment.md)`);
  } else {
    ok(`login role "${role.name}" is unprivileged`);
  }
  if (role.app_member || role.superuser) {
    await withUser(db, null, 5000, (tx) => tx.query('SELECT count(*) FROM courts'));
    ok('can act as picksched_app (row-level security applies)');
  } else {
    bad(`login role "${role.name}" is not a member of picksched_app: GRANT picksched_app TO ${role.name};`);
  }

  const files = readdirSync(path.resolve(import.meta.dirname, '../../db/migrations')).filter((f) => f.endsWith('.sql')).sort();
  // The migration account (if separate) owns schema_migrations; the app role may not be able to read it.
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  const reader = migrationUrl ? createPool(migrationUrl, { ...config.database, poolMax: 1 }) : db;
  const applied = await reader.query('SELECT filename FROM schema_migrations').then(
    (r) => new Set(r.rows.map((x) => x.filename as string)), () => null);
  if (reader !== db) await reader.end();
  if (!applied) warn("can't read schema_migrations with this role; run `npm run migrate` as part of the release");
  else {
    const missing = files.filter((f) => !applied.has(f));
    if (missing.length) bad(`migrations not applied: ${missing.join(', ')}`);
    else ok(`all ${files.length} migrations applied`);
  }
} catch (err) {
  bad(`database check failed: ${(err as Error).message}`);
} finally {
  await db.end();
}

console.log(failures ? `\nPreflight FAILED (${failures} problem${failures === 1 ? '' : 's'})` : '\nPreflight passed');
process.exit(failures ? 1 : 0);
