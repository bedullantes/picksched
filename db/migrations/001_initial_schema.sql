-- =============================================================================
-- PickSched — Migration 001: Initial schema
-- Entities: users, courts, bookings, transactions
-- Target: PostgreSQL 14+
-- =============================================================================
--
-- Money convention: every monetary column is an integer amount in the smallest
-- currency unit (centavos for PHP), matching the PayMongo REST API, which
-- sends and receives `amount` as an integer (e.g. 50000 = PHP 500.00).
-- This avoids floating-point rounding and needs no conversion at the API edge.
--
-- Time convention: all timestamps are TIMESTAMPTZ (stored in UTC).
-- =============================================================================

BEGIN;

-- Needed so the booking overlap constraint can combine equality on court_id
-- (a btree operator) with range overlap on the time slot (a GiST operator).
CREATE EXTENSION IF NOT EXISTS btree_gist;
-- Supplies gen_random_uuid() on PostgreSQL < 13 (built in from 13 onward).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Enumerated types
-- -----------------------------------------------------------------------------

-- RBAC role. 'admin' is the Court Owner role.
CREATE TYPE user_role AS ENUM ('admin', 'player');

CREATE TYPE booking_status AS ENUM ('pending', 'confirmed', 'cancelled');

-- Internal payment lifecycle, mapped from PayMongo payment / payment-intent
-- statuses by the webhook handler:
--   pending    -> intent created, awaiting payment method / customer action
--   processing -> PayMongo "processing"
--   paid       -> PayMongo "succeeded" / payment.paid webhook
--   failed     -> PayMongo payment.failed webhook
--   refunded   -> refund completed
CREATE TYPE transaction_status AS ENUM ('pending', 'processing', 'paid', 'failed', 'refunded');

-- -----------------------------------------------------------------------------
-- Shared trigger: keep updated_at current
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
CREATE TABLE users (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,
    role          user_role   NOT NULL DEFAULT 'player',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT users_email_format_chk CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    -- Target of the composite FK on courts, which guarantees owners are admins.
    CONSTRAINT users_id_role_key UNIQUE (id, role)
);

-- Case-insensitive uniqueness: Foo@x.com and foo@x.com are the same account.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- courts  (one owner -> many courts)
-- -----------------------------------------------------------------------------
CREATE TABLE courts (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    UUID        NOT NULL,
    -- Always 'admin'; exists only so the composite FK below can check the
    -- owner's role declaratively, without application code or triggers.
    owner_role  user_role   NOT NULL DEFAULT 'admin',
    name        TEXT        NOT NULL,
    description TEXT,
    location    TEXT,
    hourly_rate BIGINT      NOT NULL,          -- centavos
    currency    CHAR(3)     NOT NULL DEFAULT 'PHP',
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT courts_owner_fk FOREIGN KEY (owner_id, owner_role)
        REFERENCES users (id, role)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT courts_owner_role_chk  CHECK (owner_role = 'admin'),
    CONSTRAINT courts_name_not_blank  CHECK (btrim(name) <> ''),
    CONSTRAINT courts_hourly_rate_chk CHECK (hourly_rate >= 0),
    -- An owner cannot have two courts with the same name.
    CONSTRAINT courts_owner_name_key  UNIQUE (owner_id, name)
);

CREATE INDEX courts_active_idx ON courts (is_active) WHERE is_active;

CREATE TRIGGER courts_set_updated_at
    BEFORE UPDATE ON courts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- bookings  (many -> one court, many -> one player)
-- -----------------------------------------------------------------------------
CREATE TABLE bookings (
    id           UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    court_id     UUID           NOT NULL REFERENCES courts (id) ON DELETE RESTRICT,
    player_id    UUID           NOT NULL REFERENCES users  (id) ON DELETE RESTRICT,
    start_time   TIMESTAMPTZ    NOT NULL,
    end_time     TIMESTAMPTZ    NOT NULL,
    status       booking_status NOT NULL DEFAULT 'pending',
    total_amount BIGINT         NOT NULL,       -- centavos, snapshot at booking time
    currency     CHAR(3)        NOT NULL DEFAULT 'PHP',
    cancelled_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),

    CONSTRAINT bookings_time_order_chk   CHECK (end_time > start_time),
    CONSTRAINT bookings_total_amount_chk CHECK (total_amount >= 0),
    CONSTRAINT bookings_cancelled_at_chk CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),

    -- Concurrency guarantee: no two active (pending or confirmed) bookings may
    -- overlap on the same court. Enforced by the database, so it holds even
    -- when two requests race; the loser gets SQLSTATE 23P01
    -- (exclusion_violation), which the API should map to HTTP 409 Conflict.
    -- Cancelled bookings release their slot.
    -- Slots are half-open [start, end): a 09:00-10:00 booking does not collide
    -- with a 10:00-11:00 booking.
    CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
        court_id                                WITH =,
        tstzrange(start_time, end_time, '[)')   WITH &&
    ) WHERE (status IN ('pending', 'confirmed'))
);

-- The exclusion constraint's GiST index already serves "court availability in
-- a time window" queries. These cover the other common lookups.
CREATE INDEX bookings_player_start_idx ON bookings (player_id, start_time DESC);
CREATE INDEX bookings_court_start_idx  ON bookings (court_id, start_time);

CREATE TRIGGER bookings_set_updated_at
    BEFORE UPDATE ON bookings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- transactions  (one booking -> one transaction)
-- -----------------------------------------------------------------------------
CREATE TABLE transactions (
    id              UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id      UUID               NOT NULL REFERENCES bookings (id) ON DELETE RESTRICT,
    -- PayMongo object id (e.g. "pi_..." payment intent or "pay_..." payment).
    -- Nullable because the row is created before the PayMongo call returns.
    provider_ref_id TEXT,
    status          transaction_status NOT NULL DEFAULT 'pending',
    amount          BIGINT             NOT NULL,   -- centavos, as sent to PayMongo
    currency        CHAR(3)            NOT NULL DEFAULT 'PHP',
    processed_at    TIMESTAMPTZ,                   -- set when a final status is reached
    created_at      TIMESTAMPTZ        NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ        NOT NULL DEFAULT now(),

    -- One-to-one with bookings.
    CONSTRAINT transactions_booking_key      UNIQUE (booking_id),
    -- Lets webhook handlers look up and upsert by PayMongo id idempotently.
    CONSTRAINT transactions_provider_ref_key UNIQUE (provider_ref_id),
    CONSTRAINT transactions_amount_chk       CHECK (amount > 0),
    CONSTRAINT transactions_processed_at_chk CHECK (
        (status IN ('paid', 'failed', 'refunded')) = (processed_at IS NOT NULL)
    ),
    CONSTRAINT transactions_provider_ref_chk CHECK (
        status = 'pending' OR provider_ref_id IS NOT NULL
    )
);

CREATE INDEX transactions_status_idx ON transactions (status);

CREATE TRIGGER transactions_set_updated_at
    BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
