import type { Deps } from './context.js';
import { withUser } from './db.js';

/**
 * Cancels unpaid bookings whose checkout hold has expired (expires_at in the
 * past) and returns how many it released. Safe to run from several API
 * instances at once. Each release triggers a schedule-change notification,
 * so open calendars show the slot as available again.
 */
export async function expireStaleHolds(deps: Pick<Deps, 'db' | 'config'>): Promise<number> {
  return withUser(deps.db, null, deps.config.dbStatementTimeoutMs, async (tx) =>
    (await tx.query('SELECT expire_stale_bookings() AS n')).rows[0].n);
}

/** Runs expireStaleHolds every `intervalMs`. Returns a function that stops it. */
export function startHoldExpiry(deps: Pick<Deps, 'db' | 'config'>, intervalMs: number): () => void {
  const run = async () => {
    try {
      const n = await expireStaleHolds(deps);
      if (n > 0) console.log(`Released ${n} expired booking hold${n === 1 ? '' : 's'}`);
    } catch (err) {
      console.error('Hold expiry sweep failed:', (err as Error).message);
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}

/** Runs `task` every `intervalMs` (and once now), logging failures. Returns a stop function. */
export function every(name: string, intervalMs: number, task: () => Promise<unknown>): () => void {
  let running = false;
  const run = async () => {
    if (running) return; // don't overlap slow runs
    running = true;
    try {
      await task();
    } catch (err) {
      console.error(`${name} failed:`, (err as Error).message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
