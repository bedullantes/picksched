import type { SendGridConfig } from './messaging/sendgrid.js';
import type { TwilioConfig } from './messaging/twilio.js';

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
