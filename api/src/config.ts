export interface Config {
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  secureCookies: boolean;
  bcryptRounds: number;
  dbStatementTimeoutMs: number;
  maxBookingHours: number;
  webDist?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadConfig(): Config {
  const sessionSecret = required('SESSION_SECRET');
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: required('DATABASE_URL'),
    sessionSecret,
    sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 12 * 60 * 60),
    secureCookies: (process.env.COOKIE_SECURE ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true',
    bcryptRounds: Number(process.env.BCRYPT_ROUNDS ?? 12),
    dbStatementTimeoutMs: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 5000),
    maxBookingHours: Number(process.env.MAX_BOOKING_HOURS ?? 4),
    webDist: process.env.WEB_DIST,
  };
}
