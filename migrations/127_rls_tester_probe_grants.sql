-- Read grants for the tenant-isolation probe role (platform_rls_tester).
--
-- The nightly isolation suite (platform/security/TenantIsolationService.ts)
-- runs its cross-tenant read probes as platform_rls_tester (NOBYPASSRLS,
-- migration 015) whenever the pool connects as a role that bypasses RLS, so
-- the COUNT is held to the real tenant policies. 015 granted the tester
-- access only to tables that existed then and set no default privileges, so
-- a database built from migrations alone has no tester grant on api_keys
-- (025), tickets or bookings (048). Without it those probes fall back to the
-- connected role and report noise instead of a real result.
--
-- SELECT only (the probe only reads), on the tables the suite probes. Each
-- GRANT is idempotent; on a database that already has these grants (the
-- test DB does) this is a no-op. No policy, table, data or role changes.
-- Guarded like 121/122 so it is safe where the tester role doesn't exist.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_rls_tester') THEN
    GRANT SELECT ON agents, audit_logs, api_keys, bookings, tickets, action_proposals TO platform_rls_tester;
  END IF;
END
$$;
