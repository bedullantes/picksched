import { useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { Court, Slot } from '../api/types';
import { formatDate, formatTime, formatTimeRange } from '../lib/format';
import { Modal } from '../components/Modal';
import { consecutiveSlots, isBlockable } from './slots';

interface MaintenanceModalProps {
  court: Court;
  slot: Slot;
  allSlots: Slot[];
  now: string;
  offline: boolean;
  onClose: () => void;
  onDone: () => void;
}

/** Owner: take a court out of service from the clicked slot onward. */
export function MaintenanceModal(p: MaintenanceModalProps) {
  const { court, slot } = p;
  const run = consecutiveSlots(p.allSlots, slot, (s) => isBlockable(s, p.now));
  const [endTime, setEndTime] = useState(slot.endTime);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stillOpen = isBlockable(slot, p.now);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api('/api/maintenance-blocks', {
        method: 'POST',
        body: { courtId: court.id, startTime: slot.startTime, endTime, reason: reason.trim() || undefined },
      });
      p.onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="Block time for maintenance"
      onClose={p.onClose}
      footer={
        <>
          <button type="button" className="button-secondary" onClick={p.onClose} disabled={submitting}>Cancel</button>
          <button type="button" className="button-warning" onClick={submit}
            disabled={submitting || !stillOpen || p.offline}>
            {submitting ? 'Blocking…' : 'Block time'}
          </button>
        </>
      }
    >
      <dl className="summary">
        <div><dt>Court</dt><dd>{court.name}</dd></div>
        <div><dt>Date</dt><dd>{formatDate(slot.date)}</dd></div>
        <div><dt>Time</dt><dd>{formatTimeRange(slot.startTime, endTime, court.timezone)}</dd></div>
      </dl>
      <label className="field">
        <span>Until</span>
        <select value={endTime} onChange={(e) => setEndTime(e.target.value)} disabled={submitting}>
          {run.map((s) => <option key={s.endTime} value={s.endTime}>{formatTime(s.endTime, court.timezone)}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Reason (only you can see this)</span>
        <input type="text" maxLength={200} value={reason} placeholder="e.g. Resurfacing"
          onChange={(e) => setReason(e.target.value)} disabled={submitting} />
      </label>
      <p className="hint">Players will see this time as unavailable.</p>
      {!stillOpen && <p className="notice notice--error" role="alert">This slot is no longer open.</p>}
      {p.offline && <p className="notice notice--warning" role="status">You're offline. Reconnect to block time.</p>}
      {error && <p className="notice notice--error" role="alert">{error}</p>}
    </Modal>
  );
}
