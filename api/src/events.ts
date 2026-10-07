import { EventEmitter } from 'node:events';
import pg from 'pg';
import type { DatabaseConfig } from './config.js';
import { connectionOptions } from './db.js';

export interface ScheduleChange {
  courtId: string;
  startTime: string;
  endTime: string;
}

const CHANNEL = 'picksched_schedule';

/**
 * Listens for the database's schedule-change notifications (migration 003)
 * and re-emits them:
 *   'change' (ScheduleChange)  a booking or maintenance block changed
 *   'resync' ()                the listener reconnected; clients may have
 *                              missed changes and should refetch
 */
export class ScheduleEvents extends EventEmitter {
  private client: pg.Client | null = null;
  private stopped = false;
  private retryMs = 1000;
  private everConnected = false;

  constructor(private readonly databaseUrl: string, private readonly dbConfig?: DatabaseConfig) {
    super();
    this.setMaxListeners(0);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client(connectionOptions(this.databaseUrl, this.dbConfig));
    let failed = false;
    const onFailure = () => {
      if (failed) return;
      failed = true;
      if (this.client === client) this.client = null;
      client.end().catch(() => undefined);
      this.reconnectLater();
    };
    client.on('error', onFailure);
    client.on('end', onFailure);
    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        const p = JSON.parse(msg.payload);
        this.emit('change', {
          courtId: p.court_id,
          startTime: new Date(p.start_time).toISOString(),
          endTime: new Date(p.end_time).toISOString(),
        } satisfies ScheduleChange);
      } catch {
        // ignore malformed payloads
      }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.client = client;
      this.retryMs = 1000;
      if (this.everConnected) this.emit('resync');
      this.everConnected = true;
    } catch (err) {
      console.error('Schedule listener failed to connect:', (err as Error).message);
      onFailure();
    }
  }

  private reconnectLater() {
    if (this.stopped) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    setTimeout(() => void this.connect(), delay).unref();
  }
}
