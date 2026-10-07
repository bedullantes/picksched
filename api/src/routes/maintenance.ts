import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import { asUser, type Deps } from '../context.js';
import { ApiError } from '../errors.js';
import * as s from '../serialize.js';

const createBody = z.object({
  courtId: z.uuid(),
  startTime: z.iso.datetime({ offset: true }),
  endTime: z.iso.datetime({ offset: true }),
  reason: z.string().trim().max(200).optional(),
}).refine((v) => new Date(v.endTime) > new Date(v.startTime), {
  message: 'endTime must be after startTime',
  path: ['endTime'],
});

const listQuery = z.object({
  courtId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

/** Maintenance blocks: court owners take their courts out of service. */
export function maintenanceRoutes(deps: Deps) {
  const r = Router();
  r.use(requireRole('admin'));

  r.get('/', async (req, res) => {
    const q = listQuery.parse(req.query);
    const rows = await asUser(deps, req, async (tx) =>
      (await tx.query(
        `SELECT * FROM court_blocks
         WHERE ($1::uuid IS NULL OR court_id = $1)
           AND ($2::timestamptz IS NULL OR end_time > $2)
           AND ($3::timestamptz IS NULL OR start_time < $3)
         ORDER BY start_time`, [q.courtId ?? null, q.from ?? null, q.to ?? null])).rows);
    res.json({ blocks: rows.map(s.block) });
  });

  r.post('/', async (req, res) => {
    const body = createBody.parse(req.body);
    const row = await asUser(deps, req, async (tx) => {
      const ownsCourt = (await tx.query('SELECT app_owns_court($1) AS ok', [body.courtId])).rows[0].ok;
      if (!ownsCourt) throw new ApiError(403, 'FORBIDDEN', 'You can only block time on your own courts.');
      const past = (await tx.query('SELECT $1::timestamptz < now() AS past', [body.endTime])).rows[0].past;
      if (past) throw new ApiError(422, 'SLOT_IN_PAST', 'That time has already passed.');
      return (await tx.query(
        `INSERT INTO court_blocks (court_id, start_time, end_time, reason)
         VALUES ($1, $2, $3, NULLIF($4, '')) RETURNING *`,
        [body.courtId, body.startTime, body.endTime, body.reason ?? null])).rows[0];
    });
    res.status(201).json({ block: s.block(row) });
  });

  r.delete('/:id', async (req, res) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const deleted = await asUser(deps, req, async (tx) =>
      (await tx.query('DELETE FROM court_blocks WHERE id = $1 RETURNING id', [id])).rowCount);
    if (!deleted) throw new ApiError(404, 'BLOCK_NOT_FOUND', 'That maintenance block was not found.');
    res.status(204).end();
  });

  return r;
}
