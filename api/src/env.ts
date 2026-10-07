/**
 * Runtime environment: development, staging or production.
 *
 * APP_ENV selects it explicitly. When it isn't set, NODE_ENV=production means
 * production and anything else means development, so a production deploy
 * can never fall back to development settings by accident.
 *
 * Where configuration comes from:
 *   development  process environment, then api/.env.local (git-ignored, your
 *                own keys), then api/.env.development (committed, no
 *                secrets: points at the local simulators). Real environment
 *                variables always win.
 *   staging,     process environment only, injected by the hosting platform or
 *   production   its secret manager. No .env files are read from the image.
 *
 * Each secret (SECRET_VARIABLES) can instead be given as NAME_FILE=/path
 * (Docker and Kubernetes secrets, mounted secret-manager volumes); the
 * file's contents are used as the value. Setting both NAME and NAME_FILE is
 * an error. Other *_FILE variables (PIP_CONFIG_FILE, ...) are left alone.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type AppEnv = 'development' | 'staging' | 'production';
export const APP_ENVS: readonly AppEnv[] = ['development', 'staging', 'production'];

export function detectAppEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const explicit = env.APP_ENV?.trim().toLowerCase();
  if (explicit) {
    if (!(APP_ENVS as readonly string[]).includes(explicit)) {
      throw new Error(`APP_ENV must be one of ${APP_ENVS.join(', ')} (got "${env.APP_ENV}")`);
    }
    if (explicit === 'development' && env.NODE_ENV === 'production') {
      throw new Error('APP_ENV=development cannot run with NODE_ENV=production');
    }
    return explicit as AppEnv;
  }
  return env.NODE_ENV === 'production' ? 'production' : 'development';
}

/**
 * Loads the development .env files (never in staging or production, and not
 * under NODE_ENV=test, where tests set everything explicitly). Returns the files read.
 */
export function loadEnvFiles(appEnv: AppEnv, dir = path.resolve(import.meta.dirname, '..')): string[] {
  if (appEnv !== 'development' || process.env.NODE_ENV === 'test') return [];
  const loaded: string[] = [];
  // process.loadEnvFile doesn't override variables that are already set, so
  // load the most specific file first.
  for (const name of ['.env.local', '.env.development']) {
    const file = path.join(dir, name);
    if (existsSync(file)) {
      process.loadEnvFile(file);
      loaded.push(name);
    }
  }
  return loaded;
}

/** Configuration values that are secrets: kept out of the repository, injected per environment. */
export const SECRET_VARIABLES = [
  'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'DATABASE_CA_CERT', 'SESSION_SECRET',
  'PAYMONGO_SECRET_KEY', 'PAYMONGO_WEBHOOK_SECRET',
  'SENDGRID_API_KEY',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'NOTIFICATIONS_WEBHOOK_URL', 'ERROR_WEBHOOK_URL',
] as const;

/** Resolves NAME_FILE into NAME for each secret (trailing newline trimmed). Returns the names resolved. */
export function resolveSecretFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const resolved: string[] = [];
  for (const name of SECRET_VARIABLES) {
    const key = `${name}_FILE`;
    const file = env[key];
    if (!file) continue;
    if (env[name]) throw new Error(`Set either ${name} or ${key}, not both`);
    let value: string;
    try {
      value = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    } catch (err) {
      throw new Error(`${key}: cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    if (!value) throw new Error(`${key}: ${file} is empty`);
    env[name] = value;
    resolved.push(name);
  }
  return resolved;
}
