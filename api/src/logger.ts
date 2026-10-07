/**
 * Structured logging for production.
 *
 * json format: one JSON object per line on stdout (stderr for errors), with
 * `time`, `level`, `severity` (Google Cloud), `msg`, `service`, `env` and
 * any context fields: the shape log collectors and error trackers ingest
 * (CloudWatch, Datadog, Cloud Logging / Error Reporting, Loki, ...).
 * pretty format: short readable lines for development.
 *
 * Secrets never reach the logs: fields whose names look sensitive are
 * replaced with "[REDACTED]", and secret-looking values inside strings
 * (connection-string passwords, API keys, bearer tokens) are masked.
 *
 * Server errors can also be POSTed to ERROR_WEBHOOK_URL for alerting
 * (deduplicated per error for a minute).
 */
import { format as formatArgs } from 'node:util';
import type { LoggingConfig } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const SEVERITY: Record<Level, string> = { debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR', fatal: 'CRITICAL' };

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|signature/i;
const SECRET_PATTERNS: [RegExp, string][] = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^:\/\s@]+:)[^@\s]+@/gi, '$1***@'], // user:password@ in URLs
  [/\b(sk|pk)_(live|test)_[A-Za-z0-9]{6,}/g, '$1_$2_***'],     // PayMongo keys
  [/\bwhsk_[A-Za-z0-9]{6,}/g, 'whsk_***'],                        // PayMongo webhook secret
  [/\bSG\.[\w-]{10,}\.[\w-]{10,}/g, 'SG.***'],                    // SendGrid key
  [/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]{8,}/g, '$1 ***'],        // Authorization values
];

export function redactString(s: string): string {
  return SECRET_PATTERNS.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) && v !== undefined && v !== null && typeof v !== 'boolean' ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

export function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: redactString(String(err)) };
  const e = err as Error & { code?: unknown; status?: unknown; cause?: unknown };
  return {
    type: e.name,
    message: redactString(e.message),
    ...(e.code !== undefined ? { code: e.code } : {}),
    ...(e.stack ? { stack: redactString(e.stack) } : {}),
    ...(e.cause ? { cause: serializeError(e.cause) } : {}),
  };
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  fatal(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

interface State {
  level: Level;
  format: 'json' | 'pretty';
  base: Record<string, unknown>;
  errorWebhookUrl?: string;
}

const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };

const state: State = {
  level: 'info',
  format: process.env.NODE_ENV === 'production' || process.env.LOG_FORMAT === 'json' ? 'json' : 'pretty',
  base: { service: 'picksched-api' },
};

export function configureLogger(cfg: LoggingConfig, base: Record<string, unknown> = {}) {
  state.level = cfg.level;
  state.format = cfg.format;
  state.errorWebhookUrl = cfg.errorWebhookUrl;
  state.base = { service: 'picksched-api', ...base };
}

function write(level: Level, msg: string, fields: Record<string, unknown>) {
  if (RANK[level] < RANK[state.level]) return;
  const data = redact(fields) as Record<string, unknown>;
  const toErr = RANK[level] >= RANK.warn;
  if (state.format === 'json') {
    const line = JSON.stringify({
      time: new Date().toISOString(), level, severity: SEVERITY[level], msg: redactString(msg), ...state.base, ...data,
    });
    (toErr ? process.stderr : process.stdout).write(`${line}\n`);
  } else {
    const { err, ...rest } = data as { err?: { stack?: string; message?: string } };
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    const stack = err ? `\n${err.stack ?? err.message}` : '';
    (toErr ? original.error : original.log)(`${level.toUpperCase().padEnd(5)} ${redactString(msg)}${extra}${stack}`);
  }
  if (RANK[level] >= RANK.error) reportError(level, msg, data);
}

// --- Error tracking webhook ------------------------------------------------

const recentlyReported = new Map<string, number>();

function reportError(level: Level, msg: string, data: Record<string, unknown>) {
  const url = state.errorWebhookUrl;
  if (!url) return;
  const err = data.err as { type?: string; message?: string; stack?: string } | undefined;
  const fingerprint = `${msg}|${err?.type ?? ''}|${err?.stack?.split('\n')[1]?.trim() ?? err?.message ?? ''}`;
  const now = Date.now();
  if ((recentlyReported.get(fingerprint) ?? 0) > now - 60_000) return;
  recentlyReported.set(fingerprint, now);
  if (recentlyReported.size > 500) recentlyReported.clear();
  const body = JSON.stringify({
    time: new Date(now).toISOString(), level, msg: redactString(msg), ...state.base, ...data,
    // Slack/Teams-compatible summary line
    text: `[${String(state.base.env ?? '')}] ${state.base.service}: ${redactString(msg)}${err?.message ? ` - ${err.message}` : ''}`,
  });
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(3000) })
    .catch(() => undefined); // never let alerting break the app
}

function make(bound: Record<string, unknown>): Logger {
  const at = (level: Level) => (msg: string, fields: Record<string, unknown> = {}) => write(level, msg, { ...bound, ...fields });
  return {
    debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), fatal: at('fatal'),
    child: (fields) => make({ ...bound, ...fields }),
  };
}

export const log: Logger = make({});

/**
 * Routes console.* through the logger, so messages from every module (and
 * dependencies) come out in the same structured, redacted format.
 */
export function installConsoleBridge() {
  const bridge = (level: Level) => (...args: unknown[]) => {
    const err = args.find((a) => a instanceof Error) as Error | undefined;
    const rest = args.filter((a) => a !== err);
    const msg = rest.length ? formatArgs(...rest) : err?.message ?? '';
    write(level, msg, err ? { err } : {});
  };
  console.log = bridge('info');
  console.info = bridge('info');
  console.debug = bridge('debug');
  console.warn = bridge('warn');
  console.error = bridge('error');
}

export function uninstallConsoleBridge() {
  Object.assign(console, original);
}
