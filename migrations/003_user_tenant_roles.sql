DO $$ BEGIN
  CREATE TYPE tenant_role AS ENUM (
    'tenant_owner',
    'operations_manager',
    'support_reviewer',
    'billing_admin',
    'agent_developer'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS user_tenant_roles (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role tenant_role NOT NULL DEFAULT 'support_reviewer',
  granted_by VARCHAR REFERENCES users(id),
  granted_at TIMESTAMP DEFAULT NOW(),
  revoked_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, tenant_id, role)
);

CREATE INDEX IF NOT EXISTS idx_user_tenant_roles_user ON user_tenant_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_tenant_roles_tenant ON user_tenant_roles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_tenant_roles_role ON user_tenant_roles(role);
