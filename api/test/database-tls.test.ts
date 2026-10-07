/**
 * Encrypted database connections. Runs against a PostgreSQL server with TLS
 * enabled; set TEST_DATABASE_TLS_CA to the PEM of the CA that signed the
 * server certificate (issued for "localhost"). Skipped otherwise.
 */
import { readFileSync } from 'node:fs';
import { inject } from 'vitest';
import { afterAll, describe, expect, it } from 'vitest';
import type { DatabaseConfig } from '../src/config.js';
import { checkConnection, connectionOptions, createPool, describeDatabase, type Db } from '../src/db.js';
import { ScheduleEvents } from '../src/events.js';

const caFile = process.env.TEST_DATABASE_TLS_CA;
const base: DatabaseConfig = {
  sslMode: 'verify-full', poolMax: 4, poolMin: 0, idleTimeoutMs: 1000, connectionTimeoutMs: 3000,
  maxLifetimeSeconds: 60, applicationName: 'picksched-tls-test',
};

describe('connection options', () => {
  it('maps TLS modes and strips conflicting ssl settings from the URL', () => {
    const url = 'postgres://api:pw@db.example:5432/app?sslmode=disable&sslrootcert=/x.pem&application_name=x';
    const full = connectionOptions(url, { ...base, caCert: 'PEM' });
    expect(full.ssl).toEqual({ rejectUnauthorized: true, ca: 'PEM' });
    expect(full.connectionString).not.toMatch(/sslmode|sslrootcert/);
    expect(full.application_name).toBe('picksched-tls-test');
    expect(connectionOptions(url, { ...base, sslMode: 'require' }).ssl).toEqual({ rejectUnauthorized: false });
    expect(connectionOptions(url, { ...base, sslMode: 'disable' }).ssl).toBe(false);
  });

  it('describes the target without the password', () => {
    expect(describeDatabase(['postgres://api:', 'hunter2', '@db.example:6543/app'].join(''))).toEqual({ host: 'db.example', port: '6543', database: 'app', user: 'api' });
  });
});

describe.skipIf(!caFile)('TLS against a real server', () => {
  const pools: Db[] = [];
  const url = () => {
    const u = new URL(inject('databaseUrl'));
    u.hostname = 'localhost'; // the name on the server certificate
    return u.toString();
  };
  const pool = (cfg: Partial<DatabaseConfig>) => {
    const p = createPool(url(), { ...base, ...cfg });
    pools.push(p);
    return p;
  };
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
  });

  it('verify-full with the CA: encrypted and verified', async () => {
    const info = await checkConnection(pool({ caCert: readFileSync(caFile!, 'utf8') }));
    expect(info.tls).toBe(true);
    expect(info.tlsVersion).toMatch(/^TLSv1\.[23]$/);
  });

  it('verify-full refuses a server certificate it cannot verify', async () => {
    await expect(checkConnection(pool({}))).rejects.toThrow(/self[- ]signed|unable to verify|certificate/i);
  });

  it('verify-full refuses a host name that is not on the certificate', async () => {
    const u = new URL(url());
    u.hostname = '127.0.0.2';
    const p = createPool(u.toString(), { ...base, caCert: readFileSync(caFile!, 'utf8') });
    pools.push(p);
    await expect(checkConnection(p)).rejects.toThrow();
  });

  it('require: encrypted without verification; disable: plain text', async () => {
    expect((await checkConnection(pool({ sslMode: 'require' }))).tls).toBe(true);
    expect((await checkConnection(pool({ sslMode: 'disable' }))).tls).toBe(false);
  });

  it('pooled connections and live updates (LISTEN) both run over TLS', async () => {
    const p = pool({ caCert: readFileSync(caFile!, 'utf8'), poolMax: 3 });
    const results = await Promise.all(Array.from({ length: 6 }, () => checkConnection(p)));
    expect(results.every((r) => r.tls)).toBe(true);
    expect(p.totalCount).toBeLessThanOrEqual(3);
    const events = new ScheduleEvents(url(), { ...base, caCert: readFileSync(caFile!, 'utf8') });
    await events.start();
    const listener = await p.query(
      `SELECT bool_and(s.ssl) AS tls, count(*)::int AS n FROM pg_stat_activity a JOIN pg_stat_ssl s ON s.pid = a.pid
       WHERE a.application_name = 'picksched-tls-test' AND a.query ILIKE 'LISTEN%'`);
    await events.stop();
    expect(listener.rows[0]).toEqual({ tls: true, n: 1 });
  });
});
