# Database Schema

PostgreSQL 14+. The source of truth is the migrations, applied in order:

1. [`001_initial_schema.sql`](../db/migrations/001_initial_schema.sql): tables, relationships, integrity constraints and the no-overlap rule
2. [`002_booking_holds_and_access_control.sql`](../db/migrations/002_booking_holds_and_access_control.sql): booking hold expiry, prices computed by the database, booking status rules, the PayMongo result function and role-based access control
3. [`003_calendar_and_maintenance.sql`](../db/migrations/003_calendar_and_maintenance.sql): court opening hours, maintenance blocks, the 1-hour advance-booking rule, owner rescheduling, calendar availability and live change notifications
4. [`004_booking_workflow.sql`](../db/migrations/004_booking_workflow.sql): status `pending` renamed to `pending_payment`, `hold_expires_at` renamed to `expires_at`, a 3-minute checkout hold (15 minutes since migration 005), and owners blocked from changing bookings during checkout
5. [`005_paymongo_payments.sql`](../db/migrations/005_paymongo_payments.sql): PayMongo payments: booking payment fields, transaction payment details and commission, webhook event log, refunds and the notifications outbox (see [payments.md](payments.md))
6. [`006_email_sms_notifications.sql`](../db/migrations/006_email_sms_notifications.sql): `users.phone`, booking confirmation audit times, and per-channel (email/SMS) notification delivery tracking (see [notifications.md](notifications.md))
7. [`007_owner_dashboard.sql`](../db/migrations/007_owner_dashboard.sql): `owner_daily_metrics()` and `owner_timezone()` for the owner dashboard (see [dashboard.md](dashboard.md))

## Entity relationships

```
users (admin) 1 ──< courts 1 ──< bookings >── 1 users (player)
                                     │
                                     1
                                     │
                                     1
                               transactions

courts 1 ──< court_blocks   (maintenance)
```

| Relationship | Type | Enforced by |
|---|---|---|
| Owner → Courts | One-to-many | `courts.owner_id` FK; composite FK `(owner_id, owner_role) → users(id, role)` makes sure the owner is an `admin` |
| Bookings → Court | Many-to-one | `bookings.court_id` FK |
| Bookings → Player | Many-to-one | `bookings.player_id` FK |
| Booking → Transaction | One-to-one | `transactions.booking_id` FK + `UNIQUE` |
| Court → Maintenance blocks | One-to-many | `court_blocks.court_id` FK (`ON DELETE CASCADE`) |

All foreign keys use `ON DELETE RESTRICT`: a court with bookings, or a booking with a payment, can't be deleted. This keeps the financial history intact. Use `courts.is_active = false` to take a court off the market.

## Tables

### `users`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | `gen_random_uuid()` |
| email | TEXT | Unique without regard to case (`lower(email)` index); basic format check |
| password_hash | TEXT | Hash only (e.g. argon2id or bcrypt), never plaintext |
| phone | TEXT | Optional mobile number in E.164 (`+639171234567`), for SMS confirmations |
| role | `user_role` | `admin` = **Court Owner**, or `player`; default `player`. The spec's "Admin" and "Court Owner" are the same role. |
| created_at / updated_at | TIMESTAMPTZ | `updated_at` maintained by a trigger |

### `courts`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| owner_id | UUID FK → users | Must be an `admin` |
| owner_role | `user_role` | Always `admin`; only exists to support the role-checking FK |
| name | TEXT | Not blank; unique per owner |
| description | TEXT | Optional |
| location | TEXT | Optional |
| hourly_rate | BIGINT | Centavos, ≥ 0 |
| currency | CHAR(3) | Default `PHP` |
| is_active | BOOLEAN | Availability status; default `true` |
| timezone | TEXT | IANA time zone for the court's local schedule; default `Asia/Manila`; validated |
| opens_at / closes_at | TIME | Daily opening hours in `timezone`; default 06:00–22:00 |
| slot_minutes | INTEGER | Calendar slot length: 30, 60, 90 or 120; default 60 |

### `bookings`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| court_id | UUID FK → courts | |
| player_id | UUID FK → users | |
| start_time / end_time | TIMESTAMPTZ | `end_time > start_time` |
| status | `booking_status` | `pending_payment`, `confirmed`, `cancelled`; default `pending_payment` |
| total_amount | BIGINT | Centavos, ≥ 0. **Computed by the database** on insert: `hourly_rate × duration`, rounded. Later rate changes don't affect it |
| currency | CHAR(3) | Copied from the court |
| cancelled_at | TIMESTAMPTZ | Set if and only if `status = 'cancelled'` |
| payment_intent_id | TEXT | PayMongo payment intent (`pi_…`) once checkout starts; unique |
| payment_status | `booking_payment_status` | `unpaid`, `processing`, `paid`, `failed`, `expired`, `refunded` |
| confirmed_at | TIMESTAMPTZ | When the booking became `confirmed` |
| confirmation_email_sent_at / confirmation_sms_sent_at | TIMESTAMPTZ | When the player's confirmation email / SMS was accepted by SendGrid / Twilio |
| expires_at | TIMESTAMPTZ | When an unpaid `pending_payment` booking releases its slot (insert time + 15 min). Required while `pending_payment` |

### `court_blocks` (maintenance)
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| court_id | UUID FK → courts | |
| created_by | UUID FK → users | Set to the signed-in user automatically |
| start_time / end_time | TIMESTAMPTZ | `end_time > start_time`; blocks on the same court can't overlap |
| reason | TEXT | Optional. Shown only to the court owner |

A block can't overlap an active (`pending_payment` or `confirmed`) booking, and a booking can't overlap a block. Expired holds in the way are released first. Both sides take a per-court lock (`lock_court_schedule`), so a booking and a block created at the same moment can't both succeed. Only the court owner can read or change blocks; everyone else sees blocked slots as `maintenance` in `get_availability`.

### `transactions`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| booking_id | UUID FK → bookings | `UNIQUE` (one-to-one) |
| provider_ref_id | TEXT | PayMongo id (`pi_…` / `pay_…`), `UNIQUE`. May be null only while `pending` |
| status | `transaction_status` | `pending`, `processing`, `paid`, `failed`, `refunded` |
| amount | BIGINT | Centavos, > 0. **Copied from the booking's `total_amount`** on insert; same integer format PayMongo uses. Free bookings (rate 0) don't need a transaction |
| currency | CHAR(3) | Default `PHP` |
| processed_at | TIMESTAMPTZ | Set if and only if status is final (`paid`, `failed`, `refunded`) |
| provider | TEXT | `paymongo` |
| checkout_session_id / checkout_url | TEXT | The PayMongo checkout session (`cs_…`) and its hosted page |
| payment_id | TEXT | PayMongo payment (`pay_…`) of the last attempt |
| payment_method | TEXT | `gcash` or `paymaya` |
| provider_fee | BIGINT | PayMongo's fee, centavos |
| commission_rate_bps / platform_fee | INTEGER / BIGINT | Platform commission rate and amount, set when the transaction becomes `paid` |
| owner_net | BIGINT | `amount − provider_fee − platform_fee` |
| failure_code / failure_message | TEXT | Why the last attempt failed |
| refund_id | TEXT | PayMongo refund, when one was issued |
| provider_payload | JSONB | The latest PayMongo object for this payment |

Every webhook event is also stored in `payment_events` (deduplicated by PayMongo event id). Payment details are covered in [payments.md](payments.md).

## Concurrency: no double-bookings

```sql
CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    court_id                              WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
) WHERE (status IN ('pending_payment', 'confirmed'))
```

- The **database** enforces this, not application code, so it holds when requests race. Five concurrent inserts for the same slot result in one booking and four `exclusion_violation` errors.
- The API should catch **SQLSTATE `23P01`** and return **HTTP 409 Conflict**.
- Ranges are half-open (`[start, end)`), so back-to-back slots like 09:00–10:00 and 10:00–11:00 are allowed.
- Requires the `btree_gist` extension, which the migration creates.

### Checkout holds (unpaid `pending_payment` bookings)

A `pending_payment` booking holds its slot until `expires_at`, 15 minutes after it was created. The length comes from `booking_hold_interval()`; replace that function to change it. A hold that has expired is released in two ways:

1. **Automatically, when someone books an overlapping slot.** Before inserting, the database cancels any expired pending booking that overlaps the new one on the same court. A stale hold never blocks a real booking, even if the cleanup job is behind. This was tested with 5 simultaneous requests for a slot held by an expired booking: the hold was released, 1 request got the slot, and 4 were rejected.
2. **In bulk, with `SELECT expire_stale_bookings();`.** The API runs this every 15 seconds (`HOLD_SWEEP_INTERVAL_MS`), so abandoned checkouts become `cancelled` and calendars update. It returns the number of bookings cancelled and is safe to run from several API instances at once.

Read-side, `get_availability` already treats an expired hold as open, so a slot never looks taken past its `expires_at`, even between sweeps.

### Booking status rules

```
pending_payment ──> confirmed ──> cancelled
   └──────────────────────> cancelled
```

`cancelled` is final, and `confirmed` can't go back to `pending_payment`. A trigger enforces this; a disallowed change fails with SQLSTATE `23514` (respond with HTTP 409).

### Advance booking rule (migration 003)

Players must book at least `booking_min_lead_time()` (1 hour) ahead. The row-level security insert policy enforces this, so a booking that is too soon or in the past is rejected with `42501`. The API checks first and returns a clearer `400 TOO_SOON` / `400 SLOT_IN_PAST`.

### Calendar availability (migration 003)

`get_availability(start_date, days, court_id, owned_only)` returns one row per slot for each court the caller can see. Slots are generated from each court's `opens_at`/`closes_at`/`slot_minutes`, in the court's time zone.

| status | Meaning |
|---|---|
| `available` | Open and bookable |
| `booked` | Held or confirmed by someone else |
| `mine` | Held or confirmed by the caller |
| `maintenance` | Covered by a maintenance block |
| `unavailable` | In the past, or inside the 1-hour advance window |

Expired `pending_payment` holds count as open. Booking details (id, status, times, hold expiry) are returned only to the booking's player and the court owner, and the player's email and the block reason only to the owner. Other players see the status and nothing else.

### Owner rescheduling (migration 003)

`reschedule_booking(booking_id, court_id, start, end)` moves an active booking to a new time and/or another court of the same owner. The price stays what was originally charged. Overlaps fail with `23P01`, and moving into the past fails with `23514`.

### Live change notifications (migration 003)

Every insert, update or delete on `bookings` or `court_blocks` runs `pg_notify('picksched_schedule', '{"court_id","start_time","end_time"}')`. The payload contains no personal data. The API listens on this channel and pushes changes to browsers (see [booking-calendar.md](booking-calendar.md)).

### Owners and bookings in checkout (migration 004)

While a booking is `pending_payment` and its hold hasn't expired (`booking_in_checkout(b)`), the player is paying for it. Court owners can view it but can't cancel, confirm or reschedule it. Those calls fail with SQLSTATE `55006` (`object_in_use`), which the API returns as `409 BOOKING_IN_CHECKOUT`. The player can still cancel their own checkout.

An owner can't manually confirm an unpaid booking: once its hold expires, `confirm_booking` fails with `23514`. A booking becomes `confirmed` through `record_payment_result` (PayMongo), and owners can then reschedule or cancel it.

## PayMongo integration notes

- Amounts are integers in centavos, which is what PayMongo's REST API sends and receives. No conversion is needed.
- Payment flow:
  1. The player inserts a booking. The database prices it, and it starts as `pending_payment` with a 15-minute hold.
  2. The player inserts a transaction (`booking_id` only). The database copies the amount from the booking.
  3. The API creates the PayMongo Payment Intent for `amount` and stores its id: `UPDATE transactions SET provider_ref_id = 'pi_…'`.
  4. The webhook handler verifies the PayMongo signature, then calls `SELECT record_payment_result('pi_…', 'paid' | 'failed' | 'processing' | 'refunded')`.
- `record_payment_result` updates the transaction and the booking in one database transaction. It is safe to call repeatedly with the same input:
  - `paid`: the transaction becomes `paid`, and a `pending` booking becomes `confirmed`.
  - `refunded`: the booking becomes `cancelled`.
  - It rejects impossible changes, such as `paid` → `failed` or anything after `refunded`.
  - It returns the booking's resulting status. If you pass `paid` and get back **`cancelled`**, the hold expired and the slot was released before the payment arrived. **The API should issue a refund.**

## Roles and permissions

Permissions are enforced **in the database** with row-level security (RLS), so a bug in the API can't leak or change another user's data.

### How the API connects

- Connect as a login role that is a member of `picksched_app`: `GRANT picksched_app TO picksched_api;`. **Never connect as the table owner or a superuser**, because those bypass RLS.
- At the start of each request's transaction, set the signed-in user:
  ```sql
  SELECT set_config('app.current_user_id', '<user uuid>', true);  -- true = this transaction only
  ```
  With no user set, every table appears empty and writes are refused.

### Permission matrix

| | admin (Court Owner) | player |
|---|---|---|
| **users** | Read own row, plus players who booked their courts. Update own email/password | Read own row. Update own email/password |
| **courts** | Read active courts plus all their own. Full CRUD on their own courts | Read active courts |
| **bookings** | Read bookings on their courts. Cancel them (`cancel_booking`), confirm them manually (`confirm_booking`, e.g. paid in cash) | Read own bookings. Create bookings for themselves on active courts. Cancel own (`cancel_booking`) |
| **court_blocks** (maintenance) | Full CRUD on blocks for their own courts | No direct access; sees `maintenance` slots |
| **transactions** (financial / occupancy reports) | Read transactions for their courts | Read own transactions. Start payment for own pending booking and store the PayMongo id |

### Fields the app can't write

`users.role`, `courts.owner_id`, every `status` column, `total_amount` and `amount` can't be written by the app role directly; column privileges block them. Changes to these go through these functions:

| Function | Who may call it | Purpose |
|---|---|---|
| `register_user(email, password_hash, role)` | Anyone (sign-up) | Create an account; returns its id |
| `find_user_for_login(email)` | Anyone (login) | Return `id, password_hash, role`; the API verifies the password |
| `cancel_booking(id)` | Booking's player or court owner | Cancel; repeated calls have no further effect |
| `confirm_booking(id)` | Court owner | Manual confirmation |
| `reschedule_booking(id, court, start, end)` | Court owner | Move a booking to another time or court |
| `get_availability(date, days, court, owned_only)` | Anyone | Calendar slots with status |
| `record_payment_result(ref, status)` | Webhook handler | Apply a PayMongo result |
| `expire_stale_bookings()` | Scheduler | Release expired holds |

How to map errors to HTTP responses:

| SQLSTATE | Meaning | HTTP |
|---|---|---|
| `P0002` | Not found, or not visible to this user | 404 |
| `42501` | Not permitted | 403 |
| `23P01` | Slot already taken | 409 |
| `23514` | Invalid value or status change | 409 / 422 |
| `23505` | Duplicate (e.g. email) | 409 |

## Running the migrations and tests

```sh
# Apply pending migrations in order (records them in schema_migrations)
DATABASE_URL=postgres://... npm run migrate -w api

# Run every SQL test on a scratch database (uses PGHOST/PGPORT/PGUSER; needs CREATEDB and CREATEROLE)
sh db/run_tests.sh
```
