import type { AppEnv } from './env.js';
import type { SendGridConfig } from './messaging/sendgrid.js';
import type { TwilioConfig } from './messaging/twilio.js';

export interface Config {
  /** development | staging | production (see env.ts). */
  appEnv: AppEnv;
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
  database: DatabaseConfig;
  security: SecurityConfig;
  logging: LoggingConfig;
}

export type DbSslMode = 'disable' | 'require' | 'verify-full';

export interface DatabaseConfig {
  /**
   * TLS for database connections. 'verify-full' encrypts and checks the
   * server certificate and host name (against DATABASE_CA_CERT if given, else
   * the system CAs); 'require' encrypts without checking the certificate.
   */
  sslMode: DbSslMode;
  /** PEM CA certificate(s) for verify-full (DATABASE_CA_CERT, or a file via DATABASE_CA_CERT_FILE). */
  caCert?: string;
  poolMax: number;
  poolMin: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  /** Recycle connections after this many seconds (0 = never), e.g. after credential rotation or failover. */
  maxLifetimeSeconds: number;
  applicationName: string;
}

export interface SecurityConfig {
  /** Express "trust proxy" setting: how many proxies (load balancer, CDN) sit in front of the app. */
  trustProxy: boolean | number | string;
  /** Send Strict-Transport-Security (only on HTTPS requests). */
  hsts: boolean;
  hstsMaxAgeSeconds: number;
  /** Redirect plain-HTTP requests to HTTPS (behind a proxy that sets X-Forwarded-Proto). */
  httpsRedirect: boolean;
  /** Where browsers report Content-Security-Policy violations (optional). */
  cspReportUri?: string;
  /** Public origin of the app (APP_BASE_URL), used for HTTPS redirects. */
  publicUrl?: string;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  /** json: one JSON object per line (for log collectors); pretty: readable lines for development. */
  format: 'json' | 'pretty';
  /** One log line per HTTP request. */
  accessLog: boolean;
  /** Optional URL that receives a JSON POST for each server error (alerting / error tracking). */
  errorWebhookUrl?: string;
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
  /** Fallback delivery for channels without a provider: server log, or POST to webhookUrl. */
  transport: 'log' | 'webhook';
  webhookUrl?: string;
  intervalMs: number;
  email: { provider: 'sendgrid' | 'log' | 'webhook' | 'default'; sendgrid?: SendGridConfig };
  sms: { provider: 'twilio' | 'log' | 'webhook' | 'off' | 'default'; twilio?: TwilioConfig };
  /** Country calling code assumed for local phone numbers ("0917…"). */
  defaultCountryCode: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = (process.env[name] ?? fallback) as T;
  if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(', ')} (got "${value}")`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true or false (got "${value}")`);
}

export function loadConfig(appEnv: AppEnv = 'development'): Config {
  const deployed = appEnv !== 'development';
  const sessionSecret = required('SESSION_SECRET');
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  const config: Config = {
    appEnv,
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: required('DATABASE_URL'),
    sessionSecret,
    sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 12 * 60 * 60),
    secureCookies: bool('COOKIE_SECURE', deployed || process.env.NODE_ENV === 'production'),
    bcryptRounds: Number(process.env.BCRYPT_ROUNDS ?? 12),
    dbStatementTimeoutMs: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 5000),
    maxBookingHours: Number(process.env.MAX_BOOKING_HOURS ?? 4),
    holdSweepIntervalMs: Number(process.env.HOLD_SWEEP_INTERVAL_MS ?? 15_000),
    webDist: process.env.WEB_DIST,
    paymongo: loadPayMongoConfig(),
    notifications: loadNotificationsConfig(),
    paymentJobIntervalMs: Number(process.env.PAYMENT_JOB_INTERVAL_MS ?? 60_000),
    database: loadDatabaseConfig(appEnv),
    security: {
      trustProxy: parseTrustProxy(process.env.TRUST_PROXY ?? (deployed ? '1' : 'false')),
      hsts: bool('HSTS', deployed),
      hstsMaxAgeSeconds: Number(process.env.HSTS_MAX_AGE_SECONDS ?? 63_072_000), // 2 years
      httpsRedirect: bool('HTTPS_REDIRECT', deployed),
      cspReportUri: process.env.CSP_REPORT_URI || undefined,
      publicUrl: process.env.APP_BASE_URL || undefined,
    },
    logging: {
      level: oneOf('LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
      format: oneOf('LOG_FORMAT', ['json', 'pretty'] as const, deployed ? 'json' : 'pretty'),
      accessLog: bool('ACCESS_LOG', true),
      errorWebhookUrl: process.env.ERROR_WEBHOOK_URL || undefined,
    },
  };
  const problems = environmentProblems(config);
  if (problems.length) {
    throw new Error(`Invalid configuration for APP_ENV=${appEnv}:\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}

function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return /^\d+$/.test(value) ? Number(value) : value; // hop count, or a list of trusted addresses/subnets
}

/** TLS mode from DATABASE_SSL, else the connection string's sslmode, else per environment. */
export function loadDatabaseConfig(appEnv: AppEnv): DatabaseConfig {
  const fromUrl = sslModeFromUrl(process.env.DATABASE_URL ?? '');
  const sslMode = oneOf<DbSslMode>('DATABASE_SSL', ['disable', 'require', 'verify-full'],
    fromUrl ?? (appEnv === 'development' ? 'disable' : 'verify-full'));
  return {
    sslMode,
    caCert: process.env.DATABASE_CA_CERT || undefined,
    poolMax: Number(process.env.DB_POOL_MAX ?? 20),
    poolMin: Number(process.env.DB_POOL_MIN ?? 0),
    idleTimeoutMs: Number(process.env.DB_IDLE_TIMEOUT_MS ?? 30_000),
    connectionTimeoutMs: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 5000),
    maxLifetimeSeconds: Number(process.env.DB_MAX_LIFETIME_SECONDS ?? (appEnv === 'development' ? 0 : 1800)),
    applicationName: process.env.DB_APPLICATION_NAME ?? `picksched-api-${appEnv}`,
  };
}

function sslModeFromUrl(url: string): DbSslMode | undefined {
  let mode: string | null = null;
  try {
    mode = new URL(url).searchParams.get('sslmode');
  } catch {
    return undefined;
  }
  if (!mode) return undefined;
  if (mode === 'disable' || mode === 'allow' || mode === 'prefer') return 'disable';
  if (mode === 'require' || mode === 'verify-ca') return 'require';
  if (mode === 'verify-full') return 'verify-full';
  throw new Error(`Unsupported sslmode "${mode}" in DATABASE_URL`);
}

const isLocalUrl = (url: string) => /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url);
const PAYMONGO_API = 'https://api.paymongo.com/v1';

/**
 * Rules that keep each environment honest. Production must use live,
 * production-grade settings; staging must never charge real money; nothing
 * outside production may use live payment keys.
 */
export function environmentProblems(c: Config): string[] {
  const p: string[] = [];
  const pm = c.paymongo;
  const sg = c.notifications.email.sendgrid;
  const tw = c.notifications.sms.twilio;

  if (c.appEnv !== 'production' && pm?.live) {
    p.push(`live PayMongo keys (sk_live_) are only allowed with APP_ENV=production`);
  }
  if (c.appEnv === 'development') return p;

  // staging and production
  if (!c.secureCookies) p.push('COOKIE_SECURE must be true (session cookie over HTTPS only)');
  if (c.database.sslMode === 'disable') p.push('database connections must use TLS (DATABASE_SSL=verify-full)');
  if (new Set(c.sessionSecret).size < 16) p.push('SESSION_SECRET looks weak: use 32+ random bytes (e.g. openssl rand -base64 48)');
  if (c.bcryptRounds < 10) p.push('BCRYPT_ROUNDS must be at least 10');
  if (!pm) p.push('PAYMONGO_SECRET_KEY is required');
  if (pm && !pm.appBaseUrl.startsWith('https://')) p.push('APP_BASE_URL must be an https:// URL');
  if (pm && pm.apiBase !== PAYMONGO_API) p.push(`PAYMONGO_API_BASE must be ${PAYMONGO_API} (remove the simulator override)`);
  for (const [name, url] of [
    ['SENDGRID_API_BASE', sg?.apiBase], ['TWILIO_API_BASE', tw?.apiBase], ['NOTIFICATIONS_WEBHOOK_URL', c.notifications.webhookUrl],
  ] as const) {
    if (url && isLocalUrl(url)) p.push(`${name} points at a local simulator (${url})`);
  }

  if (c.appEnv === 'staging') {
    if (pm && !pm.secretKey.startsWith('sk_test_')) p.push('staging must use PayMongo test keys (sk_test_)');
    return p;
  }

  // production only
  if (pm && !pm.live) p.push('production must use PayMongo live keys (sk_live_), not test keys');
  if (c.database.sslMode === 'require' && !bool('DATABASE_SSL_ALLOW_UNVERIFIED', false)) {
    p.push('production database TLS must verify the server certificate: DATABASE_SSL=verify-full (with DATABASE_CA_CERT_FILE for a private CA), or DATABASE_SSL_ALLOW_UNVERIFIED=true if your provider offers no CA');
  }
  if (c.notifications.email.provider !== 'sendgrid') p.push('production must send email through SendGrid (set SENDGRID_API_KEY)');
  if (sg?.sandbox) p.push('SENDGRID_SANDBOX_MODE must be off in production (it delivers nothing)');
  if (!['twilio', 'off'].includes(c.notifications.sms.provider)) {
    p.push('set Twilio credentials for SMS, or SMS_PROVIDER=off to send email only');
  }
  if (tw?.fromNumber && /^\+1500555\d{4}$/.test(tw.fromNumber)) p.push('TWILIO_FROM_NUMBER is a Twilio test number');
  if (!c.security.hsts) p.push('HSTS must be enabled in production');
  return p;
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
  const emailProvider = process.env.EMAIL_PROVIDER ?? (process.env.SENDGRID_API_KEY ? 'sendgrid' : 'default');
  const smsProvider = process.env.SMS_PROVIDER ?? (process.env.TWILIO_ACCOUNT_SID ? 'twilio' : 'default');
  if (!['sendgrid', 'log', 'webhook', 'default'].includes(emailProvider)) {
    throw new Error('EMAIL_PROVIDER must be one of sendgrid, log, webhook');
  }
  if (!['twilio', 'log', 'webhook', 'off', 'default'].includes(smsProvider)) {
    throw new Error('SMS_PROVIDER must be one of twilio, log, webhook, off');
  }
  const needsWebhook = transport === 'webhook' || emailProvider === 'webhook' || smsProvider === 'webhook';
  const timeoutMs = Number(process.env.NOTIFICATIONS_TIMEOUT_MS ?? 10_000);

  let sendgrid: SendGridConfig | undefined;
  if (emailProvider === 'sendgrid') {
    sendgrid = {
      apiKey: required('SENDGRID_API_KEY'),
      fromEmail: required('SENDGRID_FROM_EMAIL'),
      fromName: process.env.SENDGRID_FROM_NAME ?? 'PickSched',
      apiBase: (process.env.SENDGRID_API_BASE ?? 'https://api.sendgrid.com').replace(/\/$/, ''),
      timeoutMs,
      sandbox: process.env.SENDGRID_SANDBOX_MODE === 'true',
    };
  }
  let twilio: TwilioConfig | undefined;
  if (smsProvider === 'twilio') {
    const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    const fromNumber = process.env.TWILIO_FROM_NUMBER;
    if (!messagingServiceSid && !fromNumber) {
      throw new Error('Set TWILIO_MESSAGING_SERVICE_SID (recommended) or TWILIO_FROM_NUMBER');
    }
    twilio = {
      accountSid: required('TWILIO_ACCOUNT_SID'),
      authToken: required('TWILIO_AUTH_TOKEN'),
      messagingServiceSid,
      fromNumber,
      apiBase: (process.env.TWILIO_API_BASE ?? 'https://api.twilio.com').replace(/\/$/, ''),
      timeoutMs,
      statusCallbackUrl: process.env.TWILIO_STATUS_CALLBACK_URL,
    };
  }
  return {
    transport,
    webhookUrl: needsWebhook ? required('NOTIFICATIONS_WEBHOOK_URL') : undefined,
    intervalMs: Number(process.env.NOTIFICATIONS_INTERVAL_MS ?? 5000),
    email: { provider: emailProvider as NotificationsConfig['email']['provider'], sendgrid },
    sms: { provider: smsProvider as NotificationsConfig['sms']['provider'], twilio },
    defaultCountryCode: process.env.PHONE_DEFAULT_COUNTRY_CODE ?? '63',
  };
}
