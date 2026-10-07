import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/App';
import { AuthProvider } from '../src/auth/AuthContext';
import type { DashboardData } from '../src/dashboard/types';
import { jsonResponse } from './fixtures';

const summary = (bookings: number, booked: number, available: number, gross: number, payments: number) => ({
  bookings,
  occupancy: { bookedHours: booked, availableHours: available, rate: available ? booked / available : null },
  revenue: { payments, gross, providerFees: Math.round(gross * 0.025), platformFees: Math.round(gross * 0.05), net: Math.round(gross * 0.925) },
});

function dashboard(start: string, end: string, overrides: Partial<DashboardData> = {}): DashboardData {
  const days: string[] = [];
  for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return {
    timezone: 'Asia/Manila', currency: 'PHP', today: '2026-10-07',
    courts: { registered: 3, active: 2 },
    overview: {
      today: summary(4, 6, 32, 200000, 4),
      nextSevenDays: { start: '2026-10-07', end: '2026-10-13', ...summary(17, 25, 224, 0, 0) },
    },
    range: { start, end, ...summary(30, 48, 32 * days.length, 1250000, 28) },
    daily: days.map((date, i) => ({
      date, activeCourts: 2, bookings: i % 3, bookedHours: i % 5, availableHours: 32,
      occupancyRate: (i % 5) / 32, payments: i % 3, revenue: (i % 3) * 50000, netRevenue: (i % 3) * 46250,
    })),
    ...overrides,
  };
}

let role: 'admin' | 'player' | null;
let respond: (url: URL) => Response;
let calls: URL[];

beforeEach(() => {
  role = 'admin';
  calls = [];
  respond = (url) => jsonResponse(200, dashboard(url.searchParams.get('start')!, url.searchParams.get('end')!));
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/auth/me') {
      return role ? jsonResponse(200, { user: { id: 'u1', email: 'owner@x.com', role } }) : jsonResponse(401, {});
    }
    if (url.pathname === '/api/dashboard') {
      calls.push(url);
      return respond(url);
    }
    return jsonResponse(404, {});
  }));
});
afterEach(() => vi.unstubAllGlobals());

const renderAt = (path: string) => render(
  <AuthProvider><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></AuthProvider>,
);

describe('access', () => {
  it('sends players to the unauthorized page', async () => {
    role = 'player';
    renderAt('/dashboard');
    expect(await screen.findByRole('heading', { name: "You don't have access to this page" })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('sends signed-out visitors to sign in', async () => {
    role = null;
    renderAt('/dashboard');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows owners a Dashboard link', async () => {
    renderAt('/dashboard');
    expect(await screen.findByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
  });
});

describe('metrics', () => {
  it('shows today, the next 7 days and the range totals', async () => {
    renderAt('/dashboard');
    const tile = async (label: string) => (await screen.findByText(label)).closest('.stat-tile') as HTMLElement;
    expect(within(await tile('Bookings today')).getByText('4')).toBeInTheDocument();
    expect(within(await tile('Occupancy today')).getByText('19%')).toBeInTheDocument(); // 6 / 32
    expect(within(await tile('Occupancy today')).getByText('6 of 32 court-hours booked')).toBeInTheDocument();
    expect(within(await tile('Bookings, next 7 days')).getByText('17')).toBeInTheDocument();
    expect(within(await tile('Revenue')).getByText('₱12,500')).toBeInTheDocument();
    expect(within(await tile('Revenue')).getByText(/28 paid bookings/)).toBeInTheDocument();
    expect(screen.getByText(/1 inactive not counted/)).toBeInTheDocument();
  });

  it('loads the last 30 days by default and refetches for a preset', async () => {
    renderAt('/dashboard');
    await screen.findByText('Bookings today');
    const first = calls[0].searchParams;
    expect((Date.parse(first.get('end')!) - Date.parse(first.get('start')!)) / 86_400_000).toBe(29);

    await userEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() => expect(calls.at(-1)!.searchParams.get('start')).toBe('2026-10-01'));
    expect(calls.at(-1)!.searchParams.get('end')).toBe('2026-10-07');
  });

  it('applies a custom range, and rejects an end date before the start date', async () => {
    renderAt('/dashboard');
    await screen.findByText('Bookings today');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-10' } });
    await waitFor(() => expect(calls.at(-1)!.searchParams.get('end')).toBe('2026-09-10'));
    expect(calls.at(-1)!.searchParams.get('start')).toBe('2026-09-01');

    const before = calls.length;
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-15' } });
    expect(await screen.findByText("End date can't be earlier than the start date.")).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toHaveAttribute('aria-invalid', 'true');
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(before);
  });

  it('draws both trend charts with a readable tooltip and a data table', async () => {
    renderAt('/dashboard');
    const chart = await screen.findByRole('img', { name: /Daily revenue column chart/ });
    expect(screen.getByRole('img', { name: /Daily occupancy column chart/ })).toBeInTheDocument();
    chart.focus();
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    expect(within(chart.parentElement!).getByRole('status')).toHaveTextContent('₱500');

    await userEvent.click(screen.getByRole('button', { name: 'Show data table' }));
    expect(screen.getAllByRole('row')).toHaveLength(31); // header + 30 days
  });
});

describe('empty and error states', () => {
  it('shows empty states when a range has no payments or bookable hours', async () => {
    respond = (url) => {
      const d = dashboard(url.searchParams.get('start')!, url.searchParams.get('end')!);
      d.range = { ...d.range, ...summary(0, 0, 0, 0, 0) };
      return jsonResponse(200, d);
    };
    renderAt('/dashboard');
    expect(await screen.findByText('No payments in this period.')).toBeInTheDocument();
    expect(screen.getByText('No bookable hours in this period.')).toBeInTheDocument();
  });

  it('explains when the owner has no courts', async () => {
    respond = (url) => jsonResponse(200, dashboard(url.searchParams.get('start')!, url.searchParams.get('end')!, {
      courts: { registered: 0, active: 0 },
    }));
    renderAt('/dashboard');
    expect(await screen.findByRole('heading', { name: 'No courts yet' })).toBeInTheDocument();
  });

  it('shows a friendly error and recovers on retry', async () => {
    respond = () => jsonResponse(500, { error: { code: 'INTERNAL', message: 'boom' } });
    renderAt('/dashboard');
    expect(await screen.findByRole('heading', { name: 'Unable to load analytics at this time.' })).toBeInTheDocument();
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
    respond = (url) => jsonResponse(200, dashboard(url.searchParams.get('start')!, url.searchParams.get('end')!));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Bookings today')).toBeInTheDocument();
  });
});
