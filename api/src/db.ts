import pg from 'pg';
import type { DatabaseConfig } from './config.js';

// timestamptz values are returned as JS Date by default; keep that.
export type Db = pg.Pool;
export type Tx = pg.PoolClient;

const SSL_URL_PARAMS = ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];

/**
 * Connection settings for the pool and for the LISTEN connection. TLS comes
 * from DatabaseConfig (DATABASE_SSL / DATABASE_CA_CERT), so any ssl options in
 * the URL are removed rather than silently overriding it.
 */
export function connectionOptions(databaseUrl: string, cfg?: DatabaseConfig): pg.ClientConfig {
  if (!cfg) return { connectionString: databaseUrl };
  const url = new URL(databaseUrl);
  for (const p of SSL_URL_PARAMS) url.searchParams.delete(p);
  const ssl = cfg.sslMode === 'disable' ? false
    : cfg.sslMode === 'require' ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true, ...(cfg.caCert ? { ca: cfg.caCert } : {}) };
  return { connectionString: url.toString(), ssl, application_name: cfg.applicationName };
}

/** A sanitized description of the connection target for logs: never includes the password. */
export function describeDatabase(databaseUrl: string) {
  try {
    const u = new URL(databaseUrl);
    return { host: u.hostname || 'local socket', port: u.port || '5432', database: u.pathname.slice(1), user: decodeURIComponent(u.username) };
  } catch {
    return { host: 'unparseable DATABASE_URL' };
  }
}

export function createPool(databaseUrl: string, cfg?: DatabaseConfig): Db {
  const pool = new pg.Pool({
    ...connectionOptions(databaseUrl, cfg),
    max: cfg?.poolMax ?? 20,
    min: cfg?.poolMin ?? 0,
    connectionTimeoutMillis: cfg?.connectionTimeoutMs ?? 5000,
    idleTimeoutMillis: cfg?.idleTimeoutMs ?? 30_000,
    maxLifetimeSeconds: cfg?.maxLifetimeSeconds ?? 0,
  });
  // An idle connection dropped by the server (restart, failover, network loss)
  // is emitted here. Without a listener Node would crash the process; the pool
  // discards the broken client and opens a new one on the next request.
  pool.on('error', (err) => console.error('Idle database connection lost:', err.message));
  return pool;
}

/** Checks the database is reachable and reports whether this connection is TLS-encrypted. */
export async function checkConnection(db: Db): Promise<{ tls: boolean; tlsVersion: string | null; serverVersion: string }> {
  const { rows } = await db.query(
    `SELECT COALESCE(s.ssl, false) AS tls, s.version AS tls_version, current_setting('server_version') AS server_version
     FROM (SELECT 1) one LEFT JOIN pg_stat_ssl s ON s.pid = pg_backend_pid()`);
  return { tls: rows[0].tls, tlsVersion: rows[0].tls_version, serverVersion: rows[0].server_version };
}

/**
 * Runs `fn` in a transaction as the application role, with the given user as
 * the identity that the database's row-level security policies check.
 *
 * SET LOCAL ROLE picksched_app applies RLS even if the pool connects as the
 * table owner, so a misconfigured connection can't bypass access control.
 */
export async function withUser<T>(
  db: Db,
  userId: string | null,
  statementTimeoutMs: number,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('SET LOCAL ROLE picksched_app');
    await tx.query(
      `SELECT set_config('app.current_user_id', $1, true),
              set_config('statement_timeout', $2, true)`,
      [userId ?? '', String(statementTimeoutMs)],
    );
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    tx.release();
  }
}
