import { randomBytes } from 'node:crypto';
import { createApp } from './app.js';
import type { Deps } from './context.js';
import { type Config, loadConfig } from './config.js';
import { checkConnection, createPool, describeDatabase } from './db.js';
import { detectAppEnv, loadEnvFiles, resolveSecretFiles } from './env.js';
import { ScheduleEvents } from './events.js';
import { every, startHoldExpiry } from './jobs.js';
import { configureLogger, installConsoleBridge, log } from './logger.js';
import { NotificationDispatcher, transportsFor } from './notifications.js';
import { runPaymentMaintenance } from './payments.js';
import { PayMongoClient } from './paymongo.js';

process.on('unhandledRejection', (reason) => log.error('Unhandled promise rejection', { type: 'error', err: reason }));
process.on('uncaughtException', (err) => {
  log.fatal('Uncaught exception, shutting down', { type: 'error', err });
  setTimeout(() => process.exit(1), 200); // let the log line (and alert) go out
});

function fail(message: string, err?: unknown): never {
  log.fatal(message, err ? { err } : {});
  process.exit(1);
}

// --- Configuration -----------------------------------------------------------
let config: Config;
let startup: Record<string, unknown>;
try {
  const appEnv = detectAppEnv();
  const envFiles = loadEnvFiles(appEnv);
  const valuesFromFiles = resolveSecretFiles();
  if (appEnv === 'development' && !process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = randomBytes(48).toString('base64');
    console.warn('SESSION_SECRET is not set: using a temporary one (sign-ins end when the server restarts). Set it in api/.env.local.');
  }
  config = loadConfig(appEnv);
  configureLogger(config.logging, { env: appEnv });
  startup = { envFiles, valuesFromFiles };
} catch (err) {
  fail(`Configuration error, the server cannot start. ${(err as Error).message}`);
}
installConsoleBridge();

// --- Database ----------------------------------------------------------------
const db = createPool(config.databaseUrl, config.database);
let dbInfo: Awaited<ReturnType<typeof checkConnection>>;
try {
  dbInfo = await checkConnection(db);
} catch (err) {
  fail(`Cannot connect to the database (${JSON.stringify(describeDatabase(config.databaseUrl))})`, err);
}
if (config.database.sslMode !== 'disable' && !dbInfo.tls) {
  fail('The database connection is not encrypted although DATABASE_SSL requires TLS');
}
const events = new ScheduleEvents(config.databaseUrl, config.database);
await events.start();

// --- Services ----------------------------------------------------------------
const paymongo = config.paymongo ? new PayMongoClient(config.paymongo) : undefined;
if (!paymongo) console.warn('PAYMONGO_SECRET_KEY is not set: online payments are disabled.');
const deps: Deps = { db, config, events, paymongo };
deps.notifier = new NotificationDispatcher(deps, transportsFor(config), config.notifications.intervalMs).start();

const stopJobs = [
  startHoldExpiry(deps, config.holdSweepIntervalMs),
  every('Payment maintenance', config.paymentJobIntervalMs, () => runPaymentMaintenance(deps)),
];

const isLocal = (url?: string) => !!url && /^https?:\/\/(localhost|127\.)/.test(url);
const server = createApp(deps).listen(config.port, () => {
  const pm = config.paymongo;
  const email = config.notifications.email;
  const sms = config.notifications.sms;
  log.info(`PickSched API listening on port ${config.port}`, {
    type: 'startup',
    appEnv: config.appEnv,
    nodeEnv: process.env.NODE_ENV ?? null,
    node: process.version,
    ...startup,
    database: {
      ...describeDatabase(config.databaseUrl),
      sslMode: config.database.sslMode, tls: dbInfo.tls, tlsVersion: dbInfo.tlsVersion,
      serverVersion: dbInfo.serverVersion, poolMax: config.database.poolMax,
    },
    integrations: {
      paymongo: !pm ? 'disabled' : isLocal(pm.apiBase) ? 'simulator' : pm.live ? 'live' : 'test',
      email: email.provider === 'sendgrid'
        ? (isLocal(email.sendgrid?.apiBase) ? 'sendgrid (simulator)' : email.sendgrid?.sandbox ? 'sendgrid (sandbox)' : 'sendgrid')
        : `${email.provider} (${config.notifications.transport})`,
      sms: sms.provider === 'twilio' ? (isLocal(sms.twilio?.apiBase) ? 'twilio (simulator)' : 'twilio') : sms.provider,
    },
    security: {
      secureCookies: config.secureCookies, hsts: config.security.hsts, httpsRedirect: config.security.httpsRedirect,
      trustProxy: config.security.trustProxy,
    },
    logging: { level: config.logging.level, format: config.logging.format, errorWebhook: !!config.logging.errorWebhookUrl },
  });
});

const shutdown = async (signal: string) => {
  log.info(`Received ${signal}, shutting down`);
  server.close();
  stopJobs.forEach((stop) => stop());
  deps.notifier?.stop();
  await deps.notifier?.idle();
  await events.stop();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
