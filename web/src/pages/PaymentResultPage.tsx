import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import type { Booking } from '../api/types';
import { AppHeader } from '../components/AppHeader';
import { useAuth } from '../auth/AuthContext';
import { DEFAULT_TIMEZONE, formatDate, formatMoney, formatTime, formatTimeRange, todayIn } from '../lib/format';
import { METHOD_LABELS } from '../lib/navigation';
import { mmss, useCountdown } from '../lib/useCountdown';

const POLL_MS = 2000;
/** When to ask the API to check PayMongo directly, in case the webhook is slow. */
const VERIFY_AFTER_MS = [0, 5000, 15000, 30000];
const GIVE_UP_MS = 60_000;

type Outcome = 'processing' | 'delayed' | 'success' | 'failed' | 'cancelled' | 'released' | 'refunded';

function outcomeOf(b: Booking, returnedVia: string | null, waitedMs: number): Outcome {
  if (b.status === 'confirmed') return 'success';
  if (b.status === 'cancelled') return b.paymentStatus === 'refunded' || b.paymentStatus === 'paid' ? 'refunded' : 'released';
  if (b.paymentStatus === 'failed') return 'failed';
  if (returnedVia === 'cancelled') return 'cancelled';
  return waitedMs >= GIVE_UP_MS ? 'delayed' : 'processing';
}

/**
 * Where PayMongo sends the player back (?result=success|cancelled). The
 * booking is confirmed by PayMongo's webhook, so this page waits for that,
 * and also asks the API to check PayMongo directly.
 */
export function PaymentResultPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const returnedVia = params.get('result');
  const navigate = useNavigate();
  const { user } = useAuth();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(Date.now());
  const [waited, setWaited] = useState(0);

  const load = useCallback(async (verify: boolean) => {
    try {
      const res = verify
        ? await api<{ booking: Booking }>(`/api/bookings/${id}/payment/verify`, { method: 'POST' })
        : await api<{ booking: Booking }>(`/api/bookings/${id}`);
      setBooking(res.booking);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);

  const outcome = booking ? outcomeOf(booking, returnedVia, waited) : null;
  const waiting = !booking || outcome === 'processing' || outcome === 'delayed';

  // Poll while waiting; ask PayMongo directly at a few points.
  useEffect(() => {
    if (!waiting) return;
    const poll = setInterval(() => {
      setWaited(Date.now() - started.current);
      void load(false);
    }, POLL_MS);
    const verifies = VERIFY_AFTER_MS.map((ms) => setTimeout(() => void load(true), ms));
    return () => {
      clearInterval(poll);
      verifies.forEach(clearTimeout);
    };
  }, [waiting, load]);

  const secondsLeft = useCountdown(booking?.status === 'pending_payment' ? booking.expiresAt : null);
  const tz = booking?.courtTimezone ?? DEFAULT_TIMEZONE;

  const release = async () => {
    setBusy(true);
    try {
      await api(`/api/bookings/${id}/cancel`, { method: 'POST' });
      navigate('/bookings');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const summary = booking && (
    <dl className="summary">
      <div><dt>Court</dt><dd>{booking.courtName ?? 'Court'}</dd></div>
      <div><dt>Date</dt><dd>{formatDate(todayIn(tz, new Date(booking.startTime)))}</dd></div>
      <div><dt>Time</dt><dd>{formatTimeRange(booking.startTime, booking.endTime, tz)}</dd></div>
      <div><dt>Amount</dt><dd>{formatMoney(booking.totalAmount, booking.currency)}</dd></div>
      {booking.payment?.method && (
        <div>
          <dt>{booking.payment.status === 'paid' ? 'Paid with' : 'Payment method'}</dt>
          <dd>{METHOD_LABELS[booking.payment.method]}</dd>
        </div>
      )}
    </dl>
  );

  const retryActions = (
    <div className="checkout-actions">
      <button type="button" className="button-secondary" onClick={release} disabled={busy}>Release slot</button>
      <Link className="button-primary button-link" to={`/bookings/${id}/checkout`}>Try again</Link>
    </div>
  );
  const holdNote = secondsLeft !== null && secondsLeft > 0 && (
    <p className="hint">Your slot is held for another {mmss(secondsLeft)}.</p>
  );

  return (
    <>
      <AppHeader />
      <main className="page page--narrow">
        {!booking && !error && (
          <section className="result-card" role="status" aria-live="polite">
            <span className="spinner spinner--large" aria-hidden="true" />
            <h1>Processing payment</h1>
            <p>Checking your payment with PayMongo…</p>
          </section>
        )}
        {!booking && error && (
          <div className="error-panel" role="alert">
            <p>{error}</p>
            <button type="button" className="button-primary" onClick={() => void load(true)}>Try again</button>
          </div>
        )}

        {booking && outcome === 'processing' && (
          <section className="result-card" role="status" aria-live="polite">
            <span className="spinner spinner--large" aria-hidden="true" />
            <h1>Processing payment</h1>
            <p>We're confirming your payment with PayMongo. This usually takes a few seconds. Please keep this page open.</p>
            {summary}
          </section>
        )}

        {booking && outcome === 'delayed' && (
          <section className="result-card" role="status">
            <span className="result-icon result-icon--wait" aria-hidden="true">…</span>
            <h1>Still confirming your payment</h1>
            <p>
              PayMongo is taking longer than usual. <strong>Please don't pay again.</strong> Your booking will update
              automatically, and we'll notify you once the payment is confirmed.
            </p>
            {summary}
            <div className="checkout-actions">
              <Link className="button-secondary button-link" to="/bookings">Back to calendar</Link>
              <button type="button" className="button-primary" onClick={() => void load(true)}>Check again</button>
            </div>
          </section>
        )}

        {booking && outcome === 'success' && (
          <section className="result-card result-card--success" role="status">
            <span className="result-icon result-icon--success" aria-hidden="true">✓</span>
            <h1>Payment successful</h1>
            <p>Your booking is confirmed. We're sending a confirmation to {user?.email ?? 'your email'}{user?.phone ? ' and by SMS' : ''}.</p>
            {summary}
            <div className="checkout-actions">
              <Link className="button-primary button-link" to="/bookings">Back to calendar</Link>
            </div>
          </section>
        )}

        {booking && outcome === 'failed' && (
          <section className="result-card result-card--failed" role="alert">
            <span className="result-icon result-icon--failed" aria-hidden="true">✕</span>
            <h1>Payment failed</h1>
            <p>
              {booking.payment?.failureMessage ?? "Your payment didn't go through."} You haven't been charged.
            </p>
            {summary}
            {holdNote}
            {retryActions}
          </section>
        )}

        {booking && outcome === 'cancelled' && (
          <section className="result-card" role="status">
            <span className="result-icon result-icon--wait" aria-hidden="true">!</span>
            <h1>Payment not completed</h1>
            <p>You left PayMongo before paying, so you haven't been charged.</p>
            {summary}
            {holdNote}
            {retryActions}
          </section>
        )}

        {booking && outcome === 'released' && (
          <section className="result-card result-card--failed" role="alert">
            <span className="result-icon result-icon--failed" aria-hidden="true">✕</span>
            <h1>Payment not completed</h1>
            <p>
              The payment wasn't completed in time
              {booking.expiresAt ? ` (by ${formatTime(booking.expiresAt, tz)})` : ''}, so the slot was released.
              You haven't been charged.
            </p>
            <div className="checkout-actions">
              <Link className="button-primary button-link" to="/bookings">Choose another slot</Link>
            </div>
          </section>
        )}

        {booking && outcome === 'refunded' && (
          <section className="result-card result-card--failed" role="alert">
            <span className="result-icon result-icon--failed" aria-hidden="true">↺</span>
            <h1>Payment refunded</h1>
            <p>
              Your payment arrived after your hold on this slot expired, so the booking couldn't be confirmed.
              We've refunded {formatMoney(booking.totalAmount, booking.currency)}. Refunds can take a few business days.
            </p>
            <div className="checkout-actions">
              <Link className="button-primary button-link" to="/bookings">Choose another slot</Link>
            </div>
          </section>
        )}

        {booking && error && <p className="notice notice--warning" role="status">{error}</p>}
      </main>
    </>
  );
}
