import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { clearSessionCookie, requireAuth, setSessionCookie, signSession, type Role } from '../auth.js';
import { asUser, type Deps } from '../context.js';
import { ApiError } from '../errors.js';
import { withUser } from '../db.js';
import { normalizePhone } from '../messaging/phone.js';

const credentials = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(200),
});

export function authRoutes(deps: Deps) {
  const r = Router();
  const { config } = deps;

  /** Optional phone for SMS confirmations: '' or null clears it. */
  const phoneField = z.string().max(40).nullable().optional().transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v.trim() === '') return null;
    const phone = normalizePhone(v, config.notifications.defaultCountryCode);
    if (!phone) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid mobile number, e.g. 0917 123 4567 or +63 917 123 4567.' });
      return z.NEVER;
    }
    return phone;
  });
  const parsePhone = (value: unknown) => {
    const r = phoneField.safeParse(value);
    if (!r.success) throw new ApiError(400, 'INVALID_PHONE', r.error.issues[0].message);
    return r.data;
  };
  const loadUser = (id: string) => withUser(deps.db, id, config.dbStatementTimeoutMs, async (tx) =>
    (await tx.query('SELECT id, email, role, phone FROM users WHERE id = app_current_user_id()')).rows[0]);
  // Compared against when the email is unknown, so login takes the same time
  // either way. Same cost as real hashes, or the timing would reveal accounts.
  const dummyHash = bcrypt.hashSync('not-a-real-password', config.bcryptRounds);

  const startSession = (res: any, user: { id: string; role: Role }) =>
    setSessionCookie(res, signSession(user, config.sessionSecret, config.sessionTtlSeconds),
      config.sessionTtlSeconds, config.secureCookies);

  r.post('/register', async (req, res) => {
    const body = credentials.extend({ role: z.enum(['player', 'admin']).default('player') }).parse(req.body);
    const phone = parsePhone(req.body?.phone);
    const hash = await bcrypt.hash(body.password, config.bcryptRounds);
    try {
      const id = await asUser(deps, req, async (tx) => {
        const newId = (await tx.query('SELECT register_user($1, $2, $3) AS id', [body.email, hash, body.role])).rows[0].id;
        if (phone) {
          await tx.query(`SELECT set_config('app.current_user_id', $1, true)`, [newId]);
          await tx.query('UPDATE users SET phone = $1 WHERE id = app_current_user_id()', [phone]);
        }
        return newId;
      });
      startSession(res, { id, role: body.role });
      res.status(201).json({ user: { id, email: body.email, role: body.role, phone: phone ?? null } });
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
    res.json({ user: await loadUser(user.id) });
  });

  r.post('/logout', (_req, res) => {
    clearSessionCookie(res, config.secureCookies);
    res.status(204).end();
  });

  r.get('/me', requireAuth, async (req, res) => {
    const user = await asUser(deps, req, async (tx) =>
      (await tx.query('SELECT id, email, role, phone FROM users WHERE id = app_current_user_id()')).rows[0]);
    if (!user) {
      clearSessionCookie(res, config.secureCookies);
      throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
    }
    res.json({ user });
  });

  /** PATCH /api/auth/me { phone } — set or clear the mobile number used for SMS confirmations. */
  r.patch('/me', requireAuth, async (req, res) => {
    const phone = parsePhone(req.body?.phone);
    if (phone === undefined) throw new ApiError(400, 'BAD_REQUEST', 'Nothing to update.');
    await asUser(deps, req, (tx) => tx.query('UPDATE users SET phone = $1 WHERE id = app_current_user_id()', [phone]));
    res.json({ user: await loadUser(req.user!.id) });
  });

  return r;
}
