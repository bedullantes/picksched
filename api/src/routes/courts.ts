import { Router } from 'express';
import { z } from 'zod';
import { asUser, type Deps } from '../context.js';
import * as s from '../serialize.js';

export const COURT_COLUMNS = `
  c.id, c.name, c.description, c.location, c.hourly_rate, c.currency, c.is_active,
  c.timezone, c.opens_at::text, c.closes_at::text, c.slot_minutes,
  (c.owner_id = app_current_user_id()) AS is_owner`;

export function courtRoutes(deps: Deps) {
  const r = Router();

  // Players see active courts; owners also see their own inactive ones (RLS).
  r.get('/', async (req, res) => {
    const q = z.object({ mine: z.enum(['1', 'true', '0', 'false']).optional() }).parse(req.query);
    const mine = q.mine === '1' || q.mine === 'true';
    const rows = await asUser(deps, req, async (tx) =>
      (await tx.query(
        `SELECT ${COURT_COLUMNS} FROM courts c
         WHERE NOT $1 OR c.owner_id = app_current_user_id()
         ORDER BY c.name`, [mine])).rows);
    res.json({ courts: rows.map(s.court) });
  });

  return r;
}
