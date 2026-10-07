import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { clearSessionCookie, requireAuth, setSessionCookie, signSession, type Role } from '../auth.js';
import { asUser, type Deps } from '../context.js';
import { ApiError } from '../errors.js';

const credentials = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(200),
});

export function authRoutes(deps: Deps) {
  const r = Router();
  const { config } = deps;
  // Compared against when the email is unknown, so login takes the same time
  // either way. Same cost as real hashes, or the timing would reveal accounts.
  const dummyHash = bcrypt.hashSync('not-a-real-password', config.bcryptRounds);

  const startSession = (res: any, user: { id: string; role: Role }) =>
    setSessionCookie(res, signSession(user, config.sessionSecret, config.sessionTtlSeconds),
      config.sessionTtlSeconds, config.secureCookies);

  r.post('/register', async (req, res) => {
    const body = credentials.extend({ role: z.enum(['player', 'admin']).default('player') }).parse(req.body);
    const hash = await bcrypt.hash(body.password, config.bcryptRounds);
    try {
      const id = await asUser(deps, req, async (tx) =>
        (await tx.query('SELECT register_user($1, $2, $3) AS id', [body.email, hash, body.role])).rows[0].id);
      startSession(res, { id, role: body.role });
      res.status(201).json({ user: { id, email: body.email, role: body.role } });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ApiError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
      }
      throw err;
    }
  });

  r.post('/login', async (req, res) => {
    const body = credentials.parse(req.body);
    const user = await asUser(deps, req, async (tx) =>
      (await tx.query('SELECT id, password_hash, role FROM find_user_for_login($1)', [body.email])).rows[0]);
    const ok = await bcrypt.compare(body.password, user?.password_hash ?? dummyHash);
    if (!user || !ok) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
    startSession(res, { id: user.id, role: user.role });
    res.json({ user: { id: user.id, email: body.email.toLowerCase(), role: user.role } });
  });

  r.post('/logout', (_req, res) => {
    clearSessionCookie(res, config.secureCookies);
    res.status(204).end();
  });

  r.get('/me', requireAuth, async (req, res) => {
    const user = await asUser(deps, req, async (tx) =>
      (await tx.query('SELECT id, email, role FROM users WHERE id = app_current_user_id()')).rows[0]);
    if (!user) {
      clearSessionCookie(res, config.secureCookies);
      throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
    }
    res.json({ user });
  });

  return r;
}
