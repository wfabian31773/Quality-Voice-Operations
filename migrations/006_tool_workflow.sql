DO $$ BEGIN
  CREATE TYPE tool_invocation_status AS ENUM (
    'pending', 'running', 'success', 'failed', 'timeout'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS tool_invocations (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_session_id VARCHAR REFERENCES call_sessions(id) ON DELETE CASCADE,
  tool_name VARCHAR(100) NOT NULL,
  input JSONB DEFAULT '{}',
  output JSONB,
  status tool_invocation_status NOT NULL DEFAULT 'pending',
  error_message TEXT,
  duration_ms INTEGER,
  invoked_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_tenant ON tool_invocations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_session ON tool_invocations(call_session_id);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_tool ON tool_invocations(tool_name);

DO $$ BEGIN
  CREATE TYPE workflow_execution_status AS ENUM (
    'pending', 'running', 'completed', 'failed', 'timed_out', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS workflow_executions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_session_id VARCHAR REFERENCES call_sessions(id) ON DELETE CASCADE,
  workflow_name VARCHAR(100) NOT NULL,
  trigger_event VARCHAR(60),
  status workflow_execution_status NOT NULL DEFAULT 'pending',
  context JSONB DEFAULT '{}',
  result JSONB,
  error_message TEXT,
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_workflow_executions_tenant ON workflow_executions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_session ON workflow_executions(call_session_id);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_status ON workflow_executions(status);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_tenant_started ON workflow_executions(tenant_id, started_at);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_execution_id VARCHAR NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  step_name VARCHAR(100) NOT NULL,
  step_index INTEGER NOT NULL DEFAULT 0,
  status workflow_execution_status NOT NULL DEFAULT 'pending',
  input JSONB DEFAULT '{}',
  output JSONB,
  error_message TEXT,
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_execution ON workflow_steps(workflow_execution_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_tenant ON workflow_steps(tenant_id);
