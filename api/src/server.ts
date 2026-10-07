import { createApp } from './app.js';
import type { Deps } from './context.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { ScheduleEvents } from './events.js';
import { every, startHoldExpiry } from './jobs.js';
import { NotificationDispatcher, transportsFor } from './notifications.js';
import { runPaymentMaintenance } from './payments.js';
import { PayMongoClient } from './paymongo.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const events = new ScheduleEvents(config.databaseUrl);
await events.start();
const paymongo = config.paymongo ? new PayMongoClient(config.paymongo) : undefined;
if (!paymongo) console.warn('PAYMONGO_SECRET_KEY is not set: online payments are disabled.');
const deps: Deps = { db, config, events, paymongo };
deps.notifier = new NotificationDispatcher(deps, transportsFor(config), config.notifications.intervalMs).start();

const stopJobs = [
  startHoldExpiry(deps, config.holdSweepIntervalMs),
  every('Payment maintenance', config.paymentJobIntervalMs, () => runPaymentMaintenance(deps)),
];

const server = createApp(deps).listen(config.port, () => {
  console.log(`PickSched API listening on http://localhost:${config.port}`);
});

const shutdown = async () => {
  server.close();
  stopJobs.forEach((stop) => stop());
  deps.notifier?.stop();
  await deps.notifier?.idle();
  await events.stop();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
