-- Scheduling data v2 + no-double-booking constraint (PR-07).
--
-- Reuses the 048/052 scheduler (bookings, scheduling_*); no parallel shop_*
-- tables. Expand-only: adds columns, tables, constraints and policies. It
-- never drops, renames or narrows an existing column, and never deletes
-- bookings. The only write to existing booking rows is the backfill of the
-- NEW column blocked_until (= end_time); no existing column value changes.
--
-- The overlap pre-check below runs before any DDL. If existing held/confirmed
-- bookings already overlap for the same provider (or the same resource), the
-- migration aborts with the offending rows listed. Fix the data by hand, then
-- re-run. scripts/run-migrations.ts wraps each file in a transaction, so an
-- abort leaves nothing behind.
--
-- RLS on the new tables is enabled AND forced with the fail-closed policy
-- shape from 121_action_layer.sql.

-- ---------------------------------------------------------------------------
-- 1. Pre-check: refuse to add the exclusion constraints over existing overlaps
-- ---------------------------------------------------------------------------
-- Uses end_time (blocked_until does not exist yet and is backfilled to
-- end_time). On a re-run after 122 is applied, the constraints already
-- guarantee there are no end_time overlaps, so this stays a no-op.
DO $$
DECLARE
  overlap_count INTEGER;
  invalid_count INTEGER;
  details TEXT;
BEGIN
  -- tstzrange(start_time, end_time) raises on start > end, so report those
  -- rows first instead of failing with a bare range error.
  SELECT COUNT(*),
         array_to_string((array_agg(
           format('  booking %s (tenant %s) start %s > end %s', id, tenant_id, start_time, end_time)
           ORDER BY tenant_id, id))[1:50], E'\n')
    INTO invalid_count, details
    FROM bookings
   WHERE status IN ('held', 'confirmed')
     AND (provider_id IS NOT NULL OR resource_id IS NOT NULL)
     AND start_time > end_time;

  IF invalid_count > 0 THEN
    RAISE EXCEPTION
      '122_scheduling_v2: % held/confirmed booking(s) end before they start, so they cannot be range-checked. No rows were changed. Fix them and re-run (first 50 shown):%',
      invalid_count, E'\n' || details
      USING ERRCODE = 'check_violation';
  END IF;

  -- Same range semantics as the constraints: [start, end), empty ranges
  -- never overlap.
  SELECT COUNT(*), array_to_string((array_agg(line ORDER BY line))[1:50], E'\n')
    INTO overlap_count, details
    FROM (
      SELECT format(
               '  %s %s: booking %s [%s, %s) %s overlaps booking %s [%s, %s) %s',
               p.kind, p.key_id, p.a_id, p.a_start, p.a_end, p.a_status,
               p.b_id, p.b_start, p.b_end, p.b_status
             ) AS line
        FROM (
          SELECT 'tenant ' || a.tenant_id || ' provider' AS kind, a.provider_id AS key_id,
                 a.id AS a_id, a.start_time AS a_start, a.end_time AS a_end, a.status AS a_status,
                 b.id AS b_id, b.start_time AS b_start, b.end_time AS b_end, b.status AS b_status
            FROM bookings a
            JOIN bookings b
              ON b.tenant_id = a.tenant_id
             AND b.provider_id = a.provider_id
             AND a.id < b.id
             AND tstzrange(a.start_time, a.end_time) && tstzrange(b.start_time, b.end_time)
           WHERE a.provider_id IS NOT NULL
             AND a.status IN ('held', 'confirmed')
             AND b.status IN ('held', 'confirmed')
          UNION ALL
          SELECT 'tenant ' || a.tenant_id || ' resource', a.resource_id,
                 a.id, a.start_time, a.end_time, a.status,
                 b.id, b.start_time, b.end_time, b.status
            FROM bookings a
            JOIN bookings b
              ON b.tenant_id = a.tenant_id
             AND b.resource_id = a.resource_id
             AND a.id < b.id
             AND tstzrange(a.start_time, a.end_time) && tstzrange(b.start_time, b.end_time)
           WHERE a.resource_id IS NOT NULL
             AND a.status IN ('held', 'confirmed')
             AND b.status IN ('held', 'confirmed')
        ) p
    ) lines;

  IF overlap_count > 0 THEN
    RAISE EXCEPTION
      '122_scheduling_v2: % overlapping held/confirmed booking pair(s) block the no-double-booking constraints. No rows were changed. Resolve them (cancel, move or reassign) and re-run (first 50 shown):%',
      overlap_count, E'\n' || details
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Catalog: price on appointment types
-- ---------------------------------------------------------------------------
ALTER TABLE scheduling_appointment_types ADD COLUMN IF NOT EXISTS price_cents INTEGER NULL;
ALTER TABLE scheduling_appointment_types ADD COLUMN IF NOT EXISTS price_kind TEXT NOT NULL DEFAULT 'hidden';
ALTER TABLE scheduling_appointment_types ADD COLUMN IF NOT EXISTS price_max_cents INTEGER NULL;

ALTER TABLE scheduling_appointment_types DROP CONSTRAINT IF EXISTS scheduling_appointment_types_price_kind_check;
ALTER TABLE scheduling_appointment_types ADD CONSTRAINT scheduling_appointment_types_price_kind_check
  CHECK (price_kind IN ('fixed', 'from', 'range', 'hidden'));

-- fixed/from need a price; range needs min <= max; amounts are non-negative cents.
ALTER TABLE scheduling_appointment_types DROP CONSTRAINT IF EXISTS scheduling_appointment_types_price_check;
ALTER TABLE scheduling_appointment_types ADD CONSTRAINT scheduling_appointment_types_price_check
  CHECK (
    (price_cents IS NULL OR price_cents >= 0)
    AND (price_max_cents IS NULL OR price_max_cents >= 0)
    AND (price_kind NOT IN ('fixed', 'from') OR price_cents IS NOT NULL)
    AND (price_kind <> 'range' OR (price_cents IS NOT NULL AND price_max_cents IS NOT NULL AND price_max_cents >= price_cents))
  );

-- ---------------------------------------------------------------------------
-- 3. Who performs what (staff <-> service)
-- ---------------------------------------------------------------------------
-- Composite FKs keep both sides in the row's tenant. FK checks bypass RLS, so
-- without them a tenant could link another tenant's provider id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sched_providers_tenant_id
  ON scheduling_providers (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sched_appt_types_tenant_id
  ON scheduling_appointment_types (tenant_id, id);

CREATE TABLE IF NOT EXISTS scheduling_provider_services (
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_id VARCHAR(255) NOT NULL,
  appointment_type_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider_id, appointment_type_id),
  FOREIGN KEY (tenant_id, provider_id)
    REFERENCES scheduling_providers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, appointment_type_id)
    REFERENCES scheduling_appointment_types (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sched_provider_services_tenant_type
  ON scheduling_provider_services (tenant_id, appointment_type_id);

-- ---------------------------------------------------------------------------
-- 4. Business-level hours
-- ---------------------------------------------------------------------------
-- Wall-clock times in the tenant's timezone (tenants.timezone), like
-- scheduling_provider_schedules. Several rows per day allow split shifts.
-- Holiday closures are scheduling_overrides rows with provider_id NULL
-- (already nullable in 052); no new table for them.
CREATE TABLE IF NOT EXISTS scheduling_business_hours (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  open_time TIME NOT NULL,
  close_time TIME NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (close_time > open_time),
  UNIQUE (tenant_id, day_of_week, open_time)
);

-- ---------------------------------------------------------------------------
-- 5. bookings: held status, hold expiry, buffer, idempotency
-- ---------------------------------------------------------------------------
-- Superset of the 052 list; 'held' is new.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show', 'checked_in', 'rescheduled', 'held'));

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(256) NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS blocked_until TIMESTAMPTZ NULL;

UPDATE bookings SET blocked_until = end_time WHERE blocked_until IS NULL;

ALTER TABLE bookings ALTER COLUMN blocked_until SET NOT NULL;

-- blocked_until = end_time + buffer, so it can never be before end_time.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_blocked_until_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_blocked_until_check
  CHECK (blocked_until >= end_time);

-- A hold without an expiry would block the slot forever.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_hold_expires_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_hold_expires_check
  CHECK (status <> 'held' OR hold_expires_at IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_tenant_idempotency_key
  ON bookings (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_held_expiry
  ON bookings (tenant_id, provider_id, hold_expires_at)
  WHERE status = 'held';

-- Existing writers (admin routes, bookingLifecycle reschedule, voice
-- createBooking) do not know about blocked_until. Default it to end_time on
-- INSERT, and on UPDATE keep the same buffer when end_time moves but the
-- writer did not touch blocked_until. Writers that set it explicitly win.
CREATE OR REPLACE FUNCTION bookings_default_blocked_until() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.blocked_until IS NULL THEN
      NEW.blocked_until := NEW.end_time;
    END IF;
  ELSIF NEW.blocked_until IS NULL THEN
    NEW.blocked_until := NEW.end_time;
  ELSIF NEW.end_time IS DISTINCT FROM OLD.end_time
        AND NEW.blocked_until IS NOT DISTINCT FROM OLD.blocked_until THEN
    NEW.blocked_until := NEW.end_time + GREATEST(OLD.blocked_until - OLD.end_time, INTERVAL '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bookings_default_blocked_until ON bookings;
CREATE TRIGGER bookings_default_blocked_until BEFORE INSERT OR UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_default_blocked_until();

-- ---------------------------------------------------------------------------
-- 6. No double bookings (provider and shared resource)
-- ---------------------------------------------------------------------------
-- Only 'held' and 'confirmed' rows occupy the slot. tstzrange is [start,
-- blocked_until), so back-to-back bookings do not collide. A violation is
-- SQLSTATE 23P01; actions map it to CONFLICT.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bookings_no_provider_overlap'
       AND conrelid = 'bookings'::regclass
  ) THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_no_provider_overlap
      EXCLUDE USING gist (
        tenant_id WITH =,
        provider_id WITH =,
        tstzrange(start_time, blocked_until) WITH &&
      ) WHERE (status IN ('held', 'confirmed') AND provider_id IS NOT NULL);
  END IF;

  -- bookings.resource_id (052) links a booking to a chair/room. The existing
  -- route conflict check treats any overlap on the same resource as a
  -- conflict (capacity is not consulted), so the constraint matches that.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bookings_no_resource_overlap'
       AND conrelid = 'bookings'::regclass
  ) THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_no_resource_overlap
      EXCLUDE USING gist (
        tenant_id WITH =,
        resource_id WITH =,
        tstzrange(start_time, blocked_until) WITH &&
      ) WHERE (status IN ('held', 'confirmed') AND resource_id IS NOT NULL);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 7. RLS on the new tables (same shape as 121)
-- ---------------------------------------------------------------------------
ALTER TABLE scheduling_provider_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_provider_services FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_scheduling_provider_services ON scheduling_provider_services;
CREATE POLICY tenant_isolation_scheduling_provider_services ON scheduling_provider_services
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE scheduling_business_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_business_hours FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_scheduling_business_hours ON scheduling_business_hours;
CREATE POLICY tenant_isolation_scheduling_business_hours ON scheduling_business_hours
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

-- 120 sets DEFAULT PRIVILEGES for qvo_app; repeat the GRANTs so a restored
-- schema still has DML (same as 121).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qvo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scheduling_provider_services, scheduling_business_hours TO qvo_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_rls_tester') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scheduling_provider_services, scheduling_business_hours TO platform_rls_tester;
  END IF;
END
$$;
