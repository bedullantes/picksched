import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../auth.js';
import { asUser, type Deps } from '../context.js';
import type { Tx } from '../db.js';
import { ApiError } from '../errors.js';
import * as s from '../serialize.js';

const timeRange = z.object({
  startTime: z.iso.datetime({ offset: true }),
  endTime: z.iso.datetime({ offset: true }),
}).refine((v) => new Date(v.endTime) > new Date(v.startTime), {
  message: 'endTime must be after startTime',
  path: ['endTime'],
});

const createBody = z.object({ courtId: z.uuid() }).and(timeRange);
const rescheduleBody = z.object({ courtId: z.uuid().optional() }).and(timeRange);
const idParam = z.object({ id: z.uuid() });

const BOOKING_SELECT = `
  SELECT b.*, c.name AS court_name, c.timezone AS court_timezone,
         (b.player_id = app_current_user_id()) AS is_mine,
         (b.status = 'pending' AND b.hold_expires_at <= now()) AS hold_expired
  FROM bookings b
  LEFT JOIN courts c ON c.id = b.court_id
  WHERE b.id = $1`;

async function loadBooking(tx: Tx, id: string) {
  const row = (await tx.query(BOOKING_SELECT, [id])).rows[0];
  if (!row) throw new ApiError(404, 'BOOKING_NOT_FOUND', 'That booking was not found.');
  return row;
}

/**
 * Checks a requested booking against the live schedule before inserting.
 * The database constraints remain the final word (they also catch a race
 * that happens between this check and the insert); this step exists to
 * return a specific, friendly reason.
 */
async function validateRequestedSlot(
  tx: Tx, courtId: string, start: string, end: string, maxHours: number,
) {
  const info = (await tx.query(
    `SELECT c.is_active,
            ($2::timestamptz AT TIME ZONE c.timezone)::date::text AS local_date,
            $2::timestamptz < now() AS is_past,
            $2::timestamptz < now() + booking_min_lead_time() AS too_soon,
            extract(epoch FROM booking_min_lead_time()) / 60 AS lead_minutes
     FROM courts c WHERE c.id = $1`, [courtId, start])).rows[0];

  if (!info) throw new ApiError(404, 'COURT_NOT_FOUND', 'That court was not found.');
  if (!info.is_active) throw new ApiError(422, 'COURT_INACTIVE', 'This court is not accepting bookings.');
  if (info.is_past) throw new ApiError(422, 'SLOT_IN_PAST', 'That time has already passed. Please pick a later slot.');
  if (info.too_soon) {
    const lead = Number(info.lead_minutes);
    const label = lead % 60 === 0 ? `${lead / 60} hour${lead === 60 ? '' : 's'}` : `${lead} minutes`;
    throw new ApiError(422, 'TOO_SOON', `Bookings must be made at least ${label} in advance.`);
  }
  if (new Date(end).getTime() - new Date(start).getTime() > maxHours * 3_600_000) {
    throw new ApiError(422, 'TOO_LONG', `A single booking can be at most ${maxHours} hours.`);
  }

  const slots = (await tx.query(
    `SELECT slot_start, slot_end, status
     FROM get_availability($1::date, 1, $2)
     WHERE slot_start < $4::timestamptz AND slot_end > $3::timestamptz
     ORDER BY slot_start`, [info.local_date, courtId, start, end])).rows;

  const aligned = slots.length > 0
    && slots[0].slot_start.getTime() === new Date(start).getTime()
    && slots[slots.length - 1].slot_end.getTime() === new Date(end).getTime()
    && slots.every((sl, i) => i === 0 || sl.slot_start.getTime() === slots[i - 1].slot_end.getTime());
  if (!aligned) {
    throw new ApiError(422, 'INVALID_SLOT', "The requested time doesn't match this court's open time slots.");
  }
  if (slots.some((sl) => sl.status === 'maintenance')) {
    throw new ApiError(409, 'COURT_UNDER_MAINTENANCE', 'The court is closed for maintenance at that time.');
  }
  if (slots.some((sl) => sl.status !== 'available')) {
    throw new ApiError(409, 'SLOT_UNAVAILABLE',
      'This time slot is no longer available. Someone else may have just booked it.');
  }
}

export function bookingRoutes(deps: Deps) {
  const r = Router();
  r.use(requireAuth);

  // Start a booking: places a pending hold on the slot (see booking_hold_interval()).
  r.post('/', async (req, res) => {
    const body = createBody.parse(req.body);
    const row = await asUser(deps, req, async (tx) => {
      await validateRequestedSlot(tx, body.courtId, body.startTime, body.endTime, deps.config.maxBookingHours);
      const { id } = (await tx.query(
        `INSERT INTO bookings (court_id, player_id, start_time, end_time)
         VALUES ($1, app_current_user_id(), $2, $3) RETURNING id`,
        [body.courtId, body.startTime, body.endTime])).rows[0];
      return loadBooking(tx, id);
    });
    res.status(201).json({ booking: s.booking(row) });
  });

  r.get('/:id', async (req, res) => {
    const { id } = idParam.parse(req.params);
    const row = await asUser(deps, req, (tx) => loadBooking(tx, id));
    res.json({ booking: { ...s.booking(row), isMine: row.is_mine, holdExpired: row.hold_expired } });
  });

  // Final check before payment: is the player's hold still valid?
  r.post('/:id/checkout', async (req, res) => {
    const { id } = idParam.parse(req.params);
    const row = await asUser(deps, req, (tx) => loadBooking(tx, id));
    if (!row.is_mine) throw new ApiError(403, 'FORBIDDEN', 'Only the player who made this booking can pay for it.');
    if (row.status === 'cancelled') {
      throw new ApiError(409, 'BOOKING_CANCELLED', 'This booking was cancelled. Please choose another slot.');
    }
    if (row.hold_expired) {
      throw new ApiError(409, 'HOLD_EXPIRED',
        'Your hold on this slot expired and it was released. Please choose a slot again.');
    }
    res.json({
      state: row.status === 'confirmed' ? 'confirmed' : 'awaiting_payment',
      booking: s.booking(row),
      payment: { provider: 'paymongo', amount: Number(row.total_amount), currency: row.currency },
    });
  });

  r.post('/:id/cancel', async (req, res) => {
    const { id } = idParam.parse(req.params);
    const row = await asUser(deps, req, async (tx) => {
      await tx.query('SELECT cancel_booking($1)', [id]);
      return loadBooking(tx, id);
    });
    res.json({ booking: s.booking(row) });
  });

  r.post('/:id/confirm', requireRole('admin'), async (req, res) => {
    const { id } = idParam.parse(req.params);
    const row = await asUser(deps, req, async (tx) => {
      await tx.query('SELECT confirm_booking($1)', [id]);
      return loadBooking(tx, id);
    });
    res.json({ booking: s.booking(row) });
  });

  // Owner edits an existing booking's court and/or time.
  r.patch('/:id', requireRole('admin'), async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = rescheduleBody.parse(req.body);
    const row = await asUser(deps, req, async (tx) => {
      const current = await loadBooking(tx, id);
      await tx.query('SELECT reschedule_booking($1, $2, $3, $4)',
        [id, body.courtId ?? current.court_id, body.startTime, body.endTime]);
      return loadBooking(tx, id);
    });
    res.json({ booking: s.booking(row) });
  });

  return r;
}
