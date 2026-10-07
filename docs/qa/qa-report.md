# QA report: booking flow, payments, access control, notifications, dashboard

**Date:** 2026-10-07 · **Build:** branch `claude/pickleball-db-schema-o8bzff` · **Plan:** [test-plan.md](test-plan.md)

## Summary

All acceptance criteria pass in the automated suites. QA found one data defect
and fixed it (demo seed). Two design gaps are logged below as open findings and
were not changed in this phase. Real PayMongo, SendGrid and Twilio were not
reachable from the test environment, so those integrations were exercised
against faithful local simulators. The staging checks in
[manual-test-script.md](manual-test-script.md) remain to be run before release.

| Acceptance criterion | Result | Evidence |
|---|---|---|
| End-to-end booking flow completes without errors | **Pass** | QA-01 on desktop and mobile |
| A PayMongo success updates Bookings | **Pass** | QA-01, QA-02.1, 02.3, 02.4: `confirmed`/`paid`, transaction `paid`, webhook recorded |
| The dashboard reflects real-time metrics | **Pass** | QA-05.1 updates without reload. QA-05.2 reconciles exactly |
| Notifications arrive within 2 minutes | **Pass** | Typically about 1 s after payment. The outage-and-retry case took about 16 s (QA-06.6) |
| Players are blocked from admin routes | **Pass** | QA-03 (UI and API), 88-check API permission matrix |

## Execution results

| Suite | Command | Result |
|---|---|---|
| SQL (constraints, RLS, functions) | `sh db/run_tests.sh` | 198 checks passed |
| API, incl. the new permission matrix | `npm test -w api` | 204 passed (6 files) |
| Web components | `npm test -w web` | 49 passed |
| Browser end-to-end (Playwright, Chromium) | `npm run test:e2e` | 35 passed, run twice in a row with no flaky tests (about 1.3 min per run) |

End-to-end breakdown (`e2e/tests/`):

| Spec | Tests | Covers |
|---|---|---|
| `booking-journey.spec.ts` | 2 (desktop and mobile) | QA-01 |
| `payment-paths.spec.ts` | 5 | QA-02: declined → retry, cancelled, interrupted (before and after paying), abandoned/expired |
| `permissions.spec.ts` | 18 | QA-03 |
| `concurrency.spec.ts` | 2 | QA-04 |
| `dashboard.spec.ts` | 1 | QA-05.1 real-time |
| `reconciliation.spec.ts` | 1 | QA-05.2, runs after all other specs |
| `notifications.spec.ts` | 6 | QA-06 |

## Edge cases

| Edge case | Outcome |
|---|---|
| Concurrent double-booking (2 browsers, and 10 parallel API calls) | Exactly one reservation. The others get 409 `SLOT_UNAVAILABLE`, and the browser shows "This slot was just taken by someone else". Enforced by the database exclusion constraint, so it holds regardless of the app server |
| Invalid phone or email | Rejected when entered (400). A well-formed but undeliverable number (Twilio 21211) fails only the SMS, which is not retried. The email is still delivered and the booking stays confirmed. A SendGrid rejection marks emails failed, and the booking is unaffected |
| Provider outage | SendGrid 503 is retried with backoff (15 s, 30 s, …). Delivered after recovery, within 2 minutes |
| Browser closed during the PayMongo redirect, before paying | The hold survives for up to 15 minutes. After signing in again, checkout reuses the same PayMongo session, and paying confirms the booking |
| Browser closed after paying, with no redirect back | The signed webhook alone confirms the booking and sends the confirmation. Nothing depends on the player returning |
| Payment never completed | After 15 minutes the booking is `cancelled`, the PayMongo session is expired, the slot is reopened, and no confirmation is sent |

## Dashboard occupancy vs. transaction logs

`reconciliation.spec.ts` recomputes each owner's figures directly from the
`bookings`, `courts`, `court_blocks` and `transactions` tables. It doesn't use
the app's SQL. It then compares them with `GET /api/dashboard` day by day for
37 days (the last 30 and the next 7). Results from the latest run (also saved
to `e2e/test-results/dashboard-reconciliation.json`):

| Owner | Days compared | Booked hours (dashboard / independent) | Available hours | Paid payments | Gross revenue | Confirmed without payment | Paid without confirmation |
|---|---|---|---|---|---|---|---|
| owner@demo.test (seed and all QA bookings) | 37 | 15 / 15 | 510 / 510 | 14 / 14 | ₱5,400.00 / ₱5,400.00 | 0 | 0 |
| QA owner (2 courts created for QA-05.1) | 37 | 3 / 3 | 1,184 / 1,184 | 2 / 2 | ₱1,500.00 / ₱1,500.00 | 0 | 0 |

Every daily row matched exactly: bookings, booked hours, available hours,
payments, gross and net. Occupancy counts only confirmed bookings. Holds that
are pending, expired or released are not counted (QA-05.1 checks this live).

## Defects found

| ID | Severity | Description | Status |
|---|---|---|---|
| D-1 | Medium (demo/staging data) | The demo seed (`api/scripts/seed-demo.ts`) inserted confirmed bookings with no payment transaction. On a seeded environment the dashboard showed occupancy with ₱0 revenue, which breaks the rule that a confirmed booking is a paid one. The real booking path was never affected: only a verified PayMongo payment confirms a booking. Found by the QA-05.2 integrity check | **Fixed.** The seed now records a paid GCash transaction, with 5% commission, for each confirmed demo booking. It is idempotent, and the reconciliation passes on the seeded data |

No defects were found in the booking, payment, access-control or notification
logic.

## Open findings (not changed in this phase)

| ID | Type | Finding | Recommendation |
|---|---|---|---|
| F-1 | Gap | There is no **reservation history** list for players. A player's bookings appear on the calendar ("Your booking") and individually at `GET /api/bookings/:id`, but there is no "My bookings" page or list endpoint for past and upcoming bookings | Add `GET /api/bookings?mine=1` (it can use the existing RLS) and a "My bookings" page |
| F-2 | Design | Owner accounts can call `POST /api/bookings` and create a 15-minute hold they can never pay for: checkout is players-only, and the existing test `payments.test.ts` expects this. Nothing is confirmed, so the booking rules hold, but an owner could tie up a slot for 15 minutes. The owner UI doesn't offer it; owners use maintenance blocks | Decide whether owners should book for walk-in customers (then add a cash/manual payment flow) or reject `POST /api/bookings` for owners |
| F-3 | Gap | There is no court management screen or API. Courts are created in the database (QA did this with SQL) | Add an owner "Courts" screen when needed |

## Residual risks

- **Real providers not exercised.** PayMongo's hosted pages, real webhook
  delivery, SendGrid and Twilio were simulated, using the same request
  formats, authentication, signatures and error codes. Run the
  [manual test script](manual-test-script.md) on staging with test keys
  before going live.
- **The 2-minute delivery target** depends on provider latency and on
  `NOTIFICATIONS_INTERVAL_MS` (default 5 s) for retries. In production, watch
  `notifications` rows stuck in `pending`.
- **Time-based expiry** was tested by moving `expires_at`, not by waiting 15
  real minutes. The background jobs ran as they do in production.
- **Browsers:** the end-to-end tests ran on Chromium (desktop, and Pixel 7
  emulation). Safari/WebKit was checked only in the earlier responsive pass,
  so include an iPhone in the manual run.
