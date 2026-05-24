-- Ensure platform_rls_tester role exists with the GRANTs the tenant isolation
-- test suite needs.
--
-- Background: migration 015_rls_test_role.sql created this role on Replit
-- local Postgres, but a `pg_dump --schema-only` does NOT include roles
-- (they're cluster-level, not database-level objects). When we baselined
-- the Supabase prod schema from the Replit pg_dump, the role was missing
-- and the Tenant Isolation - RLS Enforcement test suite (tests/security/
-- tenantIsolation.test.ts) could not assert that RLS actually enforces —
-- the postgres role on Supabase has BYPASSRLS=true, so a test run as
-- postgres would falsely pass even with no policies.
--
-- This migration is idempotent. It supersedes migration 015 on any fresh
-- Supabase database where 015 was not applied via the pg_dump baseline.

DO $$ BEGIN
  CREATE ROLE platform_rls_tester NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT USAGE ON SCHEMA public TO platform_rls_tester;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_rls_tester;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO platform_rls_tester;

-- Future tables created in public should also be reachable.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_rls_tester;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO platform_rls_tester;

-- Pin search_path so SET LOCAL ROLE platform_rls_tester doesn't lose
-- visibility into public (PostgreSQL resets search_path per role's
-- ALTER ROLE ... SET setting).
ALTER ROLE platform_rls_tester SET search_path = public;

-- Allow the deployment role (postgres on Supabase) to SET LOCAL ROLE
-- platform_rls_tester within a transaction. Wrap in DO so the GRANT is
-- skipped on environments where this membership is already set.
DO $$ DECLARE
  current_user_name NAME := current_user;
BEGIN
  EXECUTE format('GRANT platform_rls_tester TO %I', current_user_name);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
