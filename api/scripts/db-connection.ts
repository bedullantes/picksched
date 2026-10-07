/**
 * Database connection for command-line scripts (migrate, seed, preflight),
 * with the same environment detection, secret files and TLS settings as the
 * server. Migrations can use a separate, more privileged account through
 * MIGRATION_DATABASE_URL, so the app's own DATABASE_URL user needs no DDL rights.
 */
import pg from 'pg';
import { type DatabaseConfig, loadDatabaseConfig } from '../src/config.js';
import { connectionOptions, describeDatabase } from '../src/db.js';
import { type AppEnv, detectAppEnv, loadEnvFiles, resolveSecretFiles } from '../src/env.js';

export function scriptDatabase(opts: { migration?: boolean } = {}) {
  const appEnv: AppEnv = detectAppEnv();
  loadEnvFiles(appEnv);
  resolveSecretFiles();
  const url = (opts.migration && process.env.MIGRATION_DATABASE_URL) || process.env.DATABASE_URL;
  if (!url) throw new Error(opts.migration ? 'Set MIGRATION_DATABASE_URL or DATABASE_URL' : 'Set DATABASE_URL');
  const cfg: DatabaseConfig = loadDatabaseConfig(appEnv);
  if (appEnv !== 'development' && cfg.sslMode === 'disable') {
    throw new Error(`APP_ENV=${appEnv} requires a TLS database connection (DATABASE_SSL=verify-full)`);
  }
  return { appEnv, url, cfg, target: describeDatabase(url), client: () => new pg.Client(connectionOptions(url, cfg)) };
}
