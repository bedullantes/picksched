/**
 * Production hardening: security headers, HTTPS handling, request ids,
 * access/error logging, and no leaking of internals.
 */
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { configureLogger, redact, redactString } from '../src/logger.js';
import { contentSecurityPolicy } from '../src/security.js';
import { scanText } from '../scripts/check-secrets.js';
import { startTestApp, testConfig } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof startTestApp>>;

const production: Partial<Config> = {
  appEnv: 'production',
  secureCookies: true,
  security: { trustProxy: 1, hsts: true, hstsMaxAgeSeconds: 63_072_000, httpsRedirect: true, publicUrl: 'https://app.picksched.example' },
};

/** Captures JSON log lines written while `fn` runs. */
async function captureLogs(fn: () => Promise<unknown>) {
  const lines: Record<string, any>[] = [];
  const grab = (chunk: unknown) => {
    for (const l of String(chunk).split('\n').filter(Boolean)) {
      try { lines.push(JSON.parse(l)); } catch { /* not ours */ }
    }
    return true;
  };
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(grab);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(grab);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 20)); // 'finish' handlers
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return lines;
}

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startTestApp(production);
});
afterAll(async () => {
  await ctx?.close();
});
afterEach(() => configureLogger({ level: 'warn', format: 'pretty', accessLog: false }));

const https = () => request(ctx.app).get('/api/courts').set('X-Forwarded-Proto', 'https');

describe('security headers', () => {
  it('sends a strict Content-Security-Policy', async () => {
    const res = await https();
    const csp = res.headers['content-security-policy'];
    for (const d of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", 'upgrade-insecure-requests']) {
      expect(csp).toContain(d);
    }
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  it('sends HSTS over HTTPS (behind the proxy) and anti-framing / sniffing headers', async () => {
    const res = await https();
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({
      'strict-transport-security': 'max-age=63072000; includeSubDomains',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'no-store',
    });
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('adds a CSP report endpoint when configured', () => {
    expect(contentSecurityPolicy({ upgradeInsecure: false, reportUri: 'https://csp.example/r' })).toMatch(/; report-uri https:\/\/csp.example\/r$/);
  });

  it('applies headers to every response, including errors and webhooks', async () => {
    for (const res of [
      await request(ctx.app).get('/api/nope').set('X-Forwarded-Proto', 'https'),
      await request(ctx.app).post('/api/webhooks/paymongo').set('X-Forwarded-Proto', 'https').send('{}'),
    ]) {
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['content-security-policy']).toBeDefined();
    }
  });
});

describe('HTTPS', () => {
  it('redirects plain HTTP to the configured public URL (not the Host header)', async () => {
    const res = await request(ctx.app).get('/bookings?x=1').set('X-Forwarded-Proto', 'http').set('Host', 'evil.example');
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe('https://app.picksched.example/bookings?x=1');
    expect(res.headers['strict-transport-security']).toBeUndefined(); // never over plain HTTP
  });

  it('keeps the health check reachable over HTTP for load balancers', async () => {
    const res = await request(ctx.app).get('/api/health').set('X-Forwarded-Proto', 'http');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('marks the session cookie Secure, HttpOnly and SameSite', async () => {
    const res = await request(ctx.app).post('/api/auth/register').set('X-Forwarded-Proto', 'https')
      .send({ email: `cookie-${Date.now()}@example.com`, password: 'correct horse battery', role: 'player' });
    expect(res.status).toBe(201);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });
});

describe('request ids and logging', () => {
  it('returns a request id, reusing a valid one from the proxy', async () => {
    const own = await https();
    expect(own.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const fromProxy = await https().set('X-Request-Id', 'lb-1234567890abcdef');
    expect(fromProxy.headers['x-request-id']).toBe('lb-1234567890abcdef');
    const bogus = await https().set('X-Request-Id', 'bad id with spaces <script>');
    expect(bogus.headers['x-request-id']).not.toContain('<script>');
  });

  it('writes one structured access-log line per request', async () => {
    configureLogger({ level: 'info', format: 'json', accessLog: true }, { env: 'production' });
    const app = createApp({ ...ctx.deps, config: { ...ctx.config, logging: { level: 'info', format: 'json', accessLog: true } } });
    const reg = await request(ctx.app).post('/api/auth/register').set('X-Forwarded-Proto', 'https')
      .send({ email: `log-${Date.now()}@example.com`, password: 'correct horse battery', role: 'player' });
    const player = reg.body.user;
    const cookie = reg.headers['set-cookie'] as unknown as string[];
    const lines = await captureLogs(() => request(app).get('/api/courts?secret=1').set('Cookie', cookie).set('X-Forwarded-Proto', 'https').set('User-Agent', 'qa'));
    const access = lines.filter((l) => l.type === 'access');
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({
      level: 'info', severity: 'INFO', msg: 'request', service: 'picksched-api', env: 'production',
      method: 'GET', path: '/api/courts', status: 200, userId: player.id, userAgent: 'qa',
    });
    expect(access[0].requestId).toBeTruthy();
    expect(typeof access[0].durationMs).toBe('number');
    expect(JSON.stringify(access[0])).not.toContain('secret=1'); // query strings aren't logged
    expect(JSON.stringify(access[0])).not.toContain('picksched_session');
  });

  it('logs server errors with stack and request id, but tells the client nothing internal', async () => {
    configureLogger({ level: 'info', format: 'json', accessLog: false }, { env: 'production' });
    const failingDb = { query: async () => { throw new Error('relation "users" does not exist; postgres://api:hunter2pw@db:5432/x'); } };
    const app = createApp({ ...ctx.deps, db: failingDb as never });
    let res!: request.Response;
    const lines = await captureLogs(async () => {
      res = await request(app).get('/api/health').set('X-Forwarded-Proto', 'https');
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL', message: 'Something went wrong. Please try again.', requestId: res.headers['x-request-id'] });
    expect(JSON.stringify(res.body)).not.toMatch(/relation|postgres|stack/);
    const [err] = lines.filter((l) => l.type === 'error');
    expect(err).toMatchObject({ level: 'error', severity: 'ERROR', msg: 'Request failed', requestId: res.headers['x-request-id'], path: '/api/health', status: 500 });
    expect(err.err.stack).toContain('relation "users" does not exist');
    expect(JSON.stringify(err)).not.toContain('hunter2pw'); // passwords in messages are masked
  });

  it('maps oversized bodies to 413 instead of a server error', async () => {
    const res = await request(ctx.app).post('/api/auth/login').set('X-Forwarded-Proto', 'https')
      .set('Content-Type', 'application/json').send(JSON.stringify({ email: 'x'.repeat(30_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('redaction', () => {
  it('masks secrets in log fields and messages', () => {
    expect(redact({ password: 'x', authorization: 'Bearer abc', apiKey: 'k', nested: { webhookSecret: 'w', ok: 1 }, secureCookies: true }))
      .toEqual({ password: '[REDACTED]', authorization: '[REDACTED]', apiKey: '[REDACTED]', nested: { webhookSecret: '[REDACTED]', ok: 1 }, secureCookies: true });
    const s = redactString('url postgres://api:pa55word@db/x key sk_live_abcdef123456 hook whsk_abcdef123456 auth Bearer eyJhbGciOiJIUzI1NiJ9 sg SG.aaaaaaaaaaaa.bbbbbbbbbbbb');
    for (const secret of ['pa55word', 'abcdef123456', 'eyJhbGciOiJIUzI1NiJ9', 'aaaaaaaaaaaa']) expect(s).not.toContain(secret);
    expect(s).toContain('postgres://api:***@db/x');
  });
});

describe('secret scanning', () => {
  it('detects real-looking keys but not the simulator placeholders', () => {
    const fake = (parts: string[]) => parts.join(''); // built at runtime so this file doesn't trip the scanner
    const hits = (line: string) => scanText('f', line).map((f) => f.rule);
    expect(hits(`const k = '${fake(['sk_', 'live_', 'a1B2c3D4e5F6g7H8i9J0'])}'`)).toEqual(['PayMongo secret/public key']);
    expect(hits(`${fake(['SG', '.abcdefghijklmnopqrstuv.', 'wxyzABCDEFGHIJKLMNOP'])}`)).toEqual(['SendGrid API key']);
    expect(hits(fake(['AC', '0123456789abcdef0123456789abcdef']))).toEqual(['Twilio Account SID / API key']);
    expect(hits(fake(['postgres://app:', 'Sup3rS3cret', '@db.internal/picksched']))).toEqual(['Database URL with password']);
    expect(hits(fake(['SESSION_SECRET=', 'q8Z1vR4mN7xK2pL9sT6wY3bH']))).toEqual(['Secret assignment']);
    for (const ok of ['sk_test_local', 'sk_test_fake_secret', 'SG.local', 'whsk_local', 'postgres://postgres@localhost/picksched',
      'DATABASE_URL=<secret: postgres://picksched_api:PASSWORD@prod-db.internal:5432/picksched>', 'SESSION_SECRET=<secret: openssl rand -base64 48>']) {
      expect(hits(ok), ok).toEqual([]);
    }
  });
});

describe('development defaults', () => {
  it('omits HSTS and redirects when not configured', async () => {
    const dev = await startTestApp();
    try {
      const res = await request(dev.app).get('/api/courts');
      expect(res.status).toBe(200);
      expect(res.headers['strict-transport-security']).toBeUndefined();
      expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
      expect(res.headers['x-frame-options']).toBe('DENY'); // the rest still applies
    } finally {
      await dev.close();
    }
  });

  it('testConfig stays a development config', () => {
    expect(testConfig().appEnv).toBe('development');
  });
});
