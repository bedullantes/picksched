/**
 * HTTP hardening: security headers (CSP, HSTS, framing, sniffing, referrer,
 * permissions), HTTPS redirect behind a proxy, request IDs and access logs.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { SecurityConfig } from './config.js';
import { log } from './logger.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlates the access log, error logs and the X-Request-Id response header. */
      id?: string;
    }
  }
}

/**
 * Content-Security-Policy for the app. Everything is served from our own
 * origin (the built web app, the API and live updates); PayMongo checkout is
 * a full-page redirect, which CSP doesn't restrict. No inline scripts,
 * no eval, and the app can't be framed.
 */
export function contentSecurityPolicy(opts: { upgradeInsecure: boolean; reportUri?: string }): string {
  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (opts.upgradeInsecure) directives.push('upgrade-insecure-requests');
  if (opts.reportUri) directives.push(`report-uri ${opts.reportUri}`);
  return directives.join('; ');
}

export function securityHeaders(cfg: SecurityConfig) {
  const csp = contentSecurityPolicy({ upgradeInsecure: cfg.hsts, reportUri: cfg.cspReportUri });
  const hsts = `max-age=${cfg.hstsMaxAgeSeconds}; includeSubDomains`;
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Origin-Agent-Cluster', '?1');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    // HSTS is only meaningful (and only honored) over HTTPS.
    if (cfg.hsts && req.secure) res.setHeader('Strict-Transport-Security', hsts);
    // API responses carry personal data: never cache them in browsers or proxies.
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

/**
 * Sends plain-HTTP requests to HTTPS. Needs TRUST_PROXY so req.secure reflects
 * X-Forwarded-Proto. The health check stays reachable over HTTP for load
 * balancers. The redirect target uses the configured public URL, never the
 * request's Host header.
 */
export function httpsRedirect(publicUrl: string | undefined) {
  const origin = publicUrl ? new URL(publicUrl).origin : undefined;
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.secure || req.path === '/api/health') return next();
    if (!origin) {
      res.status(403).json({ error: { code: 'HTTPS_REQUIRED', message: 'Please use HTTPS.' } });
      return;
    }
    res.redirect(308, `${origin}${req.originalUrl}`);
  };
}

const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Uses the proxy's X-Request-Id when it looks valid, otherwise makes one. */
export function requestId() {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.get('X-Request-Id');
    req.id = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}

/**
 * One line per request when it finishes: method, path (without the query
 * string), status, duration, size, client IP, user id and request id.
 */
export function accessLog() {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const status = res.headersSent ? res.statusCode : 499; // 499: client went away first
      const fields = {
        type: 'access',
        requestId: req.id,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status,
        durationMs: Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10,
        bytes: Number(res.getHeader('Content-Length') ?? 0) || undefined,
        ip: req.ip,
        userId: req.user?.id,
        userAgent: req.get('User-Agent'),
      };
      if (req.originalUrl === '/api/health') log.debug('request', fields);
      else if (status >= 500) log.warn('request', fields);
      else log.info('request', fields);
    };
    res.on('finish', finish);
    res.on('close', finish);
    next();
  };
}
