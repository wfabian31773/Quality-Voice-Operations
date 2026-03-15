CREATE INDEX IF NOT EXISTS idx_call_sessions_workflow_id ON call_sessions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_tenant_workflow ON call_sessions(tenant_id, workflow_id)
  WHERE workflow_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_executions_call_session ON workflow_executions(call_session_id);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_call_session ON tool_invocations(call_session_id);

CREATE INDEX IF NOT EXISTS idx_agents_tenant_type ON agents(tenant_id, type);
CREATE INDEX IF NOT EXISTS idx_agents_tenant_status ON agents(tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_users_tenant_email ON users(tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(tenant_id, is_active) WHERE is_active = TRUE;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_tenant_name_unique'
  ) THEN
    ALTER TABLE agents ADD CONSTRAINT agents_tenant_name_unique UNIQUE (tenant_id, name);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'demo_agents_tenant_template_unique'
  ) THEN
    ALTER TABLE demo_agents ADD CONSTRAINT demo_agents_tenant_template_unique UNIQUE (tenant_id, agent_template);
  END IF;
END $$;
