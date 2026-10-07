import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api/client';
import type { Booking } from '../api/types';
import { AppHeader } from '../components/AppHeader';
import { DEFAULT_TIMEZONE, formatDate, formatMoney, formatTimeRange, todayIn } from '../lib/format';
import { useOnline } from '../lib/useOnline';

interface CheckoutResult {
  state: 'awaiting_payment' | 'confirmed';
  booking: Booking;
  payment: { provider: string; amount: number; currency: string };
}

function useCountdown(until: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return null;
  return Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
}

/** Payment / confirmation step for a held booking. */
export function CheckoutPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const online = useOnline();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<CheckoutResult | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setBooking((await api<{ booking: Booking }>(`/api/bookings/${id}`)).booking);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const secondsLeft = useCountdown(booking?.status === 'pending' ? booking.holdExpiresAt : null);
  const expired = booking?.status === 'pending' && (booking.holdExpired || secondsLeft === 0);

  // Final availability check, done on the server, when the player commits to paying.
  const proceed = async () => {
    setBusy(true);
    setActionError(null);
    try {
      setCheckout(await api<CheckoutResult>(`/api/bookings/${id}/checkout`, { method: 'POST' }));
    } catch (err) {
      setActionError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', errorMessage(err)));
      if (err instanceof ApiError && err.status === 409) void load();
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await api(`/api/bookings/${id}/cancel`, { method: 'POST' });
      navigate('/bookings');
    } catch (err) {
      setActionError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', errorMessage(err)));
    } finally {
      setBusy(false);
    }
  };

  const tz = booking?.courtTimezone ?? DEFAULT_TIMEZONE;

  return (
    <>
      <AppHeader />
      <main className="page page--narrow">
        <Link to="/bookings" className="back-link">← Back to calendar</Link>
        <h1>Checkout</h1>

        {!booking && !loadError && <p role="status" className="loading-line">Loading your booking…</p>}
        {loadError && (
          <div className="error-panel" role="alert">
            <p>{loadError}</p>
            <button type="button" className="button-primary" onClick={() => void load()}>Try again</button>
          </div>
        )}

        {booking && (
          <section className="card">
            <dl className="summary">
              <div><dt>Court</dt><dd>{booking.courtName ?? 'Court'}</dd></div>
              <div><dt>Date</dt><dd>{formatDate(todayIn(tz, new Date(booking.startTime)))}</dd></div>
              <div><dt>Time</dt><dd>{formatTimeRange(booking.startTime, booking.endTime, tz)}</dd></div>
              <div><dt>Total</dt><dd className="total">{formatMoney(booking.totalAmount, booking.currency)}</dd></div>
            </dl>

            {booking.status === 'cancelled' && (
              <p className="notice notice--error" role="alert">
                This booking was cancelled. <Link to="/bookings">Choose another slot</Link>.
              </p>
            )}
            {booking.status === 'confirmed' && (
              <p className="notice notice--success" role="status">This booking is paid and confirmed. See you on the court!</p>
            )}
            {booking.status === 'pending' && !expired && secondsLeft !== null && (
              <p className="hold-timer" role="timer" aria-live="off">
                Slot held for you for <strong>{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</strong>
              </p>
            )}
            {expired && (
              <p className="notice notice--error" role="alert">
                Your hold on this slot expired and it was released. <Link to="/bookings">Choose a slot again</Link>.
              </p>
            )}

            {checkout?.state === 'awaiting_payment' ? (
              <div className="notice notice--success" role="status">
                <strong>Your slot is still reserved.</strong> Online payment with PayMongo will be added in the
                payments module. Until then, the court owner can mark the booking as paid.
              </div>
            ) : booking.status === 'pending' && !expired && (
              <div className="checkout-actions">
                <button type="button" className="button-secondary" onClick={cancel} disabled={busy || !online}>
                  Cancel booking
                </button>
                <button type="button" className="button-primary" onClick={proceed} disabled={busy || !online}>
                  {busy ? 'Checking availability…' : `Proceed to payment · ${formatMoney(booking.totalAmount, booking.currency)}`}
                </button>
              </div>
            )}
            {!online && <p className="notice notice--warning" role="status">You're offline. Reconnect to continue.</p>}
            {actionError && (
              <p className="notice notice--error" role="alert">
                {actionError.message}
                {actionError.status === 409 && <> <Link to="/bookings">Back to calendar</Link></>}
              </p>
            )}
          </section>
        )}
      </main>
    </>
  );
}
