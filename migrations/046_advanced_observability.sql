CREATE TABLE IF NOT EXISTS execution_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(255) NOT NULL,
  call_session_id VARCHAR NOT NULL,
  trace_type VARCHAR(50) NOT NULL,
  step_name VARCHAR(255) NOT NULL,
  sequence_number INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  duration_ms INTEGER,
  input_data JSONB,
  output_data JSONB,
  metadata JSONB DEFAULT '{}',
  parent_trace_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_execution_traces_call_session FOREIGN KEY (call_session_id)
    REFERENCES call_sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_execution_traces_call_session ON execution_traces(call_session_id);
CREATE INDEX idx_execution_traces_tenant ON execution_traces(tenant_id);
CREATE INDEX idx_execution_traces_type ON execution_traces(trace_type);
CREATE INDEX idx_execution_traces_started ON execution_traces(started_at);

CREATE TABLE IF NOT EXISTS integration_event_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(255) NOT NULL,
  call_session_id VARCHAR,
  tool_invocation_id VARCHAR,
  request_method VARCHAR(10) NOT NULL DEFAULT 'POST',
  request_url TEXT NOT NULL,
  request_headers JSONB DEFAULT '{}',
  request_body JSONB,
  response_status INTEGER,
  response_body JSONB,
  response_headers JSONB DEFAULT '{}',
  latency_ms INTEGER,
  error_message TEXT,
  service_name VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_integration_events_call_session ON integration_event_logs(call_session_id);
CREATE INDEX idx_integration_events_tenant ON integration_event_logs(tenant_id);
CREATE INDEX idx_integration_events_service ON integration_event_logs(service_name);
CREATE INDEX idx_integration_events_created ON integration_event_logs(created_at);
CREATE INDEX idx_integration_events_status ON integration_event_logs(response_status);

ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS sentiment_score FLOAT;
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS has_tool_failure BOOLEAN DEFAULT false;
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS escalated BOOLEAN DEFAULT false;
