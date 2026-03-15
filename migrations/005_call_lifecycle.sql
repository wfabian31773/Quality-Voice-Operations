DO $$ BEGIN
  CREATE TYPE call_lifecycle_state AS ENUM (
    'CALL_RECEIVED',
    'SESSION_INITIALIZED',
    'AGENT_CONNECTED',
    'ACTIVE_CONVERSATION',
    'WORKFLOW_EXECUTION',
    'TOOL_EXECUTION',
    'ESCALATION_CHECK',
    'ESCALATED',
    'CALL_COMPLETED',
    'CALL_FAILED',
    'WORKFLOW_FAILED',
    'ESCALATION_FAILED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS call_sessions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id VARCHAR REFERENCES agents(id),
  call_sid VARCHAR(50),
  session_id VARCHAR(100),
  direction VARCHAR(10) NOT NULL DEFAULT 'inbound',
  caller_number VARCHAR(20),
  called_number VARCHAR(20),
  lifecycle_state call_lifecycle_state NOT NULL DEFAULT 'CALL_RECEIVED',
  workflow_id VARCHAR,
  context JSONB DEFAULT '{}',
  escalation_target VARCHAR,
  escalation_reason TEXT,
  start_time TIMESTAMP DEFAULT NOW(),
  end_time TIMESTAMP,
  duration_seconds INTEGER,
  total_cost_cents INTEGER,
  environment VARCHAR(20) DEFAULT 'production',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_tenant ON call_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_tenant_start ON call_sessions(tenant_id, start_time);
CREATE INDEX IF NOT EXISTS idx_call_sessions_call_sid ON call_sessions(call_sid);
CREATE INDEX IF NOT EXISTS idx_call_sessions_state ON call_sessions(lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_call_sessions_agent ON call_sessions(agent_id);

CREATE TABLE IF NOT EXISTS call_events (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_session_id VARCHAR NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  event_type VARCHAR(60) NOT NULL,
  from_state call_lifecycle_state,
  to_state call_lifecycle_state,
  payload JSONB DEFAULT '{}',
  occurred_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_events_tenant ON call_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_call_events_session ON call_events(call_session_id);
CREATE INDEX IF NOT EXISTS idx_call_events_type ON call_events(event_type);

CREATE TABLE IF NOT EXISTS call_transcripts (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_session_id VARCHAR NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  sequence_number INTEGER NOT NULL DEFAULT 0,
  occurred_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_transcripts_session ON call_transcripts(call_session_id);
CREATE INDEX IF NOT EXISTS idx_call_transcripts_tenant ON call_transcripts(tenant_id);
