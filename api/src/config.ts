export interface Config {
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  secureCookies: boolean;
  bcryptRounds: number;
  dbStatementTimeoutMs: number;
  maxBookingHours: number;
  holdSweepIntervalMs: number;
  webDist?: string;
  /** Payments are enabled only when PayMongo is configured. */
  paymongo?: PayMongoConfig;
  notifications: NotificationsConfig;
  /** How often expired checkout sessions are closed and due refunds retried. */
  paymentJobIntervalMs: number;
}

export interface PayMongoConfig {
  secretKey: string;
  webhookSecret: string;
  apiBase: string;
  timeoutMs: number;
  /** Public URL of the web app; PayMongo sends players back here after checkout. */
  appBaseUrl: string;
  /** PayMongo payment method types offered at checkout. */
  methods: string[];
  /** True for live keys (sk_live_...), which also selects the live webhook signature. */
  live: boolean;
}

export interface NotificationsConfig {
  transport: 'log' | 'webhook';
  webhookUrl?: string;
  intervalMs: number;
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
    holdSweepIntervalMs: Number(process.env.HOLD_SWEEP_INTERVAL_MS ?? 15_000),
    webDist: process.env.WEB_DIST,
    paymongo: loadPayMongoConfig(),
    notifications: loadNotificationsConfig(),
    paymentJobIntervalMs: Number(process.env.PAYMENT_JOB_INTERVAL_MS ?? 60_000),
  };
}

function loadPayMongoConfig(): PayMongoConfig | undefined {
  const secretKey = process.env.PAYMONGO_SECRET_KEY;
  if (!secretKey) return undefined;
  const methods = (process.env.PAYMONGO_PAYMENT_METHODS ?? 'gcash,paymaya').split(',').map((m) => m.trim()).filter(Boolean);
  const unsupported = methods.filter((m) => m !== 'gcash' && m !== 'paymaya');
  if (unsupported.length) throw new Error(`Unsupported PAYMONGO_PAYMENT_METHODS: ${unsupported.join(', ')} (use gcash, paymaya)`);
  return {
    secretKey,
    webhookSecret: required('PAYMONGO_WEBHOOK_SECRET'),
    apiBase: (process.env.PAYMONGO_API_BASE ?? 'https://api.paymongo.com/v1').replace(/\/$/, ''),
    timeoutMs: Number(process.env.PAYMONGO_TIMEOUT_MS ?? 10_000),
    appBaseUrl: required('APP_BASE_URL').replace(/\/$/, ''),
    methods,
    live: secretKey.startsWith('sk_live_'),
  };
}

function loadNotificationsConfig(): NotificationsConfig {
  const transport = process.env.NOTIFICATIONS_TRANSPORT ?? 'log';
  if (transport !== 'log' && transport !== 'webhook') {
    throw new Error('NOTIFICATIONS_TRANSPORT must be "log" or "webhook"');
  }
  return {
    transport,
    webhookUrl: transport === 'webhook' ? required('NOTIFICATIONS_WEBHOOK_URL') : undefined,
    intervalMs: Number(process.env.NOTIFICATIONS_INTERVAL_MS ?? 5000),
  };
}
