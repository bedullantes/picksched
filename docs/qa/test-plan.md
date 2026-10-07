# QA test plan

Scope: the end-to-end booking flow, PayMongo payment paths, role-based access,
SMS/email notifications and dashboard accuracy. No schema changes were made
for QA.

Everything below is automated unless marked **manual**. Steps against the real
PayMongo, SendGrid and Twilio sandboxes are in
[manual-test-script.md](manual-test-script.md); the latest results are in
[qa-report.md](qa-report.md).

## How to run

```sh
sh db/run_tests.sh                                                    # SQL: constraints, RLS, functions
TEST_DATABASE_URL=postgres://postgres@localhost/postgres npm test -w api  # API (incl. the permission matrix)
npm test -w web                                                       # components
E2E_ADMIN_DATABASE_URL=postgres://postgres@localhost/postgres npm run test:e2e   # browser end-to-end
```

The end-to-end suite (`e2e/`, Playwright) builds the app, creates a fresh
database (`picksched_e2e_test`) with the demo seed, and starts the
production server together with local PayMongo, SendGrid and Twilio
simulators. They behave like the real services: signed webhooks, hosted
checkout page, authentication, and error responses. It runs on desktop
Chrome, and the booking journey also runs on a phone (Pixel 7). Reports:
`e2e/playwright-report/` (HTML), `e2e/test-results/results.json`, and
`e2e/test-results/dashboard-reconciliation.json`.

Time is never faked in the app. To test the 15-minute expiry, the tests move a
booking's `expires_at` into the past and let the background jobs act on it.

## Business rules under test

| Rule | Where verified |
|---|---|
| Booking status is always accurate: `pending_payment` → `confirmed` (paid) or `cancelled` (expired / released) | QA-01, QA-02, SQL `booking_workflow.sql` |
| A booking is confirmed only by PayMongo's signed webhook (or the API reading PayMongo's own record), never by the client or an owner | QA-02.4, QA-03.9–03.11 |
| Dashboard occupancy equals active (confirmed) bookings per court; revenue equals paid transactions | QA-05 |
| One booking per slot under concurrency | QA-04 |
| Notifications go out only on confirmation; failures never block or undo a booking | QA-06 |

## Test cases

### QA-01 Player booking journey (Search > Select > Payment > Confirmation)

`e2e/tests/booking-journey.spec.ts`, which runs on desktop and on mobile.

| Step | Action | Expected |
|---|---|---|
| 1 | Sign up as a player with a mobile number | Lands on "Book a court" |
| 2 | **Search:** pick a date | Open slots are shown with their price. On a phone, the page doesn't scroll sideways |
| 3 | **Select:** open a slot, then "Reserve & continue" | Checkout page. The booking is `pending_payment` / `unpaid` with `expires_at` set |
| 4 | **Payment:** "Pay ₱…", which redirects to PayMongo | Still `pending_payment`, now with a `pi_…` payment intent |
| 5 | Pay with GCash | Redirect back, then "Payment successful" |
| 6 | Check the database | Booking is `confirmed` / `paid`. The transaction is `paid` via `gcash`, amount = booking total, platform fee = 5%, owner net = amount − fees. One `checkout_session.payment.paid` webhook event is recorded |
| 7 | Back to the calendar | The slot reads "Your booking, Confirmed" |
| 8 | Messages | The player gets an email and an SMS with court, date, time and reference, and the owner gets an alert. All arrive within 2 minutes |

### QA-02 PayMongo success and failure paths

`e2e/tests/payment-paths.spec.ts`

| ID | Scenario | Expected |
|---|---|---|
| 02.1 | Declined payment, then return to the app | "Payment failed", "You haven't been charged". Booking stays `pending_payment` / `failed` with no confirmation sent. "Try again" reuses the same PayMongo session, Maya succeeds, the booking is `confirmed` and still has a single transaction row |
| 02.2 | Leave PayMongo without paying | "Payment not completed" with the remaining hold time. "Release slot" cancels the booking and frees the slot |
| 02.3 | **Interrupted session:** browser closed while on PayMongo | Hold kept (`pending_payment`, `expires_at` in the future). After signing in again, checkout resumes the *same* PayMongo session, and paying confirms the booking |
| 02.4 | **Interrupted after paying:** the redirect back never happens | The webhook alone confirms the booking, and the confirmation is still sent |
| 02.5 | Abandoned: hold reaches 15 minutes | Booking is `cancelled` and the PayMongo session is expired ("This checkout session has expired"). The app shows "slot was released", the slot is bookable by others, and no confirmation is sent |
| 02.6 | Webhook signature, idempotency, late payment and refund, outage | API `payments.test.ts` |

### QA-03 Role-based access control

`e2e/tests/permissions.spec.ts` (browser and HTTP) and
`api/test/permissions.test.ts`. The second is a matrix of every endpoint × anonymous, player, other player, owner and other owner (88 checks).

| ID | Check | Expected |
|---|---|---|
| 03.1 | Signed out: any app page | Redirect to `/login` |
| 03.2 | Signed out: protected APIs | 401 (403 for the owner-only schedule) |
| 03.3 | Signed out: browse courts/slots | Allowed; no emails, booking ids or player data |
| 03.4 | Player: `/dashboard` | Redirect to "You don't have access to this page"; no Dashboard link in the menu |
| 03.5 | Player: `GET /api/dashboard`, facility schedule, maintenance (read/write), confirm, reschedule | 403 `FORBIDDEN` |
| 03.6 | Player: another player's booking (view, pay, cancel, verify) | 404 / 403, nothing changes |
| 03.7 | Player: own notifications and bookings only; calendar hides who booked | As stated |
| 03.8 | Owner: dashboard, full schedule with player emails, maintenance | 200 |
| 03.9 | Owner: confirm / move / cancel a booking in checkout | 409 `BOOKING_IN_CHECKOUT`, unchanged |
| 03.10 | Owner: pay for a player's booking | 403 |
| 03.11 | Owner: move a booking onto a held slot | 409 `SLOT_UNAVAILABLE` |
| 03.12 | Other owner: this facility's bookings, schedule, blocks, analytics | 404 / empty |
| 03.13 | Forged or unsigned PayMongo webhook | 401, booking unchanged |
| 03.14 | Visiting the success URL without paying | Not confirmed |
| 03.15 | App database role, as owner or player: `UPDATE bookings SET status='confirmed'` | Refused by row-level security |

### QA-04 Concurrency

`e2e/tests/concurrency.spec.ts`, plus API `booking-workflow.test.ts` and SQL tests.

| ID | Scenario | Expected |
|---|---|---|
| 04.1 | Two browsers click "Reserve" on the same slot at once | One gets checkout and the other is told the slot was just taken. One active booking |
| 04.2 | 10 simultaneous API reservations | One 201 and nine 409 `SLOT_UNAVAILABLE`. An overlapping range is also refused |

### QA-05 Dashboard accuracy

`e2e/tests/dashboard.spec.ts` and `e2e/tests/reconciliation.spec.ts`, plus API `dashboard.test.ts` and SQL `dashboard.sql`.

| ID | Check | Expected |
|---|---|---|
| 05.1 | Owner has the dashboard open while a player books | An unpaid hold doesn't count. A paid booking updates "Bookings, next 7 days", occupancy ("2 of 224 court-hours") and revenue without a reload |
| 05.2 | Reconciliation (runs last, for every owner): recompute daily booked hours, available hours, bookings, payments, gross and net from the `bookings`, `courts`, `court_blocks` and `transactions` tables with independent SQL, then compare with `GET /api/dashboard` for the last 30 days plus the next 7 | Identical day by day and in total. Every confirmed booking has a paid transaction and vice versa. The result is saved as JSON |

### QA-06 Notifications on booking state change

`e2e/tests/notifications.spec.ts`, plus API `notifications.test.ts`.

| ID | Scenario | Expected |
|---|---|---|
| 06.1 | Reservation held, then expired | No notifications queued or sent |
| 06.2 | Payment confirmed | Exactly: player email + player SMS + owner email, each once, within 2 minutes. Duplicate webhooks don't resend |
| 06.3 | Invalid phone or email entered | 400 (`INVALID_PHONE` / validation error) at sign-up and in Account |
| 06.4 | Phone rejected by Twilio (21211) | SMS `failed` after 1 attempt (not retried). Email sent. Booking stays `confirmed` |
| 06.5 | Email rejected by SendGrid (400) | Emails `failed`. Booking stays `confirmed` |
| 06.6 | SendGrid outage (503), then recovery | Retried with backoff and delivered within 2 minutes. The booking is confirmed throughout |

### QA-07 Responsive layout (regression)

Covered in the previous phase. See [../responsive-design.md](../responsive-design.md). The QA-01 mobile run also checks for horizontal overflow.

## Acceptance criteria → evidence

| Criterion | Evidence |
|---|---|
| End-to-end booking flow completes without errors | QA-01 (desktop + mobile) |
| A PayMongo success updates Bookings | QA-01.6, QA-02.1, QA-02.3, QA-02.4 |
| The dashboard reflects real-time metrics | QA-05.1, QA-05.2 |
| Notifications arrive within 2 minutes | QA-01.8, QA-06.2, QA-06.6 |
| Players are blocked from admin routes | QA-03.4, QA-03.5, API permission matrix |
