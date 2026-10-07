import type { Request } from 'express';
import type { Config } from './config.js';
import { withUser, type Db, type Tx } from './db.js';
import type { ScheduleEvents } from './events.js';
import type { PayMongoClient } from './paymongo.js';

export interface Deps {
  db: Db;
  config: Config;
  events: ScheduleEvents;
  /** Present when PayMongo is configured (config.paymongo). */
  paymongo?: PayMongoClient;
}

/** Runs `fn` in a transaction as the request's signed-in user (or anonymous). */
export function asUser<T>(deps: Deps, req: Request, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withUser(deps.db, req.user?.id ?? null, deps.config.dbStatementTimeoutMs, fn);
}
