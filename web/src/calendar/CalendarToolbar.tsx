import { useId, useState } from 'react';
import type { Court } from '../api/types';
import { addDays, formatDate } from '../lib/format';
import type { LiveStatus } from './useAvailability';

export type ViewMode = 'day' | 'week';

interface ToolbarProps {
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
  date: string;
  today: string;
  onDateChange: (d: string) => void;
  courts: Court[];
  courtId: string | undefined;
  onCourtChange: (id: string) => void;
  refreshing: boolean;
  live: LiveStatus;
  online: boolean;
}

export function CalendarToolbar(p: ToolbarProps) {
  const dateInputId = useId();
  const courtInputId = useId();
  const [dateError, setDateError] = useState<string | null>(null);
  const step = p.view === 'week' ? 7 : 1;
  const prev = addDays(p.date, -step) < p.today ? p.today : addDays(p.date, -step);
  const rangeLabel = p.view === 'week'
    ? `${formatDate(p.date, 'short')} – ${formatDate(addDays(p.date, 6), 'short')}`
    : formatDate(p.date);

  const pickDate = (value: string) => {
    if (!value) return;
    if (value < p.today) {
      setDateError("You can't pick a date in the past.");
      return;
    }
    setDateError(null);
    p.onDateChange(value);
  };

  return (
    <div className="toolbar">
      <div className="toolbar-row">
        <div className="segmented" role="group" aria-label="Calendar view">
          {(['day', 'week'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={p.view === v} onClick={() => p.onViewChange(v)}>
              {v === 'day' ? 'Day' : 'Week'}
            </button>
          ))}
        </div>

        <div className="date-nav">
          <button type="button" className="icon-button" aria-label={`Previous ${p.view}`}
            disabled={p.date <= p.today} onClick={() => p.onDateChange(prev)}>‹</button>
          <button type="button" className="text-button" disabled={p.date === p.today}
            onClick={() => p.onDateChange(p.today)}>Today</button>
          <button type="button" className="icon-button" aria-label={`Next ${p.view}`}
            onClick={() => p.onDateChange(addDays(p.date, step))}>›</button>
        </div>

        <label className="field-inline" htmlFor={dateInputId}>
          <span className="visually-hidden">Date</span>
          <input id={dateInputId} type="date" value={p.date} min={p.today}
            onChange={(e) => pickDate(e.target.value)} />
        </label>

        {p.view === 'week' && p.courts.length > 0 && (
          <label className="field-inline" htmlFor={courtInputId}>
            <span className="visually-hidden">Court</span>
            <select id={courtInputId} value={p.courtId} onChange={(e) => p.onCourtChange(e.target.value)}>
              {p.courts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}

        <span className={`live-status live-status--${p.online ? p.live : 'offline'}`} role="status">
          {p.refreshing ? 'Updating…' : !p.online ? 'Offline' : p.live === 'live' ? 'Live' : 'Reconnecting…'}
        </span>
      </div>
      <h2 className="range-label">{rangeLabel}</h2>
      {dateError && <p className="field-error" role="alert">{dateError}</p>}
    </div>
  );
}
