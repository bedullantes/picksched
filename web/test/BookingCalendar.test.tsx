import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../src/api/types';
import { BookingCalendar } from '../src/calendar/BookingCalendar';
import { todayIn } from '../src/lib/format';
import { at, availability, court, jsonResponse, playerDay, slot } from './fixtures';
import { FakeEventSource } from './setup';

const player: User = { id: 'p1', email: 'pat@example.com', role: 'player' };
const owner: User = { id: 'o1', email: 'owner@example.com', role: 'admin' };
const today = todayIn('Asia/Manila');

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Handler>;
let calls: Array<{ method: string; url: URL; body: any; headers: Record<string, string> }>;

beforeEach(() => {
  calls = [];
  routes = {
    'GET /api/courts': () => jsonResponse(200, { courts: [court] }),
    'GET /api/availability': (url) => jsonResponse(200, availability(url.searchParams.get('start')!, playerDay(url.searchParams.get('start')!))),
  };
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init.method ?? 'GET';
    calls.push({
      method, url, body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
    return handler(url, init);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const availabilityCalls = () => calls.filter((c) => c.url.pathname === '/api/availability');
const slotButton = (name: RegExp) => screen.getByRole('button', { name });

function renderCalendar(user: User = player) {
  const onProceed = vi.fn();
  render(<BookingCalendar user={user} onProceedToCheckout={onProceed} />);
  return { onProceed };
}

describe('player view', () => {
  it('shows a loading state, then each slot with its status', async () => {
    renderCalendar();
    expect(screen.getByText('Loading availability…')).toBeInTheDocument();

    expect(await screen.findByRole('button', { name: /10:00 AM.*Available/ })).toBeEnabled();
    expect(slotButton(/7:00 AM.*Booked/)).toBeDisabled();
    expect(slotButton(/8:00 AM.*maintenance/i)).toBeDisabled();
    expect(slotButton(/6:00 AM.*Unavailable/)).toBeDisabled();
    expect(slotButton(/9:00 AM.*Your booking/)).toBeEnabled();
    expect(screen.queryByText('Loading availability…')).not.toBeInTheDocument();
    expect(availabilityCalls()[0].url.searchParams.get('start')).toBe(today);
    expect(availabilityCalls()[0].url.searchParams.get('mine')).toBeNull();
  });

  it("doesn't show who booked a slot", async () => {
    renderCalendar();
    const booked = await screen.findByRole('button', { name: /7:00 AM.*Booked/ });
    expect(booked).toHaveTextContent('Booked');
    expect(booked).not.toHaveTextContent(/@|pending|confirmed/i);
    expect(booked).toHaveAccessibleName(/Booked$/);
  });

  it('opens a pre-filled confirmation and proceeds to checkout', async () => {
    routes['POST /api/bookings'] = () => jsonResponse(201, {
      booking: { id: 'b-new', courtId: 'c1', status: 'pending_payment', totalAmount: 50000, currency: 'PHP' },
    });
    const { onProceed } = renderCalendar();
    await userEvent.click(await screen.findByRole('button', { name: /10:00 AM.*Available/ }));

    const dialog = screen.getByRole('dialog', { name: 'Confirm booking' });
    expect(within(dialog).getByText('Center Court · Makati')).toBeInTheDocument();
    expect(within(dialog).getByText('10:00 AM – 11:00 AM')).toBeInTheDocument();
    expect(within(dialog).getAllByText('₱500').length).toBeGreaterThan(0);

    await userEvent.click(within(dialog).getByRole('button', { name: /Reserve & continue/ }));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ courtId: 'c1', startTime: at(today, 10), endTime: at(today, 11) });
    expect(onProceed).toHaveBeenCalledWith('b-new', expect.objectContaining({ id: 'b-new' }));
  });

  it('sends an idempotency key and retries once with it after a dropped connection', async () => {
    let attempts = 0;
    routes['POST /api/bookings'] = () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new TypeError('Failed to fetch'));
      return jsonResponse(200, { booking: { id: 'b-replayed' }, replayed: true });
    };
    const { onProceed } = renderCalendar();
    await userEvent.click(await screen.findByRole('button', { name: /10:00 AM.*Available/ }));
    await userEvent.click(screen.getByRole('button', { name: /Reserve & continue/ }));

    // The automatic retry happens after a 1s delay, longer than waitFor's default timeout.
    await waitFor(() => expect(onProceed).toHaveBeenCalledWith('b-replayed', expect.anything()), { timeout: 3000 });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    const key = posts[0].headers['Idempotency-Key'];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(posts[1].headers['Idempotency-Key']).toBe(key);
  });

  it('explains a dropped connection and reuses the same key when the player tries again', async () => {
    routes['POST /api/bookings'] = () => Promise.reject(new TypeError('Failed to fetch'));
    renderCalendar();
    await userEvent.click(await screen.findByRole('button', { name: /10:00 AM.*Available/ }));
    await userEvent.click(screen.getByRole('button', { name: /Reserve & continue/ }));
    expect(await screen.findByText(/connection dropped.*won't be double-booked/, undefined, { timeout: 3000 })).toBeInTheDocument();

    routes['POST /api/bookings'] = () => jsonResponse(201, { booking: { id: 'b-ok' } });
    await userEvent.click(screen.getByRole('button', { name: /Reserve & continue/ }));
    const keys = new Set(calls.filter((c) => c.method === 'POST').map((c) => c.headers['Idempotency-Key']));
    expect(keys.size).toBe(1);
  });

  it('offers longer durations over consecutive open slots', async () => {
    routes['POST /api/bookings'] = () => jsonResponse(201, { booking: { id: 'b2' } });
    renderCalendar();
    await userEvent.click(await screen.findByRole('button', { name: /10:00 AM.*Available/ }));
    const dialog = screen.getByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Duration'), '2');
    expect(within(dialog).getByText('10:00 AM – 12:00 PM')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /Reserve & continue · ₱1,000/ }));
    expect(calls.find((c) => c.method === 'POST')!.body.endTime).toBe(at(today, 12));
  });

  it('explains a slot that was just taken, and refreshes the calendar', async () => {
    routes['POST /api/bookings'] = () => jsonResponse(409, {
      error: { code: 'SLOT_UNAVAILABLE', message: 'This time slot is no longer available. Someone else may have just booked it.' },
    });
    renderCalendar();
    await userEvent.click(await screen.findByRole('button', { name: /10:00 AM.*Available/ }));
    const before = availabilityCalls().length;
    await userEvent.click(screen.getByRole('button', { name: /Reserve & continue/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer available/);
    await waitFor(() => expect(availabilityCalls().length).toBeGreaterThan(before));
  });

  it('updates an open confirmation when a live update shows the slot was taken', async () => {
    renderCalendar();
    await userEvent.click(await screen.findByRole('button', { name: /10:00 AM.*Available/ }));
    expect(screen.getByRole('button', { name: /Reserve & continue/ })).toBeEnabled();

    routes['GET /api/availability'] = (url) => {
      const d = url.searchParams.get('start')!;
      return jsonResponse(200, availability(d, playerDay(d).map((s) => (s.startTime === at(d, 10) ? { ...s, status: 'booked' } : s))));
    };
    act(() => FakeEventSource.instances[0].emit('schedule-changed', {
      courtId: 'c1', startTime: at(today, 10), endTime: at(today, 11),
    }));

    expect(await screen.findByText(/just taken by someone else/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reserve & continue/ })).toBeDisabled();
  });

  it('ignores live updates for other courts', async () => {
    renderCalendar();
    await screen.findByRole('button', { name: /10:00 AM.*Available/ });
    const before = availabilityCalls().length;
    act(() => FakeEventSource.instances[0].emit('schedule-changed', {
      courtId: 'other', startTime: at(today, 10), endTime: at(today, 11),
    }));
    await new Promise((r) => setTimeout(r, 400));
    expect(availabilityCalls().length).toBe(before);
  });

  it('shows a friendly error with retry when loading fails', async () => {
    routes['GET /api/availability'] = () => jsonResponse(503, {
      error: { code: 'DB_TIMEOUT', message: 'The booking service is busy right now. Please try again in a moment.' },
    });
    renderCalendar();
    expect(await screen.findByText(/busy right now/)).toBeInTheDocument();

    routes['GET /api/availability'] = (url) => jsonResponse(200, availability(today, playerDay(url.searchParams.get('start')!)));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /10:00 AM.*Available/ })).toBeInTheDocument();
  });

  it('reports a lost connection', async () => {
    routes['GET /api/availability'] = () => Promise.reject(new TypeError('Failed to fetch'));
    renderCalendar();
    expect(await screen.findByText(/Can't reach PickSched/)).toBeInTheDocument();
  });

  it('pauses booking while offline and refreshes on reconnect', async () => {
    renderCalendar();
    const open = await screen.findByRole('button', { name: /10:00 AM.*Available/ });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(screen.getByText(/You're offline/)).toBeInTheDocument();
    expect(open).toBeDisabled();

    const before = availabilityCalls().length;
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(availabilityCalls().length).toBeGreaterThan(before));
    expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument();
  });

  it('flags paused live updates', async () => {
    renderCalendar();
    await screen.findByRole('button', { name: /10:00 AM.*Available/ });
    act(() => FakeEventSource.instances[0].fail());
    expect(screen.getByText(/Live updates paused/)).toBeInTheDocument();
  });
});

describe('navigation', () => {
  it('switches to the week view for one court', async () => {
    routes['GET /api/availability'] = (url) => {
      const start = url.searchParams.get('start')!;
      const days = Number(url.searchParams.get('days'));
      const slots = Array.from({ length: days }, (_, i) => {
        const d = new Date(`${start}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + i);
        return slot(d.toISOString().slice(0, 10), 10, 'available');
      });
      return jsonResponse(200, availability(start, slots, [court], days));
    };
    renderCalendar();
    await screen.findAllByRole('button', { name: /Available/ });
    await userEvent.click(screen.getByRole('button', { name: 'Week' }));

    await waitFor(() => expect(screen.getAllByRole('button', { name: /Available/ })).toHaveLength(7));
    const last = availabilityCalls().at(-1)!.url.searchParams;
    expect(last.get('days')).toBe('7');
    expect(last.get('courtId')).toBe('c1');
  });

  it("doesn't allow going before today", async () => {
    renderCalendar();
    await screen.findAllByRole('button', { name: /Available/ });
    expect(screen.getByRole('button', { name: 'Previous day' })).toBeDisabled();
    expect(screen.getByLabelText('Date')).toHaveAttribute('min', today);
  });

  it('rejects a typed past date', async () => {
    renderCalendar();
    await screen.findAllByRole('button', { name: /Available/ });
    const input = screen.getByLabelText('Date');
    fireEvent.change(input, { target: { value: '2020-01-01' } });
    expect(screen.getByText("You can't pick a date in the past.")).toBeInTheDocument();
    expect(availabilityCalls().every((c) => c.url.searchParams.get('start')! >= today)).toBe(true);
  });
});

describe('owner view', () => {
  const ownerDay = (d: string) => [
    slot(d, 9, 'booked', {
      booking: { id: 'b1', status: 'confirmed', startTime: at(d, 9), endTime: at(d, 10), expiresAt: null, playerEmail: 'pat@example.com' },
    }),
    slot(d, 10, 'available'),
    slot(d, 11, 'maintenance', { block: { id: 'blk1', reason: 'Resurfacing' } }),
  ];

  beforeEach(() => {
    routes['GET /api/courts'] = () => jsonResponse(200, { courts: [{ ...court, isOwner: true }] });
    routes['GET /api/availability'] = (url) =>
      jsonResponse(200, availability(url.searchParams.get('start')!, ownerDay(url.searchParams.get('start')!), [{ ...court, isOwner: true }]));
  });

  it('requests the facility view and shows who booked each slot', async () => {
    renderCalendar(owner);
    expect(await screen.findByRole('button', { name: /9:00 AM.*Booked by pat@example.com/ })).toBeEnabled();
    expect(slotButton(/11:00 AM.*maintenance.*Resurfacing/i)).toBeEnabled();
    expect(availabilityCalls()[0].url.searchParams.get('mine')).toBe('1');
    expect(calls.find((c) => c.url.pathname === '/api/courts')!.url.searchParams.get('mine')).toBe('1');
  });

  it('blocks an open slot for maintenance', async () => {
    routes['POST /api/maintenance-blocks'] = () => jsonResponse(201, { block: { id: 'blk2' } });
    renderCalendar(owner);
    await userEvent.click(await screen.findByRole('button', { name: /10:00 AM.*Available/ }));
    const dialog = screen.getByRole('dialog', { name: 'Block time for maintenance' });
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Net repair');
    const before = availabilityCalls().length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Block time' }));

    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url.pathname).toBe('/api/maintenance-blocks');
    expect(post.body).toEqual({ courtId: 'c1', startTime: at(today, 10), endTime: at(today, 11), reason: 'Net repair' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(availabilityCalls().length).toBeGreaterThan(before);
  });

  it('shows a blocking error from the server', async () => {
    routes['POST /api/maintenance-blocks'] = () => jsonResponse(409, {
      error: { code: 'BLOCK_OVERLAPS_BOOKINGS', message: 'That time overlaps existing bookings. Cancel or move them before blocking it.' },
    });
    renderCalendar(owner);
    await userEvent.click(await screen.findByRole('button', { name: /10:00 AM.*Available/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Block time' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/overlaps existing bookings/);
  });

  it("can't change a booking while the player is checking out", async () => {
    routes['GET /api/availability'] = (url) => {
      const d = url.searchParams.get('start')!;
      return jsonResponse(200, availability(d, [slot(d, 9, 'booked', {
        booking: {
          id: 'b-co', status: 'pending_payment', startTime: at(d, 9), endTime: at(d, 10),
          expiresAt: new Date(Date.now() + 120_000).toISOString(), playerEmail: 'pat@example.com',
        },
      })], [{ ...court, isOwner: true }]));
    };
    renderCalendar(owner);
    await userEvent.click(await screen.findByRole('button', { name: /Booked by pat@example.com, Checking out/ }));
    const dialog = screen.getByRole('dialog', { name: 'Booking details' });
    expect(within(dialog).getByText(/paying for this booking right now/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Cancel booking|Reschedule|Mark as paid/ })).not.toBeInTheDocument();
  });

  it('reschedules a booking', async () => {
    routes['PATCH /api/bookings/b1'] = () => jsonResponse(200, { booking: { id: 'b1' } });
    renderCalendar(owner);
    await userEvent.click(await screen.findByRole('button', { name: /Booked by pat@example.com/ }));
    const dialog = screen.getByRole('dialog', { name: 'Booking details' });
    expect(within(dialog).getByText('pat@example.com')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reschedule' }));
    await userEvent.selectOptions(within(dialog).getByLabelText('Start time'), at(today, 10));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save new time' }));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ courtId: 'c1', startTime: at(today, 10), endTime: at(today, 11) });
  });

  it('removes a maintenance block', async () => {
    routes['DELETE /api/maintenance-blocks/blk1'] = () => new Response(null, { status: 204 });
    renderCalendar(owner);
    await userEvent.click(await screen.findByRole('button', { name: /maintenance/i }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove block' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });
});
