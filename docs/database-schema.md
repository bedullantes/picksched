# Database Schema

PostgreSQL 14+. The source of truth is [`db/migrations/001_initial_schema.sql`](../db/migrations/001_initial_schema.sql).

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
| role | `user_role` | `admin` (Court Owner) or `player`; default `player` |
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
| total_amount | BIGINT | Centavos, ≥ 0. A copy of the price when the booking was made, so later rate changes don't affect it |
| currency | CHAR(3) | Default `PHP` |
| cancelled_at | TIMESTAMPTZ | Set if and only if `status = 'cancelled'` |

### `transactions`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| booking_id | UUID FK → bookings | `UNIQUE` (one-to-one) |
| provider_ref_id | TEXT | PayMongo id (`pi_…` / `pay_…`), `UNIQUE`. May be null only while `pending` |
| status | `transaction_status` | `pending`, `processing`, `paid`, `failed`, `refunded` |
| amount | BIGINT | Centavos, > 0. Same integer format PayMongo uses |
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
- A `pending` booking holds its slot. A `cancelled` booking frees it right away.
- Requires the `btree_gist` extension, which the migration creates.

**Follow-up for the API layer:** a `pending` booking whose payment is never finished keeps its slot. A scheduled job should cancel `pending` bookings that are older than the payment window (for example, 15 minutes), using `created_at`.

## PayMongo integration notes

- Amounts are integers in centavos, which is what PayMongo's REST API sends and receives. No conversion is needed.
- Suggested flow:
  1. Insert a `pending` booking, which reserves the slot.
  2. Insert a `pending` transaction.
  3. Create the PayMongo Payment Intent and store its id in `provider_ref_id`.
- Webhooks look up the transaction by `provider_ref_id` (unique, indexed), so repeated deliveries are safe to process again. On `payment.paid`, set the transaction to `paid` with `processed_at` and the booking to `confirmed` in the same DB transaction.

## Roles and permissions

The schema stores the role (`users.role`). The API checks permissions:

| Action | admin (Court Owner) | player |
|---|---|---|
| Courts | Full CRUD on courts where `owner_id = self` | Read active courts |
| Bookings | View and manage bookings on their own courts | Create, view, and cancel bookings where `player_id = self` |
| Transactions / reports | View for their own courts | Start payments for their own bookings |

The database itself guarantees that only `admin` users can own courts. Demoting an admin who still owns courts is rejected.

## Running the migration and tests

```sh
psql -v ON_ERROR_STOP=1 -d picksched -f db/migrations/001_initial_schema.sql
psql -v ON_ERROR_STOP=1 -d picksched -f db/tests/schema_test.sql   # runs in a rolled-back transaction
```
