# PickSched

A SaaS pickleball court booking system for independent court owners.

## Project layout

- `db/migrations/`: PostgreSQL schema migrations, applied in numeric order
- `db/tests/`: SQL tests for constraints, access control and the calendar functions (run with `sh db/run_tests.sh`)
- `api/`: Node.js + Express + TypeScript REST API (auth, availability, bookings, maintenance, live updates)
- `web/`: React + Vite + TypeScript frontend (booking calendar, checkout)
- `docs/database-schema.md`: data model, relationships, and constraint reference
- `docs/booking-calendar.md`: calendar module behavior, API reference and error handling

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

## Tests

```sh
sh db/run_tests.sh                                     # SQL tests (PGHOST/PGPORT/PGUSER)
TEST_DATABASE_URL=postgres://postgres@localhost/postgres npm test -w api   # API tests against a real database
npm test -w web                                        # component tests
npm run typecheck
```

Unpaid reservations (`pending_payment`) hold their slot for 3 minutes. The API cancels expired ones automatically every 15 seconds; expired holds are also released immediately when someone books over them.
