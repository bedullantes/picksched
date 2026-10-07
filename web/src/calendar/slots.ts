import type { Court, Role, Slot } from '../api/types';
import { formatMoney } from '../lib/format';

export const MAX_BOOKING_HOURS = 4;

/** The slot plus the slots directly after it on the same court and day that pass `keep`. */
export function consecutiveSlots(all: Slot[], from: Slot, keep: (s: Slot) => boolean): Slot[] {
  const sameDay = all
    .filter((s) => s.courtId === from.courtId && s.date === from.date)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  const run: Slot[] = [];
  let i = sameDay.findIndex((s) => s.startTime === from.startTime);
  if (i < 0) return run;
  for (; i < sameDay.length && keep(sameDay[i]); i++) {
    if (run.length && run[run.length - 1].endTime !== sameDay[i].startTime) break;
    run.push(sameDay[i]);
  }
  return run;
}

export function findSlot(all: Slot[] | undefined, courtId: string, startTime: string): Slot | undefined {
  return all?.find((s) => s.courtId === courtId && s.startTime === startTime);
}

export interface SlotText {
  label: string;
  detail?: string;
  /** Accessible status phrase. */
  status: string;
}

export function describeSlot(slot: Slot, role: Role, court?: Court, now?: string): SlotText {
  switch (slot.status) {
    case 'available':
      return role === 'admin'
        ? { label: 'Open', detail: 'Block time', status: 'Available' }
        : { label: 'Available', detail: court ? formatMoney(court.hourlyRate * (court.slotMinutes / 60), court.currency) : undefined, status: 'Available' };
    case 'mine':
      return {
        label: 'Your booking',
        detail: slot.booking?.status === 'pending' ? 'Awaiting payment' : 'Confirmed',
        status: 'Your booking',
      };
    case 'booked':
      if (role === 'admin' && slot.booking) {
        return {
          label: slot.booking.playerEmail ?? 'Booked',
          detail: slot.booking.status === 'pending' ? 'Pending payment' : 'Confirmed',
          status: `Booked by ${slot.booking.playerEmail ?? 'a player'}`,
        };
      }
      return { label: 'Booked', status: 'Booked' };
    case 'maintenance':
      return {
        label: 'Maintenance',
        detail: role === 'admin' ? slot.block?.reason ?? undefined : undefined,
        status: 'Unavailable, maintenance',
      };
    default:
      if (role === 'admin' && now && slot.endTime > now) {
        return { label: 'Too soon to book', detail: 'Block time', status: 'Too soon for players to book' };
      }
      return { label: 'Unavailable', status: 'Unavailable' };
  }
}

/**
 * Whether the owner can block this slot: open, or inside the advance-booking
 * window (players can't book it any more, but it hasn't ended yet).
 */
export function isBlockable(slot: Slot, now: string): boolean {
  return slot.status === 'available' || (slot.status === 'unavailable' && slot.endTime > now);
}

/** Whether clicking the slot does anything for this user. */
export function isActionable(slot: Slot, role: Role, now: string): boolean {
  if (slot.status === 'available') return true;
  if (role === 'admin' && isBlockable(slot, now)) return true;
  if (slot.status === 'mine') return !!slot.booking;
  if (role === 'admin') {
    return (slot.status === 'booked' && !!slot.booking) || (slot.status === 'maintenance' && !!slot.block);
  }
  return false;
}
