import { Router } from 'express';
import { z } from 'zod';
import { asUser, type Deps } from '../context.js';
import { ApiError } from '../errors.js';
import * as s from '../serialize.js';
import { COURT_COLUMNS } from './courts.js';

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
}, 'Invalid date');

const query = z.object({
  start: isoDate,
  days: z.coerce.number().int().min(1).max(14).default(1),
  courtId: z.uuid().optional(),
  mine: z.enum(['1', 'true', '0', 'false']).optional(),
});

/**
 * GET /api/availability?start=YYYY-MM-DD&days=1|7[&courtId=][&mine=1]
 *
 * Slot-by-slot availability computed by the database (get_availability),
 * so the calendar always reflects the Bookings and maintenance tables.
 */
export function availabilityRoutes(deps: Deps) {
  const r = Router();

  r.get('/', async (req, res) => {
    const q = query.parse(req.query);
    const mine = q.mine === '1' || q.mine === 'true';
    if (mine && req.user?.role !== 'admin') {
      throw new ApiError(403, 'FORBIDDEN', 'Only court owners can view their facility schedule.');
    }

    const result = await asUser(deps, req, async (tx) => {
      const meta = (await tx.query(
        `SELECT now() AS now,
                extract(epoch FROM booking_min_lead_time()) / 60 AS lead_minutes,
                extract(epoch FROM booking_hold_interval()) / 60 AS hold_minutes`)).rows[0];
      const courts = (await tx.query(
        `SELECT ${COURT_COLUMNS} FROM courts c
         WHERE ($1::uuid IS NULL OR c.id = $1)
           AND (NOT $2 OR c.owner_id = app_current_user_id())
         ORDER BY c.name`, [q.courtId ?? null, mine])).rows;
      const slots = (await tx.query(
        `SELECT a.*, a.local_date::text AS local_date_text
         FROM get_availability($1::date, $2, $3, $4) a`,
        [q.start, q.days, q.courtId ?? null, mine])).rows;
      return { meta, courts, slots };
    });

    if (q.courtId && result.courts.length === 0) {
      throw new ApiError(404, 'COURT_NOT_FOUND', 'That court was not found.');
    }

    res.set('Cache-Control', 'no-store');
    res.json({
      serverTime: result.meta.now.toISOString(),
      rules: {
        minLeadMinutes: Number(result.meta.lead_minutes),
        holdMinutes: Number(result.meta.hold_minutes),
      },
      start: q.start,
      days: q.days,
      courts: result.courts.map(s.court),
      slots: result.slots.map(s.slot),
    });
  });

  return r;
}
