import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { ScheduleEvents } from './events.js';
import { startHoldExpiry } from './jobs.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const events = new ScheduleEvents(config.databaseUrl);
await events.start();
const stopHoldExpiry = startHoldExpiry({ db, config }, config.holdSweepIntervalMs);

const server = createApp({ db, config, events }).listen(config.port, () => {
  console.log(`PickSched API listening on http://localhost:${config.port}`);
});

const shutdown = async () => {
  server.close();
  stopHoldExpiry();
  await events.stop();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
