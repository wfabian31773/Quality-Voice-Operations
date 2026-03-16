CREATE TABLE IF NOT EXISTS operations_alerts (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type VARCHAR(60) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'warning',
  message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  call_session_id VARCHAR(64) REFERENCES call_sessions(id) ON DELETE SET NULL,
  agent_id VARCHAR(64),
  acknowledged BOOLEAN NOT NULL DEFAULT false,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operations_alerts_tenant ON operations_alerts(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operations_alerts_unack ON operations_alerts(tenant_id, acknowledged, created_at DESC);
