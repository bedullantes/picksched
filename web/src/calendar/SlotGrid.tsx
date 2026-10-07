import type { Court, Role, Slot } from '../api/types';
import { formatTime, formatTimeRange, timeKey } from '../lib/format';
import { describeSlot, isActionable } from './slots';

export interface GridColumn {
  key: string;
  title: string;
  subtitle?: string;
  slots: Slot[];
}

interface SlotGridProps {
  columns: GridColumn[];
  courtsById: Map<string, Court>;
  timeZone: string;
  role: Role;
  /** Server time (ISO) of the latest data. */
  now: string;
  offline: boolean;
  onSelect: (slot: Slot) => void;
}

/**
 * Timeline grid: one column per court (day view) or per day (week view),
 * one row per time slot. Below 720px wide the columns stack and slots wrap,
 * each showing its own time label.
 */
export function SlotGrid({ columns, courtsById, timeZone, role, now, offline, onSelect }: SlotGridProps) {
  const rows = [...new Set(columns.flatMap((c) => c.slots.map((s) => timeKey(s.startTime, timeZone))))].sort();
  const rowIndex = new Map(rows.map((r, i) => [r, i + 1]));
  const sampleSlot = (key: string) =>
    columns.flatMap((c) => c.slots).find((s) => timeKey(s.startTime, timeZone) === key)!;

  return (
    <div className="slot-grid" style={{ ['--rows' as string]: rows.length, ['--cols' as string]: columns.length }}>
      <div className="time-gutter" aria-hidden="true">
        <div className="column-header" />
        <div className="column-slots">
          {rows.map((r) => (
            <div key={r} className="time-label" style={{ gridRow: rowIndex.get(r) }}>
              {formatTime(sampleSlot(r).startTime, timeZone)}
            </div>
          ))}
        </div>
      </div>

      {columns.map((col) => (
        <section key={col.key} className="grid-column" aria-label={col.title}>
          <header className="column-header">
            <span className="column-title">{col.title}</span>
            {col.subtitle && <span className="column-subtitle">{col.subtitle}</span>}
          </header>
          {col.slots.length === 0 ? (
            <p className="column-empty">Closed</p>
          ) : (
            <ul className="column-slots">
              {col.slots.map((slot) => {
                const court = courtsById.get(slot.courtId);
                const text = describeSlot(slot, role, court, now);
                const range = formatTimeRange(slot.startTime, slot.endTime, timeZone);
                const actionable = isActionable(slot, role, now);
                const blockedByOffline = offline && (slot.status === 'available' || slot.status === 'unavailable');
                return (
                  <li key={slot.startTime} style={{ gridRow: rowIndex.get(timeKey(slot.startTime, timeZone)) }}>
                    <button
                      type="button"
                      className={`slot slot--${slot.status}${slot.booking?.status === 'pending' ? ' slot--pending' : ''}`}
                      disabled={!actionable || blockedByOffline}
                      title={blockedByOffline ? "You're offline. Reconnect to book." : undefined}
                      aria-label={`${col.title}, ${range}, ${text.status}${text.detail ? `, ${text.detail}` : ''}`}
                      data-status={slot.status}
                      onClick={() => onSelect(slot)}
                    >
                      <span className="slot-time">{formatTime(slot.startTime, timeZone)}</span>
                      <span className="slot-label">{text.label}</span>
                      {text.detail && <span className="slot-detail">{text.detail}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

export function GridSkeleton() {
  return (
    <div className="grid-skeleton" aria-hidden="true">
      {Array.from({ length: 3 }, (_, c) => (
        <div key={c} className="skeleton-column">
          <div className="skeleton-block skeleton-header" />
          {Array.from({ length: 8 }, (_, r) => <div key={r} className="skeleton-block" />)}
        </div>
      ))}
    </div>
  );
}
