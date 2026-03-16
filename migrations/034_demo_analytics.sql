CREATE TABLE IF NOT EXISTS demo_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  agent_type TEXT,
  ip_hash TEXT NOT NULL,
  duration_seconds INTEGER,
  cta_type TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_demo_analytics_event_type ON demo_analytics (event_type);
CREATE INDEX idx_demo_analytics_created_at ON demo_analytics (created_at);
CREATE INDEX idx_demo_analytics_ip_hash ON demo_analytics (ip_hash);
