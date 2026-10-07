# Payments (PayMongo: GCash and Maya)

Players pay for a reservation upfront on PayMongo's hosted checkout. A booking is confirmed only when PayMongo reports a successful payment.

```
Calendar ─ Reserve ─> booking: pending_payment, payment_status unpaid, expires in 15 min
Checkout ─ Pay ────> POST /api/bookings/:id/checkout
                       └─ PayMongo POST /v1/checkout_sessions (gcash, paymaya)
                     <─ checkoutUrl            payment_status: processing
Browser ───────────> PayMongo checkout page (GCash / Maya)
PayMongo ─ webhook ─> POST /api/webhooks/paymongo (signature verified)
                       └─ paid:   transaction paid + fees, booking confirmed, notifications queued
                       └─ failed: booking stays pending_payment (player may retry)
PayMongo ─ redirect ─> /bookings/:id/payment?result=success|cancelled  ("Processing payment" → result)
```

## Setup

1. In the PayMongo dashboard, get the **secret key** (`sk_test_…` for test mode).
2. Create a webhook pointing at `https://<your-domain>/api/webhooks/paymongo` for these events:
   - `checkout_session.payment.paid`
   - `payment.paid`
   - `payment.failed`
   - `payment.refunded`

   Copy its **signing secret** (`whsk_…`).
3. Set the API environment variables:

   ```sh
   PAYMONGO_SECRET_KEY=sk_test_...
   PAYMONGO_WEBHOOK_SECRET=whsk_...
   APP_BASE_URL=https://your-domain        # PayMongo sends players back here
   # optional: PAYMONGO_PAYMENT_METHODS=gcash,paymaya  PAYMONGO_TIMEOUT_MS=10000
   ```

Live keys (`sk_live_…`) switch to live mode, which also changes which webhook signature is checked. Without `PAYMONGO_SECRET_KEY`, reservations still work, but checkout returns `503 PAYMENTS_UNAVAILABLE`.

### Local development without PayMongo keys

`npm run dev:paymongo -w api` starts a **PayMongo simulator** on port 4010. It covers the checkout session, expire and refund APIs, serves a hosted checkout page with *Pay with GCash*, *Pay with Maya* and *Simulate a declined payment* buttons, and sends signed webhooks. Start the API with:

```sh
PAYMONGO_SECRET_KEY=sk_test_local PAYMONGO_WEBHOOK_SECRET=whsk_local \
PAYMONGO_API_BASE=http://localhost:4010/v1 APP_BASE_URL=http://localhost:5173 npm run dev:api
```

The API tests use the same simulator (`api/test/fake-paymongo.ts`). It follows PayMongo's documented request and response shapes, but it isn't PayMongo: **run one real test-mode payment** with your keys before going live.

## Rules

| Rule | How it's enforced |
|---|---|
| Only players pay, and only for their own bookings | `begin_payment()` checks the caller's id and `player` role; the API returns 403 otherwise |
| Admins can't bypass payment | `confirm_booking()` refuses `pending_payment` bookings; bookings can't be updated directly; only a payment result confirms a booking |
| Pending until PayMongo confirms | Only `apply_payment_result(..., 'paid')`, called from a verified webhook or a direct PayMongo lookup, moves a booking to `confirmed` |
| 15-minute payment window | `booking_hold_interval()` = 15 min. Expired bookings are cancelled (`payment_status = 'expired'`) and their PayMongo checkout session is expired, so the player can't pay for a released slot |
| Failed or abandoned payments never confirm | A failed payment keeps `pending_payment` (the player can retry in the same session until the hold ends). An abandoned one expires |
| Late payment (after the hold expired) | Not confirmed. Refunded automatically through PayMongo, and the player is notified |
| Wrong amount | Not confirmed; refunded |
| One checkout session per booking | `begin_payment()` locks the transaction row, so repeated or simultaneous clicks reuse the session |
| Every transaction is logged | `transactions` row per booking, plus every webhook in `payment_events` |

## Webhook security

`POST /api/webhooks/paymongo` checks the following before processing anything:

1. **Signature.** The `Paymongo-Signature` header (`t=…,te=…,li=…`) must contain HMAC-SHA256(signing secret, `"<t>.<raw body>"`). The `te` value is checked in test mode and `li` in live mode, using a constant-time comparison. A wrong or missing signature, or a modified body, gets **401**.
2. **Freshness.** The timestamp must be within 5 minutes, so an old signed request can't be replayed (**401**).
3. **Mode.** The event's `livemode` must match the configured keys (**400**).
4. **Deduplication.** The event id is recorded in `payment_events` in the same database transaction that applies it. PayMongo's retries are acknowledged as `duplicate`, and a failed application rolls back so the retry is processed.

Events for payment intents the app doesn't know are acknowledged and logged as `unknown payment intent`.

**Fallback if the webhook is late:** the result page calls `POST /api/bookings/:id/payment/verify`, which fetches the checkout session from PayMongo with the secret key and applies its result. This data comes straight from PayMongo, so it can't be spoofed by the browser.

## What's recorded

**`bookings`:**

| Column | Values |
|---|---|
| `payment_intent_id` | PayMongo payment intent id |
| `payment_status` | `unpaid`, `processing`, `paid`, `failed`, `expired` or `refunded` |

**`transactions`** (one per booking):

| Column | Meaning |
|---|---|
| `checkout_session_id`, `checkout_url` | The PayMongo checkout session |
| `provider_ref_id` | PayMongo payment intent id |
| `payment_id` | PayMongo payment id of the last attempt |
| `payment_method` | `gcash` or `paymaya` |
| `amount` | Amount charged |
| `provider_fee` | PayMongo's fee |
| `commission_rate_bps` | Commission rate applied |
| `platform_fee` | Platform commission |
| `owner_net` | What the owner receives |
| `failure_code`, `failure_message` | Why the last attempt failed |
| `refund_id` | PayMongo refund, if one was issued |
| `provider_payload` | The latest PayMongo object |

**`payment_events`:** every verified webhook (raw payload, type, result).

### Platform commission

The commission is calculated **when the transaction becomes `paid`**, by the `transactions_compute_fees` trigger, so it applies on every path that records a payment:

```
platform_fee = round(amount × platform_commission_bps() / 10000)    -- default 500 bps = 5%
owner_net    = amount − provider_fee − platform_fee
```

Each row stores the rate it was charged at, so changing the rate later doesn't alter past transactions. To change the rate, replace `platform_commission_bps()`. **Assumptions to confirm:**
- The rate is 5%.
- The court owner absorbs PayMongo's fee.

## Notifications

Confirming a booking queues a confirmation for the player and an alert for the court owner, by email (SendGrid) and SMS (Twilio). A refund queues an email to the player. See [notifications.md](notifications.md).

## Errors players can see

| Situation | Response | Screen |
|---|---|---|
| PayMongo slow (> 10 s) | 504 `PAYMENT_PROVIDER_TIMEOUT` | "PayMongo is taking too long to respond. Your slot is still held. Please try again." |
| PayMongo error or outage | 502 `PAYMENT_PROVIDER_ERROR` | "We couldn't reach PayMongo… Your slot is still held." |
| Payments not configured | 503 `PAYMENTS_UNAVAILABLE` | "Online payment is temporarily unavailable…" |
| Waiting for confirmation | — | **Processing payment** (polls, and checks PayMongo directly) |
| Paid | — | **Payment successful** |
| Declined | — | **Payment failed**, with PayMongo's reason, *Try again* and the remaining hold time |
| Left PayMongo without paying | — | **Payment not completed**; can retry while held |
| Hold ran out | — | **Payment not completed**: slot released, not charged |
| Paid too late | — | **Payment refunded** |
| No confirmation after 60 s | — | "Still confirming your payment… **Please don't pay again.**" |

## Not included yet

- Refunds when an owner cancels a booking that was already paid. That's a policy decision; `refunds_due()` deliberately excludes it.
- Payouts to court owners (`owner_net` is recorded for reporting).
