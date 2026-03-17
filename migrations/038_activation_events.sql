CREATE TABLE IF NOT EXISTS activation_events (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activation_events_tenant ON activation_events(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_activation_events_unique ON activation_events(tenant_id, event_type);

CREATE TABLE IF NOT EXISTS tooltip_dismissals (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tooltip_key TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, tooltip_key)
);

CREATE INDEX IF NOT EXISTS idx_tooltip_dismissals_user ON tooltip_dismissals(user_id);
