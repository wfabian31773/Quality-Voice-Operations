ALTER TABLE tenant_agent_installations
  ADD COLUMN IF NOT EXISTS installed_by TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_tenant_id ON agents(tenant_id, id);
