import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../auth.js';
import { asUser, type Deps } from '../context.js';
import type { Tx } from '../db.js';
import { ApiError } from '../errors.js';
import * as s from '../serialize.js';
import { isoDate } from './availability.js';

const timeRange = z.object({
  startTime: z.iso.datetime({ offset: true }),
  endTime: z.iso.datetime({ offset: true }),
}).refine((v) => new Date(v.endTime) > new Date(v.startTime), {
  message: 'endTime must be after startTime',
  path: ['endTime'],
});

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM (24-hour)');

/**
 * A reservation request names the court and the time, either as exact
 * timestamps or as a date and start time in the court's own time zone:
 *   { courtId, startTime: ISO, endTime: ISO }
 *   { courtId, date: 'YYYY-MM-DD', time: 'HH:MM', durationMinutes? }  (default: one slot)
 */
const createBody = z.union([
  z.object({ courtId: z.uuid() }).and(timeRange),
  z.object({
    courtId: z.uuid(),
    date: isoDate,
    time: localTime,
    durationMinutes: z.number().int().min(30).max(24 * 60).optional(),
  }),
]);
type CreateBody = z.infer<typeof createBody>;
const idempotencyKey = z.uuid({ message: 'Idempotency-Key must be a UUID' });
const rescheduleBody = z.object({ courtId: z.uuid().optional() }).and(timeRange);
const idParam = z.object({ id: z.uuid() });

const BOOKING_SELECT = `
  SELECT b.*, c.name AS court_name, c.timezone AS court_timezone,
         (b.player_id = app_current_user_id()) AS is_mine,
         (b.status = 'pending_payment' AND b.expires_at <= now()) AS hold_expired
  FROM bookings b
  LEFT JOIN courts c ON c.id = b.court_id
  WHERE b.id = $1`;

async function loadBooking(tx: Tx, id: string) {
  const row = (await tx.query(BOOKING_SELECT, [id])).rows[0];
  if (!row) throw new ApiError(404, 'BOOKING_NOT_FOUND', 'That booking was not found.');
  return row;
}

interface ResolvedRequest {
  courtId: string;
  start: string; // ISO
  end: string;
}

async function resolveRequest(tx: Tx, body: CreateBody): Promise<ResolvedRequest> {
  if ('startTime' in body) {
    return {
      courtId: body.courtId,
      start: new Date(body.startTime).toISOString(),
      end: new Date(body.endTime).toISOString(),
    };
  }
  const row = (await tx.query(
    `SELECT ($2::date + $3::time) AT TIME ZONE c.timezone AS start_time, c.slot_minutes
     FROM courts c WHERE c.id = $1`, [body.courtId, body.date, body.time])).rows[0];
  if (!row) throw new ApiError(404, 'COURT_NOT_FOUND', 'That court was not found.');
  const minutes = body.durationMinutes ?? row.slot_minutes;
  return {
    courtId: body.courtId,
    start: row.start_time.toISOString(),
    end: new Date(row.start_time.getTime() + minutes * 60_000).toISOString(),
  };
}

/** Response for a reservation: the booking plus what the payment step needs. */
function reservationResponse(row: Record<string, any>, replayed: boolean) {
  return {
    booking: s.booking(row),
    payment: {
      provider: 'paymongo',
      amount: Number(row.total_amount),
      currency: row.currency,
      expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    },
    next: 'payment',
    replayed,
  };
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
  if (info.is_past) throw new ApiError(400, 'SLOT_IN_PAST', 'That time has already passed. Please pick a later slot.');
  if (info.too_soon) {
    const lead = Number(info.lead_minutes);
    const label = lead % 60 === 0 ? `${lead / 60} hour${lead === 60 ? '' : 's'}` : `${lead} minutes`;
    throw new ApiError(400, 'TOO_SOON', `Bookings must be made at least ${label} in advance.`);
  }
  if (new Date(end).getTime() - new Date(start).getTime() > maxHours * 3_600_000) {
    throw new ApiError(400, 'TOO_LONG', `A single booking can be at most ${maxHours} hours.`);
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
    throw new ApiError(400, 'INVALID_SLOT', "The requested time doesn't match this court's open time slots.");
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

  /**
   * Reserve a slot: creates a 'pending_payment' booking that holds the slot
   * until expires_at (booking_hold_interval(), 3 minutes), then the player pays.
   *
   * The check and the insert run in one database transaction; the database's
   * exclusion constraint and per-court lock make it atomic, so of several
   * simultaneous requests for a slot exactly one succeeds and the rest get
   * 409 SLOT_UNAVAILABLE.
   *
   * Idempotency-Key (optional, UUID): retrying with the same key, e.g. after
   * a network timeout, returns the reservation the first attempt created
   * (200, replayed: true) instead of a conflict. The key becomes the booking id.
   */
  r.post('/', async (req, res) => {
    const body = createBody.parse(req.body);
    const rawKey = req.get('Idempotency-Key');
    const key = rawKey === undefined ? undefined : idempotencyKey.parse(rawKey);
    const me = req.user!.id;

    const resolved = await asUser(deps, req, (tx) => resolveRequest(tx, body));

    const replay = async () => {
      if (!key) return false;
      const existing = await asUser(deps, req, async (tx) => (await tx.query(BOOKING_SELECT, [key])).rows[0]);
      if (!existing) return false;
      const same = existing.player_id === me
        && existing.court_id === resolved.courtId
        && existing.start_time.toISOString() === resolved.start
        && existing.end_time.toISOString() === resolved.end;
      if (!same) {
        throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'This request ID was already used for a different reservation.');
      }
      res.status(200).json(reservationResponse(existing, true));
      return true;
    };

    if (await replay()) return;

    let row;
    try {
      row = await asUser(deps, req, async (tx) => {
        await validateRequestedSlot(tx, resolved.courtId, resolved.start, resolved.end, deps.config.maxBookingHours);
        const { id } = (await tx.query(
          `INSERT INTO bookings (id, court_id, player_id, start_time, end_time)
           VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, app_current_user_id(), $3, $4) RETURNING id`,
          [key ?? null, resolved.courtId, resolved.start, resolved.end])).rows[0];
        return loadBooking(tx, id);
      });
    } catch (err) {
      // A concurrent request with the same key (a retry that overlapped the
      // original) may have created the reservation first; then this request
      // fails on the duplicate id or on the slot it now holds. Return that
      // reservation instead of the conflict.
      if (key && await replay()) return;
      throw err;
    }
    res.status(201).json(reservationResponse(row, false));
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
