/**
 * Environment configuration: development / staging / production are told
 * apart at startup and each environment's rules are enforced.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { detectAppEnv, loadEnvFiles, resolveSecretFiles } from '../src/env.js';

const saved = { ...process.env };

/** Replaces the whole environment (in place: process.loadEnvFile writes to the real process.env). */
function replaceEnv(vars: Record<string, string | undefined>) {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, vars);
}
const setEnv = (vars: Record<string, string>) => replaceEnv({ PATH: saved.PATH, ...vars });
afterEach(() => replaceEnv(saved));

const STRONG_SECRET = 'q8Z1vR4mN7xK2pL9sT6wY3bH5cJ0dF8gA1eU4iO7';
const PRODUCTION: Record<string, string> = {
  APP_ENV: 'production',
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://picksched_api:s3cr3t-pw@db.internal:5432/picksched',
  DATABASE_SSL: 'verify-full',
  SESSION_SECRET: STRONG_SECRET,
  APP_BASE_URL: 'https://app.picksched.example',
  PAYMONGO_SECRET_KEY: 'sk_live_xxxxxxxx',
  PAYMONGO_WEBHOOK_SECRET: 'whsk_xxxxxxxx',
  SENDGRID_API_KEY: 'SG.xxxx',
  SENDGRID_FROM_EMAIL: 'bookings@picksched.example',
  TWILIO_ACCOUNT_SID: 'ACxxxx',
  TWILIO_AUTH_TOKEN: 'xxxx',
  TWILIO_MESSAGING_SERVICE_SID: 'MGxxxx',
};
const STAGING = { ...PRODUCTION, APP_ENV: 'staging', PAYMONGO_SECRET_KEY: 'sk_test_xxxxxxxx' };
const DEVELOPMENT = { DATABASE_URL: 'postgres://postgres@localhost/picksched', SESSION_SECRET: STRONG_SECRET };

const problems = (vars: Record<string, string>, env: 'development' | 'staging' | 'production') => {
  setEnv(vars);
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    return (err as Error).message.split('\n').slice(1).map((l) => l.replace(/^\s+- /, ''));
  }
};

describe('detecting the environment', () => {
  it('uses APP_ENV, falling back to NODE_ENV', () => {
    expect(detectAppEnv({ APP_ENV: 'staging', NODE_ENV: 'production' })).toBe('staging');
    expect(detectAppEnv({ APP_ENV: 'Production' })).toBe('production');
    expect(detectAppEnv({ NODE_ENV: 'production' })).toBe('production');
    expect(detectAppEnv({ NODE_ENV: 'development' })).toBe('development');
    expect(detectAppEnv({})).toBe('development');
  });

  it('rejects unknown or contradictory values', () => {
    expect(() => detectAppEnv({ APP_ENV: 'prod' })).toThrow(/APP_ENV must be one of/);
    expect(() => detectAppEnv({ APP_ENV: 'development', NODE_ENV: 'production' })).toThrow(/cannot run with NODE_ENV=production/);
  });

  it('loads .env files only in development', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'env-'));
    writeFileSync(path.join(dir, '.env.development'), 'FROM_DEV_FILE=dev\nSHARED=dev\n');
    writeFileSync(path.join(dir, '.env.local'), 'SHARED=local\n');
    setEnv({});
    expect(loadEnvFiles('production', dir)).toEqual([]);
    expect(loadEnvFiles('staging', dir)).toEqual([]);
    expect(process.env.FROM_DEV_FILE).toBeUndefined();
    expect(loadEnvFiles('development', dir)).toEqual(['.env.local', '.env.development']);
    expect(process.env.FROM_DEV_FILE).toBe('dev');
    expect(process.env.SHARED).toBe('local'); // .env.local wins over the committed defaults
    setEnv({ SHARED: 'shell' });
    loadEnvFiles('development', dir);
    expect(process.env.SHARED).toBe('shell'); // real environment wins over both
  });
});

describe('secrets from files (Docker / Kubernetes / secret-manager mounts)', () => {
  it('reads NAME_FILE into NAME', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'secret-'));
    const file = path.join(dir, 'session');
    writeFileSync(file, `${STRONG_SECRET}\n`);
    setEnv({ SESSION_SECRET_FILE: file });
    expect(resolveSecretFiles()).toEqual(['SESSION_SECRET']);
    expect(process.env.SESSION_SECRET).toBe(STRONG_SECRET);
  });

  it('rejects ambiguous, missing or empty secret files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'secret-'));
    writeFileSync(path.join(dir, 'empty'), '');
    expect(() => resolveSecretFiles({ SESSION_SECRET: 'x', SESSION_SECRET_FILE: '/x' })).toThrow(/either SESSION_SECRET or SESSION_SECRET_FILE/);
    expect(() => resolveSecretFiles({ SENDGRID_API_KEY_FILE: path.join(dir, 'missing') })).toThrow(/cannot read/);
    expect(() => resolveSecretFiles({ TWILIO_AUTH_TOKEN_FILE: path.join(dir, 'empty') })).toThrow(/is empty/);
  });

  it("ignores other programs' *_FILE variables", () => {
    const env = { PIP_CONFIG_FILE: '/does/not/exist', KUBECONFIG_FILE: '/nope' };
    expect(resolveSecretFiles(env)).toEqual([]);
    expect(env).toEqual({ PIP_CONFIG_FILE: '/does/not/exist', KUBECONFIG_FILE: '/nope' });
  });
});

describe('production', () => {
  it('starts with live keys, verified database TLS and hardened defaults', () => {
    setEnv(PRODUCTION);
    const c = loadConfig('production');
    expect(c.appEnv).toBe('production');
    expect(c.paymongo?.live).toBe(true);
    expect(c.database).toMatchObject({ sslMode: 'verify-full', poolMax: 20, maxLifetimeSeconds: 1800, applicationName: 'picksched-api-production' });
    expect(c.secureCookies).toBe(true);
    expect(c.security).toMatchObject({ hsts: true, httpsRedirect: true, trustProxy: 1, publicUrl: 'https://app.picksched.example' });
    expect(c.logging).toMatchObject({ format: 'json', accessLog: true, level: 'info' });
  });

  it('refuses PayMongo test keys and simulator endpoints', () => {
    expect(problems({ ...PRODUCTION, PAYMONGO_SECRET_KEY: 'sk_test_xxxxxxxx' }, 'production'))
      .toContain('production must use PayMongo live keys (sk_live_), not test keys');
    const p = problems({
      ...PRODUCTION, PAYMONGO_API_BASE: 'http://localhost:4010/v1', SENDGRID_API_BASE: 'http://127.0.0.1:4020',
      TWILIO_API_BASE: 'http://localhost:4020',
    }, 'production');
    expect(p.join('\n')).toMatch(/PAYMONGO_API_BASE must be https:\/\/api.paymongo.com\/v1/);
    expect(p.join('\n')).toMatch(/SENDGRID_API_BASE points at a local simulator/);
    expect(p.join('\n')).toMatch(/TWILIO_API_BASE points at a local simulator/);
  });

  it('requires payments, real email delivery and an explicit SMS choice', () => {
    const { PAYMONGO_SECRET_KEY: _k, SENDGRID_API_KEY: _s, TWILIO_ACCOUNT_SID: _t, ...rest } = PRODUCTION;
    const p = problems(rest, 'production');
    expect(p).toContain('PAYMONGO_SECRET_KEY is required');
    expect(p).toContain('production must send email through SendGrid (set SENDGRID_API_KEY)');
    expect(p).toContain('set Twilio credentials for SMS, or SMS_PROVIDER=off to send email only');
    expect(problems({ ...PRODUCTION, SENDGRID_SANDBOX_MODE: 'true' }, 'production'))
      .toContain('SENDGRID_SANDBOX_MODE must be off in production (it delivers nothing)');
    const { TWILIO_ACCOUNT_SID: _a, TWILIO_AUTH_TOKEN: _b, TWILIO_MESSAGING_SERVICE_SID: _c, ...emailOnly } = PRODUCTION;
    expect(problems({ ...emailOnly, SMS_PROVIDER: 'off' }, 'production')).toEqual([]);
  });

  it('requires an encrypted, verified database connection', () => {
    expect(problems({ ...PRODUCTION, DATABASE_SSL: 'disable' }, 'production'))
      .toContain('database connections must use TLS (DATABASE_SSL=verify-full)');
    expect(problems({ ...PRODUCTION, DATABASE_SSL: 'require' }, 'production').join()).toMatch(/must verify the server certificate/);
    // sslmode in the URL is honored when DATABASE_SSL isn't set
    const { DATABASE_SSL: _d, ...noMode } = PRODUCTION;
    expect(problems({ ...noMode, DATABASE_URL: `${PRODUCTION.DATABASE_URL}?sslmode=disable` }, 'production').join()).toMatch(/must use TLS/);
    setEnv(noMode);
    expect(loadConfig('production').database.sslMode).toBe('verify-full'); // the default when deployed
  });

  it('requires secure cookies, HSTS, a strong session secret and an https app URL', () => {
    const p = problems({
      ...PRODUCTION, COOKIE_SECURE: 'false', HSTS: 'false', SESSION_SECRET: 'a'.repeat(40), APP_BASE_URL: 'http://app.example',
    }, 'production');
    expect(p).toEqual(expect.arrayContaining([
      'COOKIE_SECURE must be true (session cookie over HTTPS only)',
      'HSTS must be enabled in production',
      'SESSION_SECRET looks weak: use 32+ random bytes (e.g. openssl rand -base64 48)',
      'APP_BASE_URL must be an https:// URL',
    ]));
  });

  it("reports every problem at once and never echoes secret values", () => {
    setEnv({ ...PRODUCTION, PAYMONGO_SECRET_KEY: 'sk_test_supersecretvalue', DATABASE_SSL: 'disable' });
    let message = '';
    try {
      loadConfig('production');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^Invalid configuration for APP_ENV=production:/);
    expect(message.split('\n').length).toBeGreaterThanOrEqual(3);
    expect(message).not.toContain('supersecretvalue');
    expect(message).not.toContain('s3cr3t-pw');
  });
});

describe('staging', () => {
  it('uses test keys and still requires TLS and secure cookies', () => {
    setEnv(STAGING);
    expect(loadConfig('staging')).toMatchObject({ appEnv: 'staging', secureCookies: true, paymongo: { live: false } });
    expect(problems({ ...STAGING, PAYMONGO_SECRET_KEY: 'sk_live_xxxxxxxx' }, 'staging'))
      .toContain('live PayMongo keys (sk_live_) are only allowed with APP_ENV=production');
    expect(problems({ ...STAGING, DATABASE_SSL: 'disable' }, 'staging').join()).toMatch(/must use TLS/);
    // Staging may skip certificate verification (e.g. a provider without a CA bundle) and use SendGrid's sandbox.
    expect(problems({ ...STAGING, DATABASE_SSL: 'require', SENDGRID_SANDBOX_MODE: 'true' }, 'staging')).toEqual([]);
  });
});

describe('development', () => {
  it('is permissive (simulators, no TLS) but never accepts live payment keys', () => {
    setEnv({ ...DEVELOPMENT, PAYMONGO_SECRET_KEY: 'sk_test_local', PAYMONGO_WEBHOOK_SECRET: 'whsk_local',
      PAYMONGO_API_BASE: 'http://localhost:4010/v1', APP_BASE_URL: 'http://localhost:5173' });
    const c = loadConfig('development');
    expect(c).toMatchObject({ appEnv: 'development', secureCookies: false, database: { sslMode: 'disable', maxLifetimeSeconds: 0 } });
    expect(c.security).toMatchObject({ hsts: false, httpsRedirect: false, trustProxy: false });
    expect(c.logging.format).toBe('pretty');
    expect(problems({ ...DEVELOPMENT, PAYMONGO_SECRET_KEY: 'sk_live_xxxxxxxx', PAYMONGO_WEBHOOK_SECRET: 'whsk_x', APP_BASE_URL: 'http://localhost:5173' }, 'development'))
      .toEqual(['live PayMongo keys (sk_live_) are only allowed with APP_ENV=production']);
  });

  it('validates enumerated settings', () => {
    setEnv({ ...DEVELOPMENT, LOG_LEVEL: 'verbose' });
    expect(() => loadConfig('development')).toThrow(/LOG_LEVEL must be one of/);
    setEnv({ ...DEVELOPMENT, DATABASE_SSL: 'maybe' });
    expect(() => loadConfig('development')).toThrow(/DATABASE_SSL must be one of/);
  });
});
