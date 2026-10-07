# Database Schema

PostgreSQL 14+. The source of truth is the migrations, applied in order:

1. [`001_initial_schema.sql`](../db/migrations/001_initial_schema.sql): tables, relationships, integrity constraints and the no-overlap rule
2. [`002_booking_holds_and_access_control.sql`](../db/migrations/002_booking_holds_and_access_control.sql): booking hold expiry, prices computed by the database, booking status rules, the PayMongo result function and role-based access control

## Entity relationships

```
users (admin) 1 ──< courts 1 ──< bookings >── 1 users (player)
                                     │
                                     1
                                     │
                                     1
                               transactions
```

| Relationship | Type | Enforced by |
|---|---|---|
| Owner → Courts | One-to-many | `courts.owner_id` FK; composite FK `(owner_id, owner_role) → users(id, role)` makes sure the owner is an `admin` |
| Bookings → Court | Many-to-one | `bookings.court_id` FK |
| Bookings → Player | Many-to-one | `bookings.player_id` FK |
| Booking → Transaction | One-to-one | `transactions.booking_id` FK + `UNIQUE` |

All foreign keys use `ON DELETE RESTRICT`: a court with bookings, or a booking with a payment, can't be deleted. This keeps the financial history intact. Use `courts.is_active = false` to take a court off the market.

## Tables

### `users`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | `gen_random_uuid()` |
| email | TEXT | Unique without regard to case (`lower(email)` index); basic format check |
| password_hash | TEXT | Hash only (e.g. argon2id or bcrypt), never plaintext |
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

### `bookings`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| court_id | UUID FK → courts | |
| player_id | UUID FK → users | |
| start_time / end_time | TIMESTAMPTZ | `end_time > start_time` |
| status | `booking_status` | `pending`, `confirmed`, `cancelled`; default `pending` |
| total_amount | BIGINT | Centavos, ≥ 0. **Computed by the database** on insert: `hourly_rate × duration`, rounded. Later rate changes don't affect it |
| currency | CHAR(3) | Copied from the court |
| cancelled_at | TIMESTAMPTZ | Set if and only if `status = 'cancelled'` |
| hold_expires_at | TIMESTAMPTZ | When an unpaid `pending` booking releases its slot (insert time + 15 min). Required while `pending` |

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

## Concurrency: no double-bookings

```sql
CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    court_id                              WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
) WHERE (status IN ('pending', 'confirmed'))
```

- The **database** enforces this, not application code, so it holds when requests race. Five concurrent inserts for the same slot result in one booking and four `exclusion_violation` errors.
- The API should catch **SQLSTATE `23P01`** and return **HTTP 409 Conflict**.
- Ranges are half-open (`[start, end)`), so back-to-back slots like 09:00–10:00 and 10:00–11:00 are allowed.
- Requires the `btree_gist` extension, which the migration creates.

### Booking holds (unpaid pending bookings)

A `pending` booking holds its slot until `hold_expires_at`, 15 minutes after it was created. The length comes from `booking_hold_interval()`; replace that function to change it. A hold that has expired is released in two ways:

1. **Automatically, when someone books an overlapping slot.** Before inserting, the database cancels any expired pending booking that overlaps the new one on the same court. A stale hold never blocks a real booking, even if the cleanup job is behind. This was tested with 5 simultaneous requests for a slot held by an expired booking: the hold was released, 1 request got the slot, and 4 were rejected.
2. **In bulk, with `SELECT expire_stale_bookings();`.** Schedule it, for example every minute with pg_cron or the API's job runner, so availability listings never show expired holds. It returns the number of bookings cancelled and is safe to run repeatedly.

### Booking status rules

```
pending ──> confirmed ──> cancelled
   └──────────────────────> cancelled
```

`cancelled` is final, and `confirmed` can't go back to `pending`. A trigger enforces this; a disallowed change fails with SQLSTATE `23514` (respond with HTTP 409).

## PayMongo integration notes

- Amounts are integers in centavos, which is what PayMongo's REST API sends and receives. No conversion is needed.
- Payment flow:
  1. The player inserts a booking. The database prices it, and it starts as `pending` with a 15-minute hold.
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
| **transactions** (financial / occupancy reports) | Read transactions for their courts | Read own transactions. Start payment for own pending booking and store the PayMongo id |

### Fields the app can't write

`users.role`, `courts.owner_id`, every `status` column, `total_amount` and `amount` can't be written by the app role directly; column privileges block them. Changes to these go through these functions:

| Function | Who may call it | Purpose |
|---|---|---|
| `register_user(email, password_hash, role)` | Anyone (sign-up) | Create an account; returns its id |
| `find_user_for_login(email)` | Anyone (login) | Return `id, password_hash, role`; the API verifies the password |
| `cancel_booking(id)` | Booking's player or court owner | Cancel; repeated calls have no further effect |
| `confirm_booking(id)` | Court owner | Manual confirmation |
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
# Apply migrations in order
for f in db/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -d picksched -f "$f"; done

# Run every test on a scratch database (uses PGHOST/PGPORT/PGUSER; needs CREATEDB and CREATEROLE)
sh db/run_tests.sh
```
