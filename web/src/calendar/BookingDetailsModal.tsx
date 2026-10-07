import { useMemo, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { Court, Role, Slot } from '../api/types';
import { formatDate, formatTime, formatTimeRange } from '../lib/format';
import { Modal } from '../components/Modal';

interface BookingDetailsModalProps {
  role: Role;
  slot: Slot;
  court: Court;
  courts: Court[];
  /** Availability for the slot's day, used to offer reschedule times. */
  allSlots: Slot[];
  offline: boolean;
  onClose: () => void;
  onDone: () => void;
  onContinueToPayment: (bookingId: string) => void;
}

/** Booking details. Owners can confirm, cancel or move it; players can cancel their own. */
export function BookingDetailsModal(p: BookingDetailsModalProps) {
  const booking = p.slot.booking!;
  const isOwner = p.role === 'admin';
  const tz = p.court.timezone;
  const durationMs = new Date(booking.endTime).getTime() - new Date(booking.startTime).getTime();
  // While the player is paying, owners can look but not change anything (the API refuses too).
  const inCheckout = booking.status === 'pending_payment'
    && !!booking.expiresAt && new Date(booking.expiresAt).getTime() > Date.now();
  const ownerLocked = isOwner && inCheckout;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [moving, setMoving] = useState(false);
  const [targetCourtId, setTargetCourtId] = useState(p.court.id);
  const [targetStart, setTargetStart] = useState('');

  // Start times on the same day where the booking (same length) fits in open slots.
  const startOptions = useMemo(() => {
    const day = p.allSlots
      .filter((s) => s.courtId === targetCourtId && s.date === p.slot.date)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
    const free = (s: Slot) => s.status === 'available' || s.booking?.id === booking.id;
    return day.filter((s, i) => {
      const end = new Date(new Date(s.startTime).getTime() + durationMs).toISOString();
      if (s.startTime === booking.startTime && targetCourtId === p.court.id) return false;
      for (let j = i; j < day.length && day[j].startTime < end; j++) {
        if (!free(day[j]) || (j > i && day[j].startTime !== day[j - 1].endTime)) return false;
        if (day[j].endTime >= end) return true;
      }
      return false;
    });
  }, [p.allSlots, targetCourtId, p.slot.date, booking.id, booking.startTime, durationMs, p.court.id]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      p.onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => run(() => api(`/api/bookings/${booking.id}/cancel`, { method: 'POST' }));
  const move = () => run(() => api(`/api/bookings/${booking.id}`, {
    method: 'PATCH',
    body: {
      courtId: targetCourtId,
      startTime: targetStart,
      endTime: new Date(new Date(targetStart).getTime() + durationMs).toISOString(),
    },
  }));

  const disabled = busy || p.offline;

  return (
    <Modal
      title={isOwner ? 'Booking details' : 'Your booking'}
      onClose={p.onClose}
      footer={
        <>
          {confirmCancel ? (
            <>
              <span className="footer-question">Cancel this booking?</span>
              <button type="button" className="button-secondary" onClick={() => setConfirmCancel(false)} disabled={busy}>
                Keep it
              </button>
              <button type="button" className="button-danger" onClick={cancel} disabled={disabled}>
                {busy ? 'Cancelling…' : 'Yes, cancel'}
              </button>
            </>
          ) : ownerLocked ? (
            <button type="button" className="button-secondary" onClick={p.onClose}>Close</button>
          ) : (
            <>
              <button type="button" className="button-danger-outline" onClick={() => setConfirmCancel(true)} disabled={disabled}>
                {!isOwner && booking.status === 'pending_payment' ? 'Release slot' : 'Cancel booking'}
              </button>
              {isOwner && booking.status === 'pending_payment' && (
                <span className="footer-question">Payment window expired</span>
              )}
              {isOwner && booking.status === 'confirmed' && !moving && (
                <button type="button" className="button-secondary" onClick={() => setMoving(true)} disabled={disabled}>
                  Reschedule
                </button>
              )}
              {!isOwner && booking.status === 'pending_payment' && (
                <button type="button" className="button-primary" onClick={() => p.onContinueToPayment(booking.id)}>
                  Continue to payment
                </button>
              )}
            </>
          )}
        </>
      }
    >
      <dl className="summary">
        <div><dt>Court</dt><dd>{p.court.name}</dd></div>
        <div><dt>Date</dt><dd>{formatDate(p.slot.date)}</dd></div>
        <div><dt>Time</dt><dd>{formatTimeRange(booking.startTime, booking.endTime, tz)}</dd></div>
        {isOwner && <div><dt>Player</dt><dd>{booking.playerEmail ?? '—'}</dd></div>}
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`badge badge--${booking.status}`}>
              {booking.status === 'pending_payment' ? 'Awaiting payment' : booking.status === 'confirmed' ? 'Confirmed' : 'Cancelled'}
            </span>
            {booking.status === 'pending_payment' && booking.expiresAt && (
              <span className="hint"> · held until {formatTime(booking.expiresAt, tz)}</span>
            )}
          </dd>
        </div>
      </dl>

      {ownerLocked && (
        <p className="notice notice--info" role="status">
          The player is paying for this booking right now. You can change it once checkout finishes, or after the
          hold expires at {formatTime(booking.expiresAt!, tz)}.
        </p>
      )}

      {isOwner && moving && (
        <fieldset className="reschedule">
          <legend>Move to</legend>
          <label className="field">
            <span>Court</span>
            <select value={targetCourtId} onChange={(e) => { setTargetCourtId(e.target.value); setTargetStart(''); }} disabled={busy}>
              {p.courts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Start time</span>
            <select value={targetStart} onChange={(e) => setTargetStart(e.target.value)} disabled={busy}>
              <option value="">Choose a time…</option>
              {startOptions.map((s) => <option key={s.startTime} value={s.startTime}>{formatTime(s.startTime, tz)}</option>)}
            </select>
          </label>
          {startOptions.length === 0 && <p className="hint">No open times that day fit this booking.</p>}
          <div className="reschedule-actions">
            <button type="button" className="button-secondary" onClick={() => setMoving(false)} disabled={busy}>Back</button>
            <button type="button" className="button-primary" onClick={move} disabled={disabled || !targetStart}>
              {busy ? 'Saving…' : 'Save new time'}
            </button>
          </div>
        </fieldset>
      )}

      {p.offline && <p className="notice notice--warning" role="status">You're offline. Changes are disabled until you reconnect.</p>}
      {error && <p className="notice notice--error" role="alert">{error}</p>}
    </Modal>
  );
}

interface BlockDetailsModalProps {
  slot: Slot;
  court: Court;
  offline: boolean;
  onClose: () => void;
  onDone: () => void;
}

/** Owner: view or remove a maintenance block. */
export function BlockDetailsModal(p: BlockDetailsModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/maintenance-blocks/${p.slot.block!.id}`, { method: 'DELETE' });
      p.onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Maintenance block"
      onClose={p.onClose}
      footer={
        <>
          <button type="button" className="button-secondary" onClick={p.onClose} disabled={busy}>Close</button>
          <button type="button" className="button-danger-outline" onClick={remove} disabled={busy || p.offline}>
            {busy ? 'Removing…' : 'Remove block'}
          </button>
        </>
      }
    >
      <dl className="summary">
        <div><dt>Court</dt><dd>{p.court.name}</dd></div>
        <div><dt>Date</dt><dd>{formatDate(p.slot.date)}</dd></div>
        <div><dt>Slot</dt><dd>{formatTimeRange(p.slot.startTime, p.slot.endTime, p.court.timezone)}</dd></div>
        <div><dt>Reason</dt><dd>{p.slot.block?.reason ?? '—'}</dd></div>
      </dl>
      <p className="hint">Removing the block reopens the whole blocked period for booking.</p>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
    </Modal>
  );
}
