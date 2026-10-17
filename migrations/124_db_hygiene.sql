-- DB hygiene: fixed search_path on 8 functions, validate the tickets CHECKs
-- from 123.
--
-- 1. Pins search_path = public, pg_temp on the eight functions the Supabase
--    security advisor flags with lint 0011 (function_search_path_mutable).
--    Without a fixed search_path, a function resolves unqualified names
--    through the caller's search_path, so a role that can put an object
--    earlier on that path can change what the function touches. Bodies are
--    unchanged: they only reference public tables and pg_catalog built-ins
--    (pg_catalog is always searched first). The call_events partition
--    helpers from 078 build their DDL with format(%I), so partitions are
--    still created in, and dropped from, public. None of the eight use
--    auth., extensions., gen_random_uuid() or btree_gist operators.
-- 2. Validates the three NOT VALID CHECKs that 123 added on tickets (the
--    follow-up 123's header calls for). Existing rows all hold the column
--    defaults from 123, and new or updated rows were already checked.
--
-- btree_gist stays in schema public (the advisor also warns about that).
-- The 122 exclusion constraints on bookings depend on its operator classes,
-- so moving the extension is riskier than the warning. Not done here.
--
-- Expand-only: no data changes, no drops, no function body rewrites.
--
-- Locking: scripts/run-migrations.ts runs this file in one transaction.
-- ALTER FUNCTION ... SET only updates the pg_proc row. VALIDATE CONSTRAINT
-- takes SHARE UPDATE EXCLUSIVE on tickets for a full-table scan, so reads
-- and writes on tickets keep flowing; only other DDL on tickets waits.
-- lock_timeout makes the migration fail fast instead of queueing.
--
-- Safe to re-run: each ALTER FUNCTION runs only when the function exists
-- (to_regprocedure, since PostgreSQL has no ALTER FUNCTION IF EXISTS) and
-- its proconfig doesn't already hold the setting; each VALIDATE runs only
-- when the constraint exists with convalidated = false. A second run does
-- nothing.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Fixed search_path (advisor lint 0011)
-- ---------------------------------------------------------------------------

-- 121_action_layer.sql (trigger).
DO $$
BEGIN
  IF to_regprocedure('public.prevent_action_audit_log_mutation()') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('public.prevent_action_audit_log_mutation()')
          AND proconfig @> ARRAY['search_path=public, pg_temp']
     ) THEN
    ALTER FUNCTION public.prevent_action_audit_log_mutation() SET search_path = public, pg_temp;
  END IF;
END
$$;

-- 078_call_events_partition_and_usage_metrics_index.sql.
DO $$
BEGIN
  IF to_regprocedure('public.ensure_call_events_partition(timestamptz)') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('public.ensure_call_events_partition(timestamptz)')
          AND proconfig @> ARRAY['search_path=public, pg_temp']
     ) THEN
    ALTER FUNCTION public.ensure_call_events_partition(timestamptz) SET search_path = public, pg_temp;
  END IF;
END
$$;

-- 046_enterprise_security.sql, redefined in 114_healthcare_deployment_approvals.sql
-- (trigger; same signature in both).
DO $$
BEGIN
  IF to_regprocedure('public.prevent_audit_log_mutation()') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('public.prevent_audit_log_mutation()')
          AND proconfig @> ARRAY['search_path=public, pg_temp']
     ) THEN
    ALTER FUNCTION public.prevent_audit_log_mutation() SET search_path = public, pg_temp;
  END IF;
END
$$;

-- 078_call_events_partition_and_usage_metrics_index.sql (p_retain_days INT DEFAULT 90).
DO $$
BEGIN
  IF to_regprocedure('public.prune_call_events_older_than(integer)') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('public.prune_call_events_older_than(integer)')
          AND proconfig @> ARRAY['search_path=public, pg_temp']
     ) THEN
    ALTER FUNCTION public.prune_call_events_older_than(integer) SET search_path = public, pg_temp;
  END IF;
END
$$;

-- 115_healthcare_control_evidence.sql (trigger).
DO $$
BEGIN
  IF to_regprocedure('public.prevent_healthcare_control_evidence_artifact_mutation()') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('public.prevent_healthcare_control_evidence_artifact_mutation()')
          AND proconfig @> ARRAY['search_path=public, pg_temp']
     ) THEN
    ALTER FUNCTION public.prevent_healthcare_control_evidence_artifact_mutation() SET search_path = public, pg_temp;
  END IF;
END
$$;

-- 116_healthcare_activation_readiness.sql (trigger).
DO $$
BEGIN
  IF to_regprocedure('public.prevent_healthcare_activation_readiness_identity_mutation()') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('public.prevent_healthcare_activation_readiness_identity_mutation()')
          AND proconfig @> ARRAY['search_path=public, pg_temp']
     ) THEN
    ALTER FUNCTION public.prevent_healthcare_activation_readiness_identity_mutation() SET search_path = public, pg_temp;
  END IF;
END
$$;

-- 116_healthcare_activation_readiness.sql (trigger).
DO $$
BEGIN
  IF to_regprocedure('public.enforce_healthcare_deployment_readiness()') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('public.enforce_healthcare_deployment_readiness()')
          AND proconfig @> ARRAY['search_path=public, pg_temp']
     ) THEN
    ALTER FUNCTION public.enforce_healthcare_deployment_readiness() SET search_path = public, pg_temp;
  END IF;
END
$$;

-- 122_scheduling_v2.sql (trigger).
DO $$
BEGIN
  IF to_regprocedure('public.bookings_default_blocked_until()') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('public.bookings_default_blocked_until()')
          AND proconfig @> ARRAY['search_path=public, pg_temp']
     ) THEN
    ALTER FUNCTION public.bookings_default_blocked_until() SET search_path = public, pg_temp;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Validate the NOT VALID CHECKs from 123_tickets_v2.sql
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tickets_kind_check'
       AND conrelid = to_regclass('public.tickets')
       AND NOT convalidated
  ) THEN
    ALTER TABLE tickets VALIDATE CONSTRAINT tickets_kind_check;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tickets_urgency_check'
       AND conrelid = to_regclass('public.tickets')
       AND NOT convalidated
  ) THEN
    ALTER TABLE tickets VALIDATE CONSTRAINT tickets_urgency_check;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tickets_intake_object_check'
       AND conrelid = to_regclass('public.tickets')
       AND NOT convalidated
  ) THEN
    ALTER TABLE tickets VALIDATE CONSTRAINT tickets_intake_object_check;
  END IF;
END
$$;
