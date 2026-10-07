import pg from 'pg';

// timestamptz values are returned as JS Date by default; keep that.
export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(databaseUrl: string): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 20,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
  });
  // An idle connection dropped by the server (restart, failover, network loss)
  // is emitted here. Without a listener Node would crash the process; the pool
  // discards the broken client and opens a new one on the next request.
  pool.on('error', (err) => console.error('Idle database connection lost:', err.message));
  return pool;
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
