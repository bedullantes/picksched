import type { AddressInfo } from 'node:net';
import pg from 'pg';
import request from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createPool } from '../src/db.js';
import { ScheduleEvents } from '../src/events.js';
import { PayMongoClient } from '../src/paymongo.js';
import { startFakePayMongo } from './fake-paymongo.js';
import { startFakeMessaging } from './fake-messaging.js';
import { NotificationDispatcher, transportsFor } from '../src/notifications.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    databaseUrl: inject('databaseUrl'),
    sessionSecret: 'test-secret-test-secret-test-secret-!!',
    sessionTtlSeconds: 3600,
    secureCookies: false,
    bcryptRounds: 4,
    dbStatementTimeoutMs: 5000,
    maxBookingHours: 4,
    holdSweepIntervalMs: 60_000,
    notifications: {
      transport: 'log', intervalMs: 60_000, email: { provider: 'log' }, sms: { provider: 'log' }, defaultCountryCode: '63',
    },
    paymentJobIntervalMs: 60_000,
    appEnv: 'development',
    database: {
      sslMode: 'disable', poolMax: 20, poolMin: 0, idleTimeoutMs: 30_000, connectionTimeoutMs: 5000,
      maxLifetimeSeconds: 0, applicationName: 'picksched-api-test',
    },
    security: { trustProxy: false, hsts: false, hstsMaxAgeSeconds: 63_072_000, httpsRedirect: false },
    logging: { level: 'warn', format: 'pretty', accessLog: false },
    ...overrides,
  };
}

export const PAYMONGO_SECRET = 'sk_test_fake_secret';
export const PAYMONGO_WEBHOOK_SECRET = 'whsk_fake_webhook_secret';

export const SENDGRID_KEY = 'SG.fake-key';
export const TWILIO_SID = 'ACfake0000000000000000000000000000';
export const TWILIO_TOKEN = 'fake-twilio-auth-token';

/**
 * Starts the API against the test database, with a fake PayMongo behind it.
 * With { messaging: true }, notifications are dispatched automatically
 * through fake SendGrid and Twilio servers, as in production.
 */
export async function startTestApp(overrides: Partial<Config> = {}, opts: { messaging?: boolean } = {}) {
  const paymongoFake = await startFakePayMongo({ secretKey: PAYMONGO_SECRET, webhookSecret: PAYMONGO_WEBHOOK_SECRET });
  const messagingFake = opts.messaging
    ? await startFakeMessaging({ sendgridKey: SENDGRID_KEY, twilioSid: TWILIO_SID, twilioToken: TWILIO_TOKEN })
    : undefined;
  if (messagingFake) {
    overrides = {
      notifications: {
        transport: 'log', intervalMs: 500, defaultCountryCode: '63',
        email: { provider: 'sendgrid', sendgrid: {
          apiKey: SENDGRID_KEY, fromEmail: 'bookings@picksched.test', fromName: 'PickSched',
          apiBase: messagingFake.baseUrl, timeoutMs: 2000, sandbox: false,
        } },
        sms: { provider: 'twilio', twilio: {
          accountSid: TWILIO_SID, authToken: TWILIO_TOKEN, messagingServiceSid: 'MGfake', apiBase: messagingFake.baseUrl,
          timeoutMs: 2000, statusCallbackUrl: 'https://picksched.test/api/webhooks/twilio/status',
        } },
      },
      ...overrides,
    };
  }
  const config = testConfig({
    paymongo: {
      secretKey: PAYMONGO_SECRET,
      webhookSecret: PAYMONGO_WEBHOOK_SECRET,
      apiBase: paymongoFake.apiBase,
      timeoutMs: 2000,
      appBaseUrl: 'http://app.test',
      methods: ['gcash', 'paymaya'],
      live: false,
    },
    ...overrides,
  });
  const db = createPool(config.databaseUrl);
  const events = new ScheduleEvents(config.databaseUrl);
  await events.start();
  const paymongo = config.paymongo ? new PayMongoClient(config.paymongo) : undefined;
  const deps: import('../src/context.js').Deps = { db, config, events, paymongo };
  if (messagingFake) deps.notifier = new NotificationDispatcher(deps, transportsFor(config), config.notifications.intervalMs).start();
  const app = createApp(deps);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  paymongoFake.state.webhookUrl = `${baseUrl}/api/webhooks/paymongo`;
  // Superuser connection for fixtures and for simulating the passage of time.
  const admin = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
  return {
    app, db, events, admin, baseUrl, config, deps, paymongoFake, messagingFake,
    async close() {
      deps.notifier?.stop();
      await deps.notifier?.idle();
      await messagingFake?.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await events.stop();
      await db.end();
      await admin.end();
      await paymongoFake.close();
    },
  };
}

let counter = 0;
export function uniqueEmail(prefix: string) {
  return `${prefix}-${process.pid}-${Date.now()}-${counter++}@example.com`;
}

export async function signUp(baseUrl: string, role: 'player' | 'admin', prefix: string = role) {
  const agent = request.agent(baseUrl);
  const email = uniqueEmail(prefix);
  const res = await agent.post('/api/auth/register').send({ email, password: 'correct horse battery', role });
  if (res.status !== 201) throw new Error(`sign-up failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, email, id: res.body.user.id as string };
}

/** Local date (YYYY-MM-DD) in Asia/Manila, offset by `days` from today. */
export async function manilaDate(admin: pg.Pool, days: number): Promise<string> {
  return (await admin.query(
    `SELECT ((now() AT TIME ZONE 'Asia/Manila')::date + $1::int)::text AS d`, [days])).rows[0].d;
}

/** ISO timestamp for hour `h` on a Manila local date (Manila is UTC+8, no DST). */
export const at = (date: string, h: number, m = 0) =>
  new Date(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`).toISOString();
