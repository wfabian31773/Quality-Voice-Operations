-- Throwaway / CI Postgres role bootstrap for QVO RLS and tenant-isolation tests.
--
-- Idempotent. Does not change tables, policies, or grants beyond CONNECT /
-- schema USAGE for qvo_app. Safe to run before and after `npm run db:migrate`.
--
-- Why this exists:
--   * GitHub Actions (and vanilla Postgres) have no Supabase roles. A few
--     policies compare `current_user` to `'service_role'` / `'postgres'`.
--   * Migration 120 creates `qvo_app` with LOGIN NOBYPASSRLS but no password.
--     Password-auth Postgres (the Actions service container) cannot connect
--     as that role until a password is set. The password below is a
--     well-known CI-only value, not a secret.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  -- Match Supabase: service_role bypasses RLS. Policies that allow
  -- current_user IN ('service_role', 'postgres') keep that meaning here.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
END
$$;

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
           NOBYPASSRLS
           PASSWORD 'qvo_app';
  ELSE
    ALTER ROLE qvo_app
      WITH LOGIN
           NOINHERIT
           NOSUPERUSER
           NOCREATEDB
           NOCREATEROLE
           NOREPLICATION
           NOBYPASSRLS
           PASSWORD 'qvo_app';
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO qvo_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO qvo_app;

-- Re-apply DML grants. Migration 120 already does this; repeating after
-- migrate is idempotent and restores privileges if a test temporarily
-- took ownership of a table (ALTER TABLE OWNER TO qvo_app drops the
-- previous GRANT when ownership is handed back).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO qvo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO qvo_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO qvo_app;
