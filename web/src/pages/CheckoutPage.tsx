import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api/client';
import type { Booking, CheckoutResult } from '../api/types';
import { AppHeader } from '../components/AppHeader';
import { DEFAULT_TIMEZONE, formatDate, formatMoney, formatTimeRange, todayIn } from '../lib/format';
import { METHOD_LABELS, redirectTo } from '../lib/navigation';
import { mmss, useCountdown } from '../lib/useCountdown';
import { useOnline } from '../lib/useOnline';

/**
 * Payment step for a held booking. "Pay" asks the API to re-validate the hold
 * and open a PayMongo checkout session, then sends the player to PayMongo's
 * hosted page to pay with GCash or Maya. PayMongo returns them to
 * /bookings/:id/payment.
 */
export function CheckoutPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const online = useOnline();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  /** 'processing' while waiting for the API; 'redirecting' once we're leaving for PayMongo. */
  const [phase, setPhase] = useState<'idle' | 'processing' | 'redirecting'>('idle');

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

  const secondsLeft = useCountdown(booking?.status === 'pending_payment' ? booking.expiresAt : null);
  const expired = booking?.status === 'pending_payment' && (booking.holdExpired || secondsLeft === 0);

  const pay = async () => {
    setPhase('processing');
    setActionError(null);
    try {
      const res = await api<CheckoutResult>(`/api/bookings/${id}/checkout`, { method: 'POST', timeoutMs: 30_000 });
      if (res.state === 'confirmed' || !res.payment.checkoutUrl) {
        setPhase('idle');
        void load();
        return;
      }
      setPhase('redirecting');
      redirectTo(res.payment.checkoutUrl);
    } catch (err) {
      setPhase('idle');
      setActionError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', errorMessage(err)));
      if (err instanceof ApiError && err.status === 409) void load();
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
            {booking.status === 'pending_payment' && !expired && secondsLeft !== null && (
              <p className="hold-timer" role="timer" aria-live="off">
                Slot held for you for <strong>{mmss(secondsLeft)}</strong>
              </p>
            )}
            {expired && (
              <p className="notice notice--error" role="alert">
                Your hold on this slot expired and it was released. <Link to="/bookings">Choose a slot again</Link>.
              </p>
            )}

            {booking.status === 'pending_payment' && !expired && booking.payment?.status === 'failed' && phase === 'idle' && (
              <p className="notice notice--error" role="alert">
                Your last payment attempt didn't go through
                {booking.payment.failureMessage ? `: ${booking.payment.failureMessage}` : '.'} You can try again.
              </p>
            )}

            {booking.status === 'pending_payment' && !expired && (
              phase !== 'idle' ? (
                <div className="processing" role="status" aria-live="polite">
                  <span className="spinner" aria-hidden="true" />
                  <div>
                    <strong>Processing payment…</strong>
                    <p>{phase === 'redirecting'
                      ? 'Taking you to PayMongo to pay securely.'
                      : 'Connecting to PayMongo. This takes a few seconds.'}</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="pay-methods" aria-label="Payment methods">
                    <span>Pay with</span>
                    <span className="method-badge method-badge--gcash">GCash</span>
                    <span className="method-badge method-badge--paymaya">Maya</span>
                  </div>
                  <div className="checkout-actions">
                    <button type="button" className="button-secondary" onClick={cancel} disabled={busy || !online}>
                      Cancel booking
                    </button>
                    <button type="button" className="button-primary" onClick={pay} disabled={busy || !online}>
                      Pay {formatMoney(booking.totalAmount, booking.currency)}
                    </button>
                  </div>
                  <p className="hint">
                    You'll be taken to PayMongo's secure checkout to pay with {Object.values(METHOD_LABELS).join(' or ')}.
                    Your booking is confirmed as soon as PayMongo confirms the payment.
                  </p>
                </>
              )
            )}
            {!online && <p className="notice notice--warning" role="status">You're offline. Reconnect to continue.</p>}
            {/* An expired or cancelled booking already has its own notice above. */}
            {actionError && !expired && booking.status !== 'cancelled' && (
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
