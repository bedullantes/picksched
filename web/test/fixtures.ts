import type { Availability, Court, Slot, SlotStatus } from '../src/api/types';

export const court: Court = {
  id: 'c1', name: 'Center Court', description: null, location: 'Makati', hourlyRate: 50000, currency: 'PHP',
  isActive: true, timezone: 'Asia/Manila', opensAt: '06:00', closesAt: '12:00', slotMinutes: 60, isOwner: false,
};

/** ISO time for hour h on a Manila date. */
export const at = (date: string, h: number) =>
  new Date(`${date}T${String(h).padStart(2, '0')}:00:00+08:00`).toISOString();

export function slot(date: string, h: number, status: SlotStatus, extra: Partial<Slot> = {}, courtId = 'c1'): Slot {
  return { courtId, date, startTime: at(date, h), endTime: at(date, h + 1), status, ...extra };
}

export function availability(start: string, slots: Slot[], courts: Court[] = [court], days = 1): Availability {
  return {
    serverTime: new Date().toISOString(),
    rules: { minLeadMinutes: 60, holdMinutes: 15 },
    start,
    days,
    courts,
    slots,
  };
}

/** Default day: 6 open, 7 booked by someone, 8 maintenance, 9 mine (pending), 10-11 open. */
export function playerDay(date: string): Slot[] {
  return [
    slot(date, 6, 'unavailable'),
    slot(date, 7, 'booked'),
    slot(date, 8, 'maintenance'),
    slot(date, 9, 'mine', {
      booking: { id: 'b-mine', status: 'pending_payment', startTime: at(date, 9), endTime: at(date, 10), expiresAt: at(date, 9) },
    }),
    slot(date, 10, 'available'),
    slot(date, 11, 'available'),
  ];
}

export function jsonResponse(status: number, body: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
