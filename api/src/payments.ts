import type { Request } from 'express';
import { asUser, type Deps } from './context.js';
import { withUser, type Tx } from './db.js';
import { ApiError } from './errors.js';
import {
  parseCheckoutSession, parsePayment, PayMongoError, type CheckoutSession, type PayMongoPayment,
} from './paymongo.js';

/*
 * Payment flow (see docs/payments.md):
 *   1. startCheckout: the player opens a PayMongo checkout session for their
 *      pending_payment booking and is redirected to PayMongo (GCash / Maya).
 *   2. PayMongo calls the webhook; handleWebhookEvent applies the result.
 *      Only a successful payment confirms the booking.
 *   3. When the player returns, syncFromPayMongo can fetch the session
 *      directly in case the webhook hasn't arrived yet.
 *   4. A background job expires checkout sessions for released bookings and
 *      refunds payments that can't be honored.
 */

export const PROVIDER_UNAVAILABLE = 'Online payment is temporarily unavailable. Your slot is still held. Please try again in a moment.';

function providerError(err: unknown): ApiError {
  if (err instanceof PayMongoError) {
    console.error(err.message);
    if (err.kind === 'timeout') {
      return new ApiError(504, 'PAYMENT_PROVIDER_TIMEOUT',
        'PayMongo is taking too long to respond. Your slot is still held. Please try again.');
    }
    return new ApiError(502, 'PAYMENT_PROVIDER_ERROR',
      "We couldn't reach PayMongo to start your payment. Your slot is still held. Please try again.");
  }
  return err as ApiError;
}

function requirePayments(deps: Deps) {
  if (!deps.paymongo || !deps.config.paymongo) {
    throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', PROVIDER_UNAVAILABLE);
  }
  return { client: deps.paymongo, cfg: deps.config.paymongo };
}

/**
 * Opens (or reuses) the PayMongo checkout session for a booking and returns
 * its URL. Runs in one database transaction holding the transaction row lock,
 * so concurrent clicks share a single session.
 */
export async function startCheckout(deps: Deps, req: Request, bookingId: string) {
  const { client, cfg } = requirePayments(deps);
  try {
    return await asUser(deps, req, async (tx) => {
      const t = (await tx.query('SELECT * FROM begin_payment($1)', [bookingId])).rows[0];
      if (t.checkout_session_id && t.checkout_url) {
        return { checkoutUrl: t.checkout_url as string, checkoutSessionId: t.checkout_session_id as string, reused: true };
      }
      const info = (await tx.query(
        `SELECT c.name AS court_name, b.total_amount, b.currency,
                to_char(b.start_time AT TIME ZONE c.timezone, 'Dy Mon DD, HH12:MI AM') || ' – ' ||
                to_char(b.end_time AT TIME ZONE c.timezone, 'HH12:MI AM') AS label
         FROM bookings b JOIN courts c ON c.id = b.court_id WHERE b.id = $1`, [bookingId])).rows[0];
      const session = await client.createCheckoutSession({
        amount: Number(t.amount),
        currency: t.currency,
        name: `${info.court_name} · ${info.label}`,
        description: `PickSched court booking ${bookingId}`,
        referenceNumber: bookingId,
        successUrl: `${cfg.appBaseUrl}/bookings/${bookingId}/payment?result=success`,
        cancelUrl: `${cfg.appBaseUrl}/bookings/${bookingId}/payment?result=cancelled`,
        methods: cfg.methods,
        metadata: { booking_id: bookingId, transaction_id: t.id },
      });
      await tx.query('SELECT attach_checkout_session($1, $2, $3, $4, $5)',
        [bookingId, session.id, session.paymentIntentId, session.checkoutUrl, JSON.stringify(session.raw)]);
      return { checkoutUrl: session.checkoutUrl, checkoutSessionId: session.id, reused: false };
    });
  } catch (err) {
    throw providerError(err);
  }
}

interface ApplyArgs {
  intentId: string;
  status: 'paid' | 'failed' | 'processing' | 'refunded';
  payment?: PayMongoPayment;
  payload?: unknown;
}

interface ApplyOutcome {
  transactionId: string;
  bookingId: string;
  bookingStatus: string;
  transactionStatus: string;
  refundNeeded: boolean;
  paymentId: string | null;
  amount: number;
}

async function applyResult(tx: Tx, a: ApplyArgs): Promise<ApplyOutcome> {
  const p = a.payment;
  const r = (await tx.query(
    `SELECT * FROM apply_payment_result($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [a.intentId, a.status, p?.id ?? null, p?.method ?? null, p?.amount ?? null, p?.fee ?? null,
      p?.failedCode ?? null, p?.failedMessage ?? null, a.payload ? JSON.stringify(a.payload) : null])).rows[0];
  return {
    transactionId: r.transaction_id,
    bookingId: r.booking_id,
    bookingStatus: r.booking_status,
    transactionStatus: r.transaction_status,
    refundNeeded: r.refund_needed,
    paymentId: r.payment_id,
    amount: Number(r.amount),
  };
}

/** The result a checkout session represents: a successful payment wins over failed attempts. */
function sessionResult(session: CheckoutSession): ApplyArgs | null {
  const paid = session.payments.find((p) => p.status === 'paid');
  if (paid) return { intentId: session.paymentIntentId, status: 'paid', payment: paid, payload: session.raw };
  const failed = session.payments.filter((p) => p.status === 'failed').at(-1);
  if (failed) return { intentId: session.paymentIntentId, status: 'failed', payment: failed, payload: failed.raw };
  return null;
}

/** Translates a PayMongo event into a payment result, or null if we don't act on it. */
function eventResult(type: string, resource: any): ApplyArgs | null {
  switch (type) {
    case 'checkout_session.payment.paid':
      return sessionResult(parseCheckoutSession(resource));
    case 'payment.paid':
    case 'payment.failed':
    case 'payment.refunded': {
      const payment = parsePayment(resource);
      if (!payment.paymentIntentId) return null;
      const status = type === 'payment.paid' ? 'paid' : type === 'payment.failed' ? 'failed' : 'refunded';
      return { intentId: payment.paymentIntentId, status, payment, payload: resource };
    }
    default:
      return null;
  }
}

export interface WebhookEvent {
  id: string;
  type: string;
  livemode: boolean;
  resource: unknown;
  raw: unknown;
}

/**
 * Records a verified webhook event and applies it, in one database
 * transaction: if applying fails, nothing is recorded and PayMongo's retry is
 * processed again. Redelivered events are acknowledged without reprocessing.
 */
export async function handleWebhookEvent(deps: Deps, event: WebhookEvent): Promise<string> {
  const run = (fn: (tx: Tx) => Promise<string>) => withUser(deps.db, null, deps.config.dbStatementTimeoutMs, fn);
  const args = eventResult(event.type, event.resource);
  let outcome: ApplyOutcome | undefined;
  let result: string;
  try {
    result = await run(async (tx) => {
      const fresh = (await tx.query('SELECT record_payment_event($1, $2, $3, $4) AS fresh',
        [event.id, event.type, event.livemode, JSON.stringify(event.raw)])).rows[0].fresh;
      if (!fresh) return 'duplicate';
      if (!args) {
        await tx.query('SELECT finish_payment_event($1, NULL, $2)', [event.id, 'ignored']);
        return 'ignored';
      }
      outcome = await applyResult(tx, args);
      const r = `booking ${outcome.bookingStatus}, payment ${outcome.transactionStatus}${outcome.refundNeeded ? ', refund due' : ''}`;
      await tx.query('SELECT finish_payment_event($1, $2, $3)', [event.id, outcome.transactionId, r]);
      return r;
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P0002') throw err;
    // Not one of our payment intents (e.g. another integration on the same account).
    result = await run(async (tx) => {
      const fresh = (await tx.query('SELECT record_payment_event($1, $2, $3, $4) AS fresh',
        [event.id, event.type, event.livemode, JSON.stringify(event.raw)])).rows[0].fresh;
      if (fresh) await tx.query('SELECT finish_payment_event($1, NULL, $2)', [event.id, 'unknown payment intent']);
      return 'unknown payment intent';
    });
  }
  if (outcome?.refundNeeded) await refundOne(deps, outcome.bookingId, args!.intentId, outcome.paymentId, outcome.amount);
  // Send the confirmation email/SMS now, in the background. Never awaited: a
  // notification problem must not affect the webhook response or the booking.
  if (outcome) deps.notifier?.kick();
  return result;
}

/**
 * Asks PayMongo for the booking's checkout session and applies its result.
 * Used when the player returns from checkout before the webhook arrives. The
 * data comes straight from PayMongo's API, so it can't be spoofed.
 */
export async function syncFromPayMongo(deps: Deps, req: Request, bookingId: string): Promise<void> {
  const { client } = requirePayments(deps);
  const t = await asUser(deps, req, async (tx) =>
    (await tx.query('SELECT checkout_session_id, status FROM transactions WHERE booking_id = $1', [bookingId])).rows[0]);
  if (!t?.checkout_session_id || t.status === 'paid' || t.status === 'refunded') return;
  let session: CheckoutSession;
  try {
    session = await client.retrieveCheckoutSession(t.checkout_session_id);
  } catch (err) {
    throw providerError(err);
  }
  const args = sessionResult(session);
  if (!args) return;
  const outcome = await withUser(deps.db, null, deps.config.dbStatementTimeoutMs, (tx) => applyResult(tx, args));
  if (outcome.refundNeeded) await refundOne(deps, outcome.bookingId, args.intentId, outcome.paymentId, outcome.amount);
  deps.notifier?.kick();
}

async function refundOne(deps: Deps, bookingId: string, intentId: string, paymentId: string | null, amount: number) {
  if (!deps.paymongo || !paymentId) return;
  try {
    const refund = await deps.paymongo.createRefund({
      paymentId,
      amount,
      notes: `PickSched booking ${bookingId}: payment received after the booking hold expired or for the wrong amount.`,
    });
    await withUser(deps.db, null, deps.config.dbStatementTimeoutMs, (tx) =>
      tx.query('SELECT mark_refunded($1, $2, $3)', [intentId, refund.id, JSON.stringify(refund.raw)]));
    console.log(`Refunded payment ${paymentId} for booking ${bookingId}`);
  } catch (err) {
    // Left in refunds_due(); the payment job retries.
    console.error(`Refund for booking ${bookingId} failed:`, (err as Error).message);
  }
}

/** Background work: close PayMongo sessions for released bookings, retry due refunds. */
export async function runPaymentMaintenance(deps: Deps): Promise<{ expired: number; refunded: number }> {
  if (!deps.paymongo) return { expired: 0, refunded: 0 };
  const run = <T>(fn: (tx: Tx) => Promise<T>) => withUser(deps.db, null, deps.config.dbStatementTimeoutMs, fn);
  let expired = 0;
  const sessions = await run(async (tx) => (await tx.query('SELECT * FROM checkout_sessions_to_expire()')).rows);
  for (const s of sessions) {
    try {
      await deps.paymongo.expireCheckoutSession(s.checkout_session_id);
    } catch (err) {
      // 4xx: already expired or completed at PayMongo; anything else: retry next run.
      if (!(err instanceof PayMongoError && err.kind === 'api' && (err.status ?? 500) < 500)) continue;
    }
    await run((tx) => tx.query('SELECT mark_checkout_expired($1)', [s.transaction_id]));
    expired++;
  }
  const due = await run(async (tx) => (await tx.query(
    `SELECT r.*, t.booking_id FROM refunds_due() r JOIN transactions t ON t.provider_ref_id = r.payment_intent_id`)).rows);
  for (const r of due) await refundOne(deps, r.booking_id, r.payment_intent_id, r.payment_id, Number(r.amount));
  return { expired, refunded: due.length };
}
