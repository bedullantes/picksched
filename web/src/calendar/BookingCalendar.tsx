import { useEffect, useMemo, useState } from 'react';
import type { Booking, Court, Slot, User } from '../api/types';
import { addDays, DEFAULT_TIMEZONE, formatDate, formatMoney, todayIn } from '../lib/format';
import { BlockDetailsModal, BookingDetailsModal } from './BookingDetailsModal';
import { BookingModal } from './BookingModal';
import { CalendarToolbar, type ViewMode } from './CalendarToolbar';
import { Legend } from './Legend';
import { MaintenanceModal } from './MaintenanceModal';
import { findSlot, isBlockable } from './slots';
import { GridSkeleton, SlotGrid, type GridColumn } from './SlotGrid';
import { useAvailability } from './useAvailability';
import { useCourts } from './useCourts';

interface BookingCalendarProps {
  user: User;
  /** Called after a player reserves a slot: go to the payment/confirmation step. */
  onProceedToCheckout: (bookingId: string, booking?: Booking) => void;
}

type Selection = { courtId: string; startTime: string };

/**
 * Court availability calendar.
 *  Players: see open slots and their own bookings; click an open slot to book.
 *  Owners:  see every booking on their courts; block time for maintenance;
 *           confirm, cancel or reschedule bookings.
 */
export function BookingCalendar({ user, onProceedToCheckout }: BookingCalendarProps) {
  const isOwner = user.role === 'admin';
  const { courts, error: courtsError, reload: reloadCourts } = useCourts(isOwner);

  const timeZone = courts?.[0]?.timezone ?? DEFAULT_TIMEZONE;
  const today = todayIn(timeZone);
  const [view, setView] = useState<ViewMode>('day');
  const [date, setDate] = useState(today);
  const [weekCourtId, setWeekCourtId] = useState<string>();
  const [selection, setSelection] = useState<Selection | null>(null);

  // Never show a past date, e.g. after the page stays open past midnight.
  useEffect(() => {
    if (date < today) setDate(today);
  }, [date, today]);

  useEffect(() => {
    if (courts?.length && !courts.some((c) => c.id === weekCourtId)) setWeekCourtId(courts[0].id);
  }, [courts, weekCourtId]);

  const weekView = view === 'week' && !!weekCourtId;
  const { data, error, loading, refreshing, live, online, refetch } = useAvailability({
    start: date < today ? today : date,
    days: weekView ? 7 : 1,
    courtId: weekView ? weekCourtId : undefined,
    mine: isOwner,
  });

  const courtsById = useMemo(() => new Map((data?.courts ?? courts ?? []).map((c) => [c.id, c])), [data, courts]);

  const columns: GridColumn[] = useMemo(() => {
    if (!data) return [];
    if (weekView) {
      const court = courtsById.get(weekCourtId!);
      return Array.from({ length: 7 }, (_, i) => {
        const d = addDays(data.start, i);
        return {
          key: d,
          title: formatDate(d, 'short'),
          subtitle: d === today ? 'Today' : undefined,
          slots: data.slots.filter((s) => s.date === d && s.courtId === court?.id),
        };
      });
    }
    return data.courts.map((c) => ({
      key: c.id,
      title: c.name,
      subtitle: `${formatMoney(c.hourlyRate, c.currency)}/hr${c.isActive ? '' : ' · inactive'}`,
      slots: data.slots.filter((s) => s.courtId === c.id),
    }));
  }, [data, weekView, weekCourtId, courtsById, today]);

  // Always read the selected slot from the latest data, so modals see live changes.
  const selected: Slot | undefined = selection ? findSlot(data?.slots, selection.courtId, selection.startTime) : undefined;
  const selectedCourt = selection ? courtsById.get(selection.courtId) : undefined;
  const [mode, setMode] = useState<'book' | 'block' | 'details' | 'blockDetails' | null>(null);

  const select = (slot: Slot) => {
    setSelection({ courtId: slot.courtId, startTime: slot.startTime });
    if (slot.status === 'available') setMode(isOwner ? 'block' : 'book');
    else if (isOwner && data && isBlockable(slot, data.serverTime)) setMode('block');
    else if (slot.status === 'maintenance') setMode('blockDetails');
    else setMode('details');
  };
  const close = () => {
    setSelection(null);
    setMode(null);
  };
  const done = () => {
    close();
    void refetch();
  };

  if (courtsError && !courts) {
    return <ErrorPanel message={courtsError.message} onRetry={reloadCourts} />;
  }

  return (
    <div className="calendar">
      <CalendarToolbar
        view={view}
        onViewChange={setView}
        date={date}
        today={today}
        onDateChange={setDate}
        courts={courts ?? []}
        courtId={weekCourtId}
        onCourtChange={setWeekCourtId}
        refreshing={refreshing}
        live={live}
        online={online}
      />

      {!online && (
        <p className="banner banner--warning" role="status">
          You're offline. The schedule may be out of date, and booking is paused until you reconnect.
        </p>
      )}
      {online && live === 'reconnecting' && data && (
        <p className="banner banner--info" role="status">
          Live updates paused. Reconnecting… We'll keep checking for changes every few seconds.
        </p>
      )}
      {error && data && (
        <p className="banner banner--error" role="alert">
          Couldn't refresh availability: {error.message}{' '}
          <button type="button" className="link-button" onClick={() => void refetch()}>Try again</button>
        </p>
      )}

      <Legend role={user.role} />

      <div className="calendar-body" aria-busy={loading || refreshing}>
        {loading && (
          <>
            <p className="visually-hidden" role="status">Loading availability…</p>
            <GridSkeleton />
          </>
        )}
        {!loading && error && !data && <ErrorPanel message={error.message} onRetry={() => void refetch()} />}
        {data && courts && courts.length === 0 && (
          <div className="empty-state">
            <h3>{isOwner ? 'No courts yet' : 'No courts available'}</h3>
            <p>{isOwner ? 'Add a court to start managing your schedule.' : 'Check back soon for open courts.'}</p>
          </div>
        )}
        {data && columns.length > 0 && (
          <SlotGrid
            columns={columns}
            courtsById={courtsById}
            timeZone={timeZone}
            role={user.role}
            now={data.serverTime}
            offline={!online}
            onSelect={select}
          />
        )}
      </div>

      {selected && selectedCourt && data && mode === 'book' && (
        <BookingModal
          court={selectedCourt}
          slot={selected}
          allSlots={data.slots}
          holdMinutes={data.rules.holdMinutes}
          offline={!online}
          onClose={close}
          onConflict={() => void refetch()}
          onBooked={(b) => {
            close();
            onProceedToCheckout(b.id, b);
          }}
          onContinueExisting={(id) => {
            close();
            onProceedToCheckout(id);
          }}
        />
      )}
      {selected && selectedCourt && data && mode === 'block' && (
        <MaintenanceModal
          court={selectedCourt}
          slot={selected}
          allSlots={data.slots}
          now={data.serverTime}
          offline={!online}
          onClose={close}
          onDone={done}
        />
      )}
      {selected?.booking && selectedCourt && data && mode === 'details' && (
        <BookingDetailsModal
          role={user.role}
          slot={selected}
          court={selectedCourt}
          courts={(data.courts as Court[]).filter((c) => c.isOwner)}
          allSlots={data.slots}
          offline={!online}
          onClose={close}
          onDone={done}
          onContinueToPayment={(id) => {
            close();
            onProceedToCheckout(id);
          }}
        />
      )}
      {selected?.block && selectedCourt && mode === 'blockDetails' && (
        <BlockDetailsModal slot={selected} court={selectedCourt} offline={!online} onClose={close} onDone={done} />
      )}
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="error-panel" role="alert">
      <h3>We couldn't load the schedule</h3>
      <p>{message}</p>
      <button type="button" className="button-primary" onClick={onRetry}>Try again</button>
    </div>
  );
}
