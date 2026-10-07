import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Booking } from '../src/api/types';
import { PaymentResultPage } from '../src/pages/PaymentResultPage';
import { AuthProvider } from '../src/auth/AuthContext';
import { jsonResponse } from './fixtures';

const base: Booking = {
  id: 'b1', courtId: 'c1', courtName: 'Center Court', courtTimezone: 'Asia/Manila', playerId: 'p1',
  startTime: '2099-01-01T02:00:00.000Z', endTime: '2099-01-01T03:00:00.000Z', status: 'pending_payment',
  totalAmount: 50000, currency: 'PHP', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  createdAt: new Date().toISOString(), paymentStatus: 'processing', payment: null,
};

let current: Booking;
let verifyCalls: number;

beforeEach(() => {
  current = { ...base };
  verifyCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/auth/me') return jsonResponse(200, { user: { id: 'p1', email: 'p@x.com', role: 'player' } });
    if (path === '/api/bookings/b1/payment/verify') verifyCalls++;
    if (path.startsWith('/api/bookings/b1')) return jsonResponse(200, { booking: current });
    return jsonResponse(404, {});
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderPage(result: 'success' | 'cancelled') {
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[`/bookings/b1/payment?result=${result}`]}>
        <Routes><Route path="/bookings/:id/payment" element={<PaymentResultPage />} /></Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('payment result', () => {
  it('shows "Processing payment" until the webhook confirms, then "Payment successful"', async () => {
    renderPage('success');
    expect(await screen.findByRole('heading', { name: 'Processing payment' })).toBeInTheDocument();
    expect(verifyCalls).toBeGreaterThan(0); // asked PayMongo directly too

    current = { ...base, status: 'confirmed', paymentStatus: 'paid',
      payment: { status: 'paid', method: 'gcash', amount: 50000, failureCode: null, failureMessage: null, processedAt: null, refunded: false } };
    expect(await screen.findByRole('heading', { name: 'Payment successful' }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText('GCash')).toBeInTheDocument();
    expect(screen.getByText("Your booking is confirmed. We're sending a confirmation to p@x.com.")).toBeInTheDocument();
  });

  it('shows "Payment failed" with the reason and a way to retry', async () => {
    current = { ...base, paymentStatus: 'failed',
      payment: { status: 'failed', method: 'paymaya', amount: 50000, failureCode: 'payment_declined',
        failureMessage: 'The payment was declined by the e-wallet.', processedAt: null, refunded: false } };
    renderPage('cancelled');
    expect(await screen.findByRole('heading', { name: 'Payment failed' })).toBeInTheDocument();
    expect(screen.getByText(/declined by the e-wallet.*haven't been charged/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/bookings/b1/checkout');
    expect(screen.getByText(/held for another \d+:\d\d/)).toBeInTheDocument();
  });

  it('shows "not completed" when the player backed out of PayMongo', async () => {
    current = { ...base, paymentStatus: 'processing' };
    renderPage('cancelled');
    expect(await screen.findByRole('heading', { name: 'Payment not completed' })).toBeInTheDocument();
    expect(screen.getByText(/haven't been charged/)).toBeInTheDocument();
  });

  it('explains a released slot when the hold ran out', async () => {
    current = { ...base, status: 'cancelled', paymentStatus: 'expired' };
    renderPage('success');
    expect(await screen.findByRole('heading', { name: 'Payment not completed' })).toBeInTheDocument();
    expect(screen.getByText(/slot was released/)).toBeInTheDocument();
  });

  it('explains a refund for a payment that arrived too late', async () => {
    current = { ...base, status: 'cancelled', paymentStatus: 'refunded' };
    renderPage('success');
    expect(await screen.findByRole('heading', { name: 'Payment refunded' })).toBeInTheDocument();
  });

  it('tells the player not to pay again if confirmation takes too long', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage('success');
    await screen.findByRole('heading', { name: 'Processing payment' });
    await act(async () => { await vi.advanceTimersByTimeAsync(62_000); });
    expect(screen.getByRole('heading', { name: 'Still confirming your payment' })).toBeInTheDocument();
    expect(screen.getByText(/don't pay again/i)).toBeInTheDocument();
  });
});
