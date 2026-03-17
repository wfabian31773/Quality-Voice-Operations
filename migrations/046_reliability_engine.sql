ALTER TABLE integrations ADD COLUMN IF NOT EXISTS fallback_connector_type TEXT;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS fallback_provider TEXT;

CREATE TABLE IF NOT EXISTS escalation_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  call_session_id TEXT NOT NULL,
  agent_slug TEXT,
  caller_phone TEXT,
  reason TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'pending',
  assigned_to TEXT,
  notes TEXT,
  tool_name TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_escalation_tasks_tenant ON escalation_tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_escalation_tasks_status ON escalation_tasks(tenant_id, status);

ALTER TABLE escalation_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_escalation_tasks ON escalation_tasks;
CREATE POLICY rls_escalation_tasks ON escalation_tasks
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS tool_failure_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  call_session_id TEXT NOT NULL,
  agent_slug TEXT,
  error TEXT,
  retry_count INT DEFAULT 0,
  max_retries INT DEFAULT 0,
  final_failure BOOLEAN DEFAULT false,
  fallback_attempted BOOLEAN DEFAULT false,
  fallback_success BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tool_failure_events_tenant ON tool_failure_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tool_failure_events_tool ON tool_failure_events(tenant_id, tool_name);

ALTER TABLE tool_failure_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tool_failure_events ON tool_failure_events;
CREATE POLICY rls_tool_failure_events ON tool_failure_events
  USING (tenant_id = current_setting('app.tenant_id', true));
