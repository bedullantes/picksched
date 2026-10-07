# PickSched

A SaaS pickleball court booking system for independent court owners.

## Project layout

- `db/migrations/`: PostgreSQL schema migrations, applied in numeric order
- `db/tests/`: SQL tests for constraints, access control and the calendar functions (run with `sh db/run_tests.sh`)
- `api/`: Node.js + Express + TypeScript REST API (auth, availability, bookings, maintenance, live updates)
- `web/`: React + Vite + TypeScript frontend (booking calendar, checkout)
- `e2e/`: Playwright end-to-end tests against the built app and local provider simulators
- `docs/database-schema.md`: data model, relationships, and constraint reference
- `docs/booking-calendar.md`: calendar module behavior, API reference and error handling
- `docs/payments.md`: PayMongo (GCash / Maya) payments, webhooks and commission
- `docs/notifications.md`: booking confirmation email (SendGrid) and SMS (Twilio)
- `docs/dashboard.md`: owner dashboard: bookings, occupancy and revenue
- `docs/qa/`: QA test plan, manual staging script and the latest QA report
- `docs/deployment.md`: environments, secrets, security headers, database TLS, logging and the launch checklist
- `docs/responsive-design.md`: breakpoints, touch targets and mobile layout rules

## Running locally

Requires Node.js 20+ and PostgreSQL 14+.

```sh
npm install

# 1. Database (the user needs to create extensions and roles)
createdb picksched
npm run migrate -w api
npm run seed:demo -w api   # optional demo data; all demo passwords are "pickleball123"
                           # owner@demo.test, player@demo.test, player2@demo.test

# 2. Local PayMongo, SendGrid and Twilio simulators (optional; payments need the first)
npm run dev:paymongo -w api      # http://localhost:4010
npm run dev:messaging -w api     # http://localhost:4020/_sent lists sent email/SMS

# 3. API (http://localhost:3000)
npm run dev:api

# 4. Web (http://localhost:5173, proxies /api to the API)
npm run dev:web
```

In development the API reads `api/.env.development` (committed, no secrets: local database and simulator settings) and, if present, `api/.env.local` (git-ignored: your own `SESSION_SECRET` and provider **test** keys). Variables set in the shell override both. Without a `SESSION_SECRET` a temporary one is generated, which signs everyone out on restart. See [docs/payments.md](docs/payments.md) and [docs/notifications.md](docs/notifications.md) for the simulators.

**Staging and production** never read `.env` files. Configuration and secrets are injected by the platform's secret store, and the server refuses to start unless that environment's rules are met (live PayMongo keys only in production, TLS to the database, secure cookies, HSTS, and so on). Run `npm run preflight -w api` before launch. See **[docs/deployment.md](docs/deployment.md)**.

### Environment variables (API)

| Variable | Default | |
|---|---|---|
| `APP_ENV` | `production` if `NODE_ENV=production`, else `development` | `development`, `staging` or `production`; selects config sources and rules ([deployment](docs/deployment.md)) |
| `DATABASE_URL` | (required) | PostgreSQL connection string (secret) |
| `DATABASE_SSL` | `disable` in development, `verify-full` otherwise | `disable`, `require` or `verify-full` (TLS with certificate check) |
| `DATABASE_CA_CERT` / `DATABASE_CA_CERT_FILE` | (system CAs) | CA for `verify-full` with a private CA |
| `DB_POOL_MAX`, `DB_POOL_MIN`, `DB_IDLE_TIMEOUT_MS`, `DB_CONNECTION_TIMEOUT_MS`, `DB_MAX_LIFETIME_SECONDS` | `20`, `0`, `30000`, `5000`, `1800` (`0` in dev) | Connection pool |
| `MIGRATION_DATABASE_URL` | `DATABASE_URL` | Separate privileged account for `npm run migrate` |
| `SESSION_SECRET` | (required; temporary in dev) | At least 32 characters; signs session cookies |
| `PORT` | `3000` | |
| `COOKIE_SECURE` | `true` outside development | Send cookies only over HTTPS |
| `TRUST_PROXY` | `1` outside development | Proxies in front of the app (client IP, HTTPS detection) |
| `HSTS`, `HSTS_MAX_AGE_SECONDS` | on outside development, 2 years | Strict-Transport-Security |
| `HTTPS_REDIRECT` | on outside development | Redirect HTTP to `APP_BASE_URL` |
| `CSP_REPORT_URI` | (none) | Collector for Content-Security-Policy violation reports |
| `LOG_LEVEL`, `LOG_FORMAT`, `ACCESS_LOG` | `info`, `json` outside development (`pretty` in dev), `true` | Logging |
| `ERROR_WEBHOOK_URL` | (none) | Receives a JSON POST per server error (alerting) |
| `DB_STATEMENT_TIMEOUT_MS` | `5000` | Per-request query timeout |
| `BCRYPT_ROUNDS` | `12` | Password hashing cost |
| `MAX_BOOKING_HOURS` | `4` | Longest single booking |
| `HOLD_SWEEP_INTERVAL_MS` | `15000` | How often unpaid holds past `expires_at` are cancelled |
| `WEB_DIST` | (none) | Path to the built web app to serve |
| `PAYMONGO_SECRET_KEY` | (none) | PayMongo secret key (`sk_test_…` / `sk_live_…`). Payments are disabled without it |
| `PAYMONGO_WEBHOOK_SECRET` | (required with a key) | Signing secret of the PayMongo webhook (`whsk_…`) |
| `APP_BASE_URL` | (required with a key) | Public URL of the web app; PayMongo returns players here |
| `PAYMONGO_PAYMENT_METHODS` | `gcash,paymaya` | Methods offered at checkout |
| `PAYMONGO_API_BASE` | `https://api.paymongo.com/v1` | Override for the local simulator |
| `PAYMONGO_TIMEOUT_MS` | `10000` | PayMongo API timeout |
| `PAYMENT_JOB_INTERVAL_MS` | `60000` | How often expired checkouts are closed and due refunds retried |
| `NOTIFICATIONS_TRANSPORT` | `log` | Fallback when no provider is set: `log`, or `webhook` to POST each notification to `NOTIFICATIONS_WEBHOOK_URL` |
| `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` | (none) | Booking confirmation emails via SendGrid |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM_NUMBER` | (none) | Booking confirmation SMS via Twilio. More options in [docs/notifications.md](docs/notifications.md) |

## Tests

```sh
sh db/run_tests.sh                                     # SQL tests (PGHOST/PGPORT/PGUSER)
TEST_DATABASE_URL=postgres://postgres@localhost/postgres npm test -w api   # API tests against a real database
npm test -w web                                        # component tests
E2E_ADMIN_DATABASE_URL=postgres://postgres@localhost/postgres npm run test:e2e   # browser end-to-end (Playwright)
npm run typecheck
npm run check:secrets                                  # fails if anything secret-looking is committed
```

The end-to-end suite builds the app, creates a fresh `picksched_e2e_test` database and runs the full booking, payment, permission, notification and dashboard scenarios against local PayMongo/SendGrid/Twilio simulators. See [docs/qa/test-plan.md](docs/qa/test-plan.md), the latest [QA report](docs/qa/qa-report.md), and the [manual test script](docs/qa/manual-test-script.md) for staging with real provider sandboxes.

Unpaid reservations (`pending_payment`) hold their slot for 15 minutes. The API cancels expired ones automatically every 15 seconds; expired holds are also released immediately when someone books over them.
