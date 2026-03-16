-- Tool Execution Engine: extends existing tool_invocations table with execution
-- tracking fields. Uses tool_invocations (not a separate tool_executions table)
-- to keep a single source of truth for all tool call records.
ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS agent_id VARCHAR(255);
ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS agent_slug VARCHAR(255);
ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS parameters_redacted JSONB DEFAULT '{}';
ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS result JSONB;
ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS recovery_action TEXT;

CREATE INDEX IF NOT EXISTS idx_tool_invocations_agent ON tool_invocations(agent_id);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_status ON tool_invocations(status);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_tenant_invoked ON tool_invocations(tenant_id, invoked_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_tenant_status ON tool_invocations(tenant_id, status);

CREATE TABLE IF NOT EXISTS tool_rate_limits (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tool_name VARCHAR(100) NOT NULL,
  max_per_minute INTEGER NOT NULL DEFAULT 60,
  max_per_hour INTEGER NOT NULL DEFAULT 600,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, tool_name)
);

ALTER TABLE tool_rate_limits ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_tool_rate_limits ON tool_rate_limits
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
