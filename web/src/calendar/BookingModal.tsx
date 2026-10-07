import { useState } from 'react';
import { api, ApiError, errorMessage } from '../api/client';
import type { Booking, Court, Slot } from '../api/types';
import { durationLabel, formatDate, formatMoney, formatTimeRange } from '../lib/format';
import { Modal } from '../components/Modal';
import { consecutiveSlots, MAX_BOOKING_HOURS } from './slots';

interface BookingModalProps {
  court: Court;
  /** The selected slot as it appears in the latest availability data. */
  slot: Slot;
  allSlots: Slot[];
  holdMinutes: number;
  offline: boolean;
  onClose: () => void;
  onBooked: (booking: Booking) => void;
  onConflict: () => void;
  onContinueExisting: (bookingId: string) => void;
}

/** Booking Confirmation: court and time come pre-filled from the clicked slot. */
export function BookingModal(p: BookingModalProps) {
  const { court, slot } = p;
  const maxSlots = Math.max(1, Math.floor((MAX_BOOKING_HOURS * 60) / court.slotMinutes));
  const run = consecutiveSlots(p.allSlots, slot, (s) => s.status === 'available').slice(0, maxSlots);
  const [count, setCount] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = run.slice(0, Math.max(1, Math.min(count, run.length)));
  const end = chosen[chosen.length - 1]?.endTime ?? slot.endTime;
  const minutes = chosen.length * court.slotMinutes;
  const price = Math.round((court.hourlyRate * minutes) / 60);

  // The slot changed under us (live update): someone else took it, or this user did in another tab.
  const takenByOther = slot.status !== 'available' && slot.status !== 'mine';
  const alreadyMine = slot.status === 'mine' && slot.booking;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api<{ booking: Booking }>('/api/bookings', {
        method: 'POST',
        body: { courtId: court.id, startTime: slot.startTime, endTime: end },
      });
      p.onBooked(res.booking);
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && (err.status === 409 || err.isConnectivity)) p.onConflict();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="Confirm booking"
      onClose={p.onClose}
      footer={alreadyMine ? (
        <>
          <button type="button" className="button-secondary" onClick={p.onClose}>Close</button>
          <button type="button" className="button-primary" onClick={() => p.onContinueExisting(slot.booking!.id)}>
            Continue to payment
          </button>
        </>
      ) : (
        <>
          <button type="button" className="button-secondary" onClick={p.onClose} disabled={submitting}>Cancel</button>
          <button type="button" className="button-primary" onClick={submit}
            disabled={submitting || takenByOther || p.offline || run.length === 0}>
            {submitting ? 'Reserving…' : `Reserve & continue · ${formatMoney(price, court.currency)}`}
          </button>
        </>
      )}
    >
      <dl className="summary">
        <div><dt>Court</dt><dd>{court.name}{court.location ? ` · ${court.location}` : ''}</dd></div>
        <div><dt>Date</dt><dd>{formatDate(slot.date)}</dd></div>
        <div><dt>Time</dt><dd>{formatTimeRange(slot.startTime, end, court.timezone)}</dd></div>
        <div><dt>Total</dt><dd>{formatMoney(price, court.currency)}</dd></div>
      </dl>

      {!alreadyMine && run.length > 1 && (
        <label className="field">
          <span>Duration</span>
          <select value={chosen.length} onChange={(e) => setCount(Number(e.target.value))} disabled={submitting}>
            {run.map((_, i) => (
              <option key={i} value={i + 1}>{durationLabel((i + 1) * court.slotMinutes)}</option>
            ))}
          </select>
        </label>
      )}

      {alreadyMine ? (
        <p className="notice notice--info" role="status">You already hold this slot. Continue to payment to confirm it.</p>
      ) : takenByOther ? (
        <p className="notice notice--error" role="alert">
          This slot was just taken by someone else. Please close this and choose another time.
        </p>
      ) : (
        <p className="hint">
          We'll hold this slot for {p.holdMinutes} minutes while you complete payment.
        </p>
      )}
      {p.offline && !alreadyMine && (
        <p className="notice notice--warning" role="status">You're offline. Reconnect to reserve this slot.</p>
      )}
      {/* Once live data shows the slot is gone, the notice above already says so. */}
      {error && !takenByOther && <p className="notice notice--error" role="alert">{error}</p>}
    </Modal>
  );
}
