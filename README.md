# PickSched

A SaaS pickleball court booking system for independent court owners.

## Project layout

- `db/migrations/`: PostgreSQL schema migrations, applied in numeric order
- `db/tests/`: SQL tests for constraints, access control and the calendar functions (run with `sh db/run_tests.sh`)
- `api/`: Node.js + Express + TypeScript REST API (auth, availability, bookings, maintenance, live updates)
- `web/`: React + Vite + TypeScript frontend (booking calendar, checkout)
- `docs/database-schema.md`: data model, relationships, and constraint reference
- `docs/booking-calendar.md`: calendar module behavior, API reference and error handling
- `docs/payments.md`: PayMongo (GCash / Maya) payments, webhooks and commission
- `docs/notifications.md`: booking confirmation email (SendGrid) and SMS (Twilio)
- `docs/dashboard.md`: owner dashboard: bookings, occupancy and revenue
- `docs/responsive-design.md`: breakpoints, touch targets and mobile layout rules

## Running locally

Requires Node.js 20+ and PostgreSQL 14+.

```sh
npm install

# 1. Database (the user needs to create extensions and roles)
export DATABASE_URL=postgres://postgres@localhost:5432/picksched
createdb picksched
npm run migrate -w api
npm run seed:demo -w api   # optional demo data; all demo passwords are "pickleball123"
                           # owner@demo.test, player@demo.test, player2@demo.test

# 2. API (http://localhost:3000)
export SESSION_SECRET=$(openssl rand -hex 32)
npm run dev:api

# 3. Web (http://localhost:5173, proxies /api to the API)
npm run dev:web
```

To try payments without PayMongo keys, run the local PayMongo simulator (`npm run dev:paymongo -w api`) and start the API with `PAYMONGO_SECRET_KEY=sk_test_local PAYMONGO_WEBHOOK_SECRET=whsk_local PAYMONGO_API_BASE=http://localhost:4010/v1 APP_BASE_URL=http://localhost:5173`. See [docs/payments.md](docs/payments.md).

For production, run `npm run build`, then start the API with `WEB_DIST=web/dist node api/dist/server.js`. It serves the web app from the same origin.

### Environment variables (API)

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | (required) | PostgreSQL connection string |
| `SESSION_SECRET` | (required) | At least 32 characters; signs session cookies |
| `PORT` | `3000` | |
| `COOKIE_SECURE` | `true` when `NODE_ENV=production` | Send cookies only over HTTPS |
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
npm run typecheck
```

Unpaid reservations (`pending_payment`) hold their slot for 15 minutes. The API cancels expired ones automatically every 15 seconds; expired holds are also released immediately when someone books over them.
