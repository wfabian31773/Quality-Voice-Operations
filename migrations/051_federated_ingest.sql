-- Federated Ingest: ingest_events table + agents federated columns

-- Ingest events table for audit and idempotency tracking
CREATE TABLE IF NOT EXISTS ingest_events (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(255) NOT NULL,
  event_type VARCHAR(60) NOT NULL,
  event_version VARCHAR(10) NOT NULL DEFAULT 'v1',
  source VARCHAR(60) NOT NULL DEFAULT 'remix',
  payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_events_idempotency ON ingest_events(org_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_ingest_events_org ON ingest_events(org_id);
CREATE INDEX IF NOT EXISTS idx_ingest_events_type ON ingest_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ingest_events_status ON ingest_events(status);
CREATE INDEX IF NOT EXISTS idx_ingest_events_created ON ingest_events(created_at);

ALTER TABLE ingest_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_ingest_events ON ingest_events;
CREATE POLICY tenant_isolation_ingest_events ON ingest_events
  USING (org_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (org_id = current_setting('app.tenant_id', true)::varchar);

-- Add federated agent columns to agents table
ALTER TABLE agents ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(20) NOT NULL DEFAULT 'native'
  CHECK (execution_mode IN ('native', 'federated'));
ALTER TABLE agents ADD COLUMN IF NOT EXISTS remote_system VARCHAR(60);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS remote_agent_id VARCHAR(120);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS sync_mode VARCHAR(30) DEFAULT 'event_push'
  CHECK (sync_mode IS NULL OR sync_mode IN ('event_push', 'pull', 'bidirectional'));
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_agents_remote ON agents(tenant_id, remote_system, remote_agent_id)
  WHERE execution_mode = 'federated';

-- Add external_id column to call_sessions for linking ingest events to calls
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS external_id VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_sessions_external_unique ON call_sessions(tenant_id, external_id)
  WHERE external_id IS NOT NULL;
