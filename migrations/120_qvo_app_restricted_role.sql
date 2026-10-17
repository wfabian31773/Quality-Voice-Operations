-- Restricted application role so RLS is actually enforced.
--
-- Production historically connected as `postgres` (rolbypassrls=true), which
-- silently ignored every tenant isolation policy. The daily isolation suite
-- ran on that same pool and therefore could not detect cross-tenant leaks.
--
-- This migration:
--   1. Creates LOGIN role `qvo_app` with NOBYPASSRLS / NOSUPERUSER.
--      Password is intentionally NOT set here — set it out-of-band in
--      Supabase (or local Postgres) before switching DATABASE_URL.
--   2. Grants DML / sequence / execute privileges on existing objects and
--      default privileges for objects created later by the migration role.
--   3. FORCE ROW LEVEL SECURITY on every tenant-scoped table that already
--      has RLS enabled, so table owners without BYPASSRLS are also bound.
--
-- Idempotent: safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qvo_app') THEN
    CREATE ROLE qvo_app
      WITH LOGIN
           NOINHERIT
           NOSUPERUSER
           NOCREATEDB
           NOCREATEROLE
           NOREPLICATION
           NOBYPASSRLS;
  ELSE
    ALTER ROLE qvo_app
      WITH LOGIN
           NOINHERIT
           NOSUPERUSER
           NOCREATEDB
           NOCREATEROLE
           NOREPLICATION
           NOBYPASSRLS;
  END IF;
END
$$;

COMMENT ON ROLE qvo_app IS
  'QVO application role: LOGIN, NOBYPASSRLS. Password is set out-of-band. Point DATABASE_URL / PLATFORM_DB_POOL_URL at this role after rollout; keep postgres on DATABASE_URL_PRIVILEGED.';

GRANT USAGE ON SCHEMA public TO qvo_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO qvo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO qvo_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO qvo_app;

-- Future objects created by the role that runs migrations (typically postgres).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qvo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO qvo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO qvo_app;

-- Bind table owners (without BYPASSRLS) to the same tenant policies as qvo_app.
-- Only tables that already have RLS enabled and a tenant_id column, plus
-- `tenants` (scoped by id = app.tenant_id). Global catalogs without tenant
-- policies are left alone so the app role can still read them.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN information_schema.columns col
        ON col.table_schema = n.nspname
       AND col.table_name = c.relname
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p') -- include partitioned parents (call_events)
       AND c.relrowsecurity
       AND col.column_name = 'tenant_id'
  LOOP
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.relname);
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenants'
       AND c.relrowsecurity
  ) THEN
    ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
  END IF;
END
$$;
