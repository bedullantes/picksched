import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './errors.js';

export type Role = 'admin' | 'player';

export interface SessionUser {
  id: string;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
  }
}

export const SESSION_COOKIE = 'picksched_session';

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

/** Token format: base64url(JSON payload) "." base64url(HMAC-SHA256 signature). */
export function signSession(user: SessionUser, secret: string, ttlSeconds: number): string {
  const payload = b64(JSON.stringify({ sub: user.id, role: user.role, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const sig = b64(createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifySession(token: string, secret: string): SessionUser | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp < Date.now() / 1000) return null;
    if (data.role !== 'admin' && data.role !== 'player') return null;
    return { id: String(data.sub), role: data.role };
  } catch {
    return null;
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function sessionMiddleware(secret: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) req.user = verifySession(token, secret) ?? undefined;
    next();
  };
}

export function setSessionCookie(res: Response, token: string, ttlSeconds: number, secure: boolean) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: ttlSeconds * 1000,
  });
}

export function clearSessionCookie(res: Response, secure: boolean) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure, path: '/' });
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.'));
  next();
}

export function requireRole(role: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.'));
    if (req.user.role !== role) {
      return next(new ApiError(403, 'FORBIDDEN', 'Only court owners can do that.'));
    }
    next();
  };
}
