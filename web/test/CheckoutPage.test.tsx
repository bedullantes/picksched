import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthContext';
import { CheckoutPage } from '../src/pages/CheckoutPage';
import { jsonResponse } from './fixtures';

const booking = {
  id: 'b1', courtId: 'c1', courtName: 'Center Court', courtTimezone: 'Asia/Manila', playerId: 'p1',
  startTime: '2099-01-01T02:00:00.000Z', endTime: '2099-01-01T03:00:00.000Z', status: 'pending_payment',
  totalAmount: 50000, currency: 'PHP', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  createdAt: new Date().toISOString(), isMine: true, holdExpired: false,
};

let checkoutResponse: () => Response;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/auth/me') return jsonResponse(200, { user: { id: 'p1', email: 'p@x.com', role: 'player' } });
    if (path === '/api/bookings/b1') return jsonResponse(200, { booking });
    if (path === '/api/bookings/b1/checkout' && init.method === 'POST') return checkoutResponse();
    return jsonResponse(404, {});
  }));
});
afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/bookings/b1/checkout']}>
        <Routes><Route path="/bookings/:id/checkout" element={<CheckoutPage />} /></Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('checkout', () => {
  it('shows the held booking with a countdown', async () => {
    checkoutResponse = () => jsonResponse(200, {});
    renderPage();
    expect(await screen.findByText('Center Court')).toBeInTheDocument();
    expect(screen.getByText('10:00 AM – 11:00 AM')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/Slot held for you for \d+:\d\d/);
  });

  it('re-checks the hold on the final click and continues when valid', async () => {
    checkoutResponse = () => jsonResponse(200, {
      state: 'awaiting_payment', booking, payment: { provider: 'paymongo', amount: 50000, currency: 'PHP' },
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /Proceed to payment/ }));
    expect(await screen.findByText(/Your slot is still reserved/)).toBeInTheDocument();
  });

  it('explains when the hold expired before the final click', async () => {
    checkoutResponse = () => jsonResponse(409, {
      error: { code: 'HOLD_EXPIRED', message: 'Your hold on this slot expired and it was released. Please choose a slot again.' },
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /Proceed to payment/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/hold on this slot expired/);
    expect(screen.getByRole('link', { name: 'Back to calendar' })).toBeInTheDocument();
  });
});
