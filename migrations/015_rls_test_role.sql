DO $$ BEGIN
  CREATE ROLE platform_rls_tester NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_rls_tester;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO platform_rls_tester;

DO $$ DECLARE
  current_user_name NAME := current_user;
BEGIN
  EXECUTE format('GRANT platform_rls_tester TO %I', current_user_name);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
