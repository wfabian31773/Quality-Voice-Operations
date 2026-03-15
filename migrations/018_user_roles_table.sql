DO $$ BEGIN DROP VIEW IF EXISTS user_roles; EXCEPTION WHEN OTHERS THEN NULL; END $$;

ALTER TABLE user_tenant_roles RENAME TO user_roles;

DO $$ BEGIN
  CREATE VIEW user_tenant_roles AS
    SELECT * FROM user_roles;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_user_tenant_roles ON user_roles; EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE POLICY tenant_isolation_user_roles ON user_roles
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

DO $$ DECLARE
  current_user_name NAME := current_user;
BEGIN
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON user_roles TO %I', 'platform_rls_tester');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
