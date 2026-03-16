ALTER TABLE agents ADD COLUMN IF NOT EXISTS workflow_definition JSONB DEFAULT NULL;

CREATE TABLE IF NOT EXISTS agent_versions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id VARCHAR NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  workflow_definition JSONB,
  system_prompt TEXT,
  voice VARCHAR(50),
  model VARCHAR(100),
  temperature NUMERIC(3,2),
  welcome_greeting TEXT,
  tools JSONB,
  published_at TIMESTAMP,
  published_by VARCHAR,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, agent_id, version)
);

CREATE INDEX IF NOT EXISTS idx_agent_versions_agent ON agent_versions(agent_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_agent_versions_status ON agent_versions(tenant_id, status);

ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_versions_tenant_isolation ON agent_versions;
CREATE POLICY agent_versions_tenant_isolation ON agent_versions
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
