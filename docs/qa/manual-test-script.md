# Manual test script (staging, real provider sandboxes)

The automated suites use local simulators for PayMongo, SendGrid and Twilio.
Run this script before a release, against a staging deployment that uses the
real providers in **test mode**. It covers what the simulators can't: the
providers' own pages, real webhook delivery over the internet, and real email
and SMS delivery.

Record the result of each step (Pass/Fail, time, notes) in a copy of the table
at the end.

## Setup

| Item | Value |
|---|---|
| Deployment | Staging URL over HTTPS (PayMongo needs a public webhook URL) |
| PayMongo | `PAYMONGO_SECRET_KEY=sk_test_…`, and a webhook registered for `checkout_session.payment.paid`, `payment.paid`, `payment.failed`, `payment.refunded` → `https://<staging>/api/webhooks/paymongo`, with `PAYMONGO_WEBHOOK_SECRET=whsk_…` (see [../payments.md](../payments.md)) |
| SendGrid | `SENDGRID_API_KEY`, verified sender `SENDGRID_FROM_EMAIL`; `SENDGRID_SANDBOX_MODE` **unset** (so mail is delivered) |
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, and `TWILIO_STATUS_CALLBACK_URL=https://<staging>/api/webhooks/twilio/status`. A trial account only texts verified numbers, so verify the tester's phone first |
| Data | `npm run seed:demo -w api` (owner@demo.test / player@demo.test, password `pickleball123`) |
| Devices | A desktop browser, and a phone (iOS Safari or Android Chrome) on mobile data |
| Database access | Read-only `psql` to staging, for the checks marked **DB** |

## M-1 Player journey (do it once on desktop, once on the phone)

| # | Step | Expected |
|---|---|---|
| 1 | Create an account as a player with your real email and verified mobile number | You land on "Book a court" |
| 2 | **Search:** choose a date 2–3 days ahead | Slots show "Available" with a price. On the phone, nothing scrolls sideways and every button is easy to tap |
| 3 | **Select:** tap a free slot, then "Reserve & continue" | Checkout page with court, date, time, amount and a 15-minute hold countdown |
| 4 | **DB** `SELECT status, payment_status, expires_at FROM bookings WHERE id = '<id from URL>'` | `pending_payment`, `unpaid`, `expires_at` ≈ now + 15 min |
| 5 | **Payment:** choose "Pay ₱…" | Redirects to PayMongo's checkout page (paymongo.com), test mode, with the correct amount |
| 6 | Choose GCash and authorize the test payment | Redirects back. "Processing payment" may show briefly, then "Payment successful" |
| 7 | **DB** booking and `transactions` row | `confirmed` / `paid`. Transaction `paid`, method `gcash`, `amount` = booking total, `platform_fee` = 5%, `provider_fee` filled in, `owner_net` = amount − fees. `payment_events` has a `checkout_session.payment.paid` row |
| 8 | **Confirmation:** check your inbox and phone | Email "Booking confirmed: <court>" and an SMS with court, date, time and `PS-…` reference, both within **2 minutes** of step 6 (note the times) |
| 9 | As owner@demo.test (use an inbox you control for the owner, or check the logs) | "New paid booking" alert |
| 10 | Back to the calendar | The slot shows "Your booking" |

## M-2 Payment failure paths

| # | Step | Expected |
|---|---|---|
| 1 | Reserve a slot, pay with Maya, and **fail** the test payment on PayMongo's page | PayMongo shows the failure. Returning to the app shows "Payment failed" and "You haven't been charged" |
| 2 | "Try again", then pay with Maya successfully | "Payment successful". **DB**: one transaction row, `paymaya` |
| 3 | Reserve a slot, start paying, then **close the browser** on PayMongo's page. Reopen the app within 15 minutes and go to the booking (calendar → your slot → "Continue to payment") | Hold still active. Paying finishes the booking |
| 4 | Reserve a slot, start paying, then close the tab and wait **15 minutes** | **DB**: `cancelled`. PayMongo's page for that session says it has expired. The slot is available again. No confirmation email or SMS |
| 5 | Reserve, open PayMongo, and choose to go back without paying | "Payment not completed". "Release slot" frees the slot |

## M-3 Access control

| # | Step | Expected |
|---|---|---|
| 1 | As a player, open `/dashboard` | "You don't have access to this page" |
| 2 | As a player, call `GET /api/dashboard` from the browser console (`fetch('/api/dashboard').then(r => r.status)`) | `403` |
| 3 | As the owner, open the dashboard | Figures load; the owner sees player emails on the schedule |
| 4 | As the owner, try to change a booking while its player is on PayMongo | "The player is paying for this booking right now…" |
| 5 | Send `POST /api/webhooks/paymongo` with a made-up signature (e.g. `curl -H 'Paymongo-Signature: t=1,te=abc,li=' -d '{}'`) | `401`, and the server log shows "Rejected PayMongo webhook" |

## M-4 Notifications

| # | Step | Expected |
|---|---|---|
| 1 | In Account, enter `12345` as the mobile number | "Enter a valid mobile number…" error. Nothing saved |
| 2 | Set a well-formed number that can't receive SMS (on a Twilio trial: any unverified number), then book and pay | Booking confirmed and email delivered. **DB** `notifications`: the SMS row is `failed` with Twilio's error code |
| 3 | With `TWILIO_STATUS_CALLBACK_URL` set, book and pay with a verified number | The SMS row becomes `delivered` within a few minutes |

## M-5 Dashboard vs. transaction log

After M-1 and M-2, as the owner:

1. Note "Bookings, next 7 days", "Occupancy, next 7 days" (booked / available hours) and "Revenue" for "Last 7 days".
2. **DB**: run the queries below (replace the owner email and dates) and compare.

```sql
-- Confirmed (occupied) hours and bookings per day on the owner's courts
SELECT (b.start_time AT TIME ZONE c.timezone)::date AS day,
       count(*) AS bookings,
       sum(extract(epoch FROM b.end_time - b.start_time) / 3600) AS booked_hours
FROM bookings b JOIN courts c ON c.id = b.court_id JOIN users u ON u.id = c.owner_id
WHERE u.email = 'owner@demo.test' AND b.status = 'confirmed'
  AND (b.start_time AT TIME ZONE c.timezone)::date BETWEEN :'start' AND :'end'
GROUP BY 1 ORDER BY 1;

-- Revenue: paid transactions by the local date they were processed
SELECT (t.processed_at AT TIME ZONE c.timezone)::date AS day, count(*) AS payments,
       sum(t.amount) / 100.0 AS gross_php, sum(t.owner_net) / 100.0 AS net_php
FROM transactions t JOIN bookings b ON b.id = t.booking_id JOIN courts c ON c.id = b.court_id
JOIN users u ON u.id = c.owner_id
WHERE u.email = 'owner@demo.test' AND t.status = 'paid'
  AND (t.processed_at AT TIME ZONE c.timezone)::date BETWEEN :'start' AND :'end'
GROUP BY 1 ORDER BY 1;

-- Integrity: both counts must be 0
SELECT count(*) FILTER (WHERE b.status = 'confirmed' AND t.status IS DISTINCT FROM 'paid') AS confirmed_without_payment,
       count(*) FILTER (WHERE t.status = 'paid' AND b.status <> 'confirmed') AS paid_without_confirmation
FROM bookings b LEFT JOIN transactions t ON t.booking_id = b.id;
```

Available hours = active courts × opening hours (16 by default) × days, minus
maintenance blocks.

## Results sheet

| Step | Pass/Fail | Time / value observed | Notes |
|---|---|---|---|
| M-1.1 … M-5 | | | |
