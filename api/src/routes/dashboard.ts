import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import { asUser, type Deps } from '../context.js';
import type { Tx } from '../db.js';
import { ApiError } from '../errors.js';
import { isoDate } from './availability.js';

const query = z.object({ start: isoDate.optional(), end: isoDate.optional() });

const MAX_RANGE_DAYS = 367;
const DEFAULT_RANGE_DAYS = 30;

type MetricRow = {
  day: string;
  active_courts: number;
  available_minutes: string;
  booked_minutes: string;
  bookings: number;
  payments: number;
  gross: string;
  provider_fees: string;
  platform_fees: string;
  owner_net: string;
};

const hours = (minutes: number) => Math.round((minutes / 60) * 10) / 10;
/** Occupancy as a fraction (0–1), or null when nothing was bookable. */
const rate = (booked: number, available: number) => (available > 0 ? booked / available : null);

function summarize(rows: MetricRow[]) {
  const sum = (k: keyof MetricRow) => rows.reduce((acc, r) => acc + Number(r[k]), 0);
  const booked = sum('booked_minutes');
  const available = sum('available_minutes');
  return {
    bookings: sum('bookings'),
    occupancy: { bookedHours: hours(booked), availableHours: hours(available), rate: rate(booked, available) },
    revenue: {
      payments: sum('payments'),
      gross: sum('gross'),
      providerFees: sum('provider_fees'),
      platformFees: sum('platform_fees'),
      net: sum('owner_net'),
    },
  };
}

async function metrics(tx: Tx, start: string, end: string): Promise<MetricRow[]> {
  return (await tx.query(
    `SELECT day::text, active_courts, available_minutes, booked_minutes, bookings, payments,
            gross, provider_fees, platform_fees, owner_net
     FROM owner_daily_metrics($1::date, $2::date)`, [start, end])).rows;
}

/**
 * GET /api/dashboard?start=YYYY-MM-DD&end=YYYY-MM-DD   (court owners only)
 *
 * Booking counts, occupancy and revenue for the signed-in owner's courts.
 * `overview` is always today and the next 7 days; `range` and `daily` cover
 * start..end (default: the last 30 days). Dates are in the facility's time zone.
 */
export function dashboardRoutes(deps: Deps) {
  const r = Router();
  r.use(requireRole('admin'));

  r.get('/', async (req, res) => {
    const q = query.parse(req.query);
    if (q.start && q.end && q.end < q.start) {
      throw new ApiError(400, 'INVALID_RANGE', "The end date can't be earlier than the start date.");
    }

    const result = await asUser(deps, req, async (tx) => {
      const info = (await tx.query(
        `SELECT tz, (now() AT TIME ZONE tz)::date::text AS today,
                ((now() AT TIME ZONE tz)::date + 6)::text AS week_end,
                ((now() AT TIME ZONE tz)::date - $1::int)::text AS default_start,
                (SELECT count(*) FROM courts WHERE owner_id = app_current_user_id())::int AS registered,
                (SELECT count(*) FROM courts WHERE owner_id = app_current_user_id() AND is_active)::int AS active,
                (SELECT mode() WITHIN GROUP (ORDER BY currency) FROM courts WHERE owner_id = app_current_user_id()) AS currency
         FROM (SELECT owner_timezone() AS tz) z`, [DEFAULT_RANGE_DAYS - 1])).rows[0];
      const start = q.start ?? (q.end ? q.end : info.default_start);
      const end = q.end ?? (q.start && q.start > info.today ? q.start : info.today);
      if (end < start) {
        throw new ApiError(400, 'INVALID_RANGE', "The end date can't be earlier than the start date.");
      }
      const days = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
      if (days > MAX_RANGE_DAYS) {
        throw new ApiError(400, 'RANGE_TOO_LONG', 'Please choose a range of one year or less.');
      }
      const week = await metrics(tx, info.today, info.week_end);
      const range = await metrics(tx, start, end);
      return { info, start, end, week, range };
    });

    const { info, week, range } = result;
    const today = week.filter((d) => d.day === info.today);
    res.set('Cache-Control', 'no-store');
    res.json({
      timezone: info.tz,
      currency: info.currency ?? 'PHP',
      today: info.today,
      courts: { registered: info.registered, active: info.active },
      overview: {
        today: summarize(today),
        nextSevenDays: { start: info.today, end: info.week_end, ...summarize(week) },
      },
      range: { start: result.start, end: result.end, ...summarize(range) },
      daily: range.map((d) => ({
        date: d.day,
        activeCourts: d.active_courts,
        bookings: d.bookings,
        bookedHours: hours(Number(d.booked_minutes)),
        availableHours: hours(Number(d.available_minutes)),
        occupancyRate: rate(Number(d.booked_minutes), Number(d.available_minutes)),
        payments: d.payments,
        revenue: Number(d.gross),
        netRevenue: Number(d.owner_net),
      })),
    });
  });

  return r;
}
