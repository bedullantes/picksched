/* Converts database rows to API JSON (camelCase, ISO timestamps). */

type Row = Record<string, any>;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const hhmm = (v: string) => v.slice(0, 5);

export function court(r: Row) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    location: r.location,
    hourlyRate: Number(r.hourly_rate),
    currency: r.currency,
    isActive: r.is_active,
    timezone: r.timezone,
    opensAt: hhmm(r.opens_at),
    closesAt: hhmm(r.closes_at),
    slotMinutes: r.slot_minutes,
    isOwner: r.is_owner,
  };
}

export function booking(r: Row) {
  return {
    id: r.id,
    courtId: r.court_id,
    courtName: r.court_name ?? undefined,
    courtTimezone: r.court_timezone ?? undefined,
    playerId: r.player_id,
    startTime: iso(r.start_time),
    endTime: iso(r.end_time),
    status: r.status,
    totalAmount: Number(r.total_amount),
    currency: r.currency,
    expiresAt: iso(r.expires_at),
    /** @deprecated same as expiresAt; kept for existing clients */
    holdExpiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at),
  };
}

export function block(r: Row) {
  return {
    id: r.id,
    courtId: r.court_id,
    startTime: iso(r.start_time),
    endTime: iso(r.end_time),
    reason: r.reason,
    createdAt: iso(r.created_at),
  };
}

export function slot(r: Row) {
  return {
    courtId: r.court_id,
    date: r.local_date_text,
    startTime: iso(r.slot_start),
    endTime: iso(r.slot_end),
    status: r.status,
    booking: r.booking_id
      ? {
          id: r.booking_id,
          status: r.booking_status,
          startTime: iso(r.booking_start),
          endTime: iso(r.booking_end),
          expiresAt: iso(r.hold_expires_at),
          holdExpiresAt: iso(r.hold_expires_at),
          playerEmail: r.player_email ?? undefined,
        }
      : undefined,
    block: r.block_id ? { id: r.block_id, reason: r.block_reason } : undefined,
  };
}
