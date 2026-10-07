-- =============================================================================
-- PickSched — Migration 007: Owner dashboard analytics
-- Depends on: 001–006
-- =============================================================================
--
-- owner_daily_metrics(start, end): one row per day for the calling owner's
-- courts. Occupancy, booking counts and revenue all come from the existing
-- courts, bookings, court_blocks and transactions tables.
--
-- It runs with the caller's privileges (SECURITY INVOKER), so row-level
-- security still applies, and it also filters explicitly to courts the
-- caller owns. Non-owners get 42501.
--
-- Definitions (days are calendar days in each court's time zone):
--   available_minutes  opening hours of the owner's active courts that day,
--                      minus maintenance blocks; days before a court was
--                      added don't count
--   booked_minutes     confirmed bookings on those courts, within opening hours
--   bookings           confirmed bookings starting that day (all owner courts)
--   gross/fees/net     transactions with status 'paid', by the local date the
--                      payment was processed; refunded or failed don't count
-- =============================================================================

BEGIN;

-- The time zone the owner's dashboard uses: the one most of their courts use.
CREATE FUNCTION owner_timezone() RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT timezone FROM courts WHERE owner_id = app_current_user_id()
         GROUP BY timezone ORDER BY count(*) DESC, timezone LIMIT 1),
        'Asia/Manila')
$$;

CREATE FUNCTION owner_daily_metrics(p_start DATE, p_end DATE)
RETURNS TABLE (
    day               DATE,
    active_courts     INTEGER,
    available_minutes BIGINT,
    booked_minutes    BIGINT,
    bookings          INTEGER,
    payments          INTEGER,
    gross             BIGINT,
    provider_fees     BIGINT,
    platform_fees     BIGINT,
    owner_net         BIGINT
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = app_current_user_id() AND u.role = 'admin') THEN
        RAISE EXCEPTION 'only court owners can view facility analytics' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
        RAISE EXCEPTION 'end date must not be before start date' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_end - p_start > 366 THEN
        RAISE EXCEPTION 'date range is limited to 367 days' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    RETURN QUERY
    WITH my_courts AS (
        SELECT c.* FROM courts c WHERE c.owner_id = app_current_user_id()
    ),
    days AS (
        SELECT d::date AS day FROM generate_series(p_start, p_end, interval '1 day') d
    ),
    court_days AS (  -- each active court's opening window on each day
        SELECT d.day, c.id AS court_id,
               (d.day + c.opens_at) AT TIME ZONE c.timezone AS open_at,
               (d.day + c.closes_at) AT TIME ZONE c.timezone AS close_at
        FROM days d
        JOIN my_courts c ON c.is_active AND (c.created_at AT TIME ZONE c.timezone)::date <= d.day
    ),
    capacity AS (
        SELECT cd.day,
               count(*)::int AS courts,
               sum(extract(epoch FROM cd.close_at - cd.open_at) / 60
                   - COALESCE(blk.minutes, 0))::bigint AS minutes,
               COALESCE(sum(bkd.minutes), 0)::bigint AS booked
        FROM court_days cd
        LEFT JOIN LATERAL (
            SELECT sum(extract(epoch FROM least(cb.end_time, cd.close_at) - greatest(cb.start_time, cd.open_at)) / 60) AS minutes
            FROM court_blocks cb
            WHERE cb.court_id = cd.court_id AND cb.start_time < cd.close_at AND cb.end_time > cd.open_at
        ) blk ON TRUE
        LEFT JOIN LATERAL (
            SELECT sum(extract(epoch FROM least(b.end_time, cd.close_at) - greatest(b.start_time, cd.open_at)) / 60) AS minutes
            FROM bookings b
            WHERE b.court_id = cd.court_id AND b.status = 'confirmed'
              AND b.start_time < cd.close_at AND b.end_time > cd.open_at
        ) bkd ON TRUE
        GROUP BY cd.day
    ),
    booking_counts AS (
        SELECT (b.start_time AT TIME ZONE c.timezone)::date AS day, count(*)::int AS n
        FROM bookings b JOIN my_courts c ON c.id = b.court_id
        WHERE b.status = 'confirmed'
          AND b.start_time >= (p_start::timestamp AT TIME ZONE c.timezone) - interval '1 day'
          AND b.start_time <  ((p_end + 1)::timestamp AT TIME ZONE c.timezone) + interval '1 day'
        GROUP BY 1
    ),
    revenue AS (
        SELECT (t.processed_at AT TIME ZONE c.timezone)::date AS day,
               count(*)::int AS n,
               sum(t.amount)::bigint AS gross,
               sum(COALESCE(t.provider_fee, 0))::bigint AS provider_fees,
               sum(COALESCE(t.platform_fee, 0))::bigint AS platform_fees,
               sum(COALESCE(t.owner_net, t.amount))::bigint AS owner_net
        FROM transactions t
        JOIN bookings b ON b.id = t.booking_id
        JOIN my_courts c ON c.id = b.court_id
        WHERE t.status = 'paid'
          AND t.processed_at >= (p_start::timestamp AT TIME ZONE c.timezone) - interval '1 day'
          AND t.processed_at <  ((p_end + 1)::timestamp AT TIME ZONE c.timezone) + interval '1 day'
        GROUP BY 1
    )
    SELECT d.day,
           COALESCE(cap.courts, 0),
           COALESCE(cap.minutes, 0),
           COALESCE(cap.booked, 0),
           COALESCE(bc.n, 0),
           COALESCE(r.n, 0),
           COALESCE(r.gross, 0),
           COALESCE(r.provider_fees, 0),
           COALESCE(r.platform_fees, 0),
           COALESCE(r.owner_net, 0)
    FROM days d
    LEFT JOIN capacity cap ON cap.day = d.day
    LEFT JOIN booking_counts bc ON bc.day = d.day
    LEFT JOIN revenue r ON r.day = d.day
    ORDER BY d.day;
END
$$;

REVOKE EXECUTE ON FUNCTION owner_daily_metrics(DATE, DATE), owner_timezone() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION owner_daily_metrics(DATE, DATE), owner_timezone() TO picksched_app;

COMMIT;
