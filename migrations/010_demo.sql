CREATE TABLE IF NOT EXISTS demo_agents (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  agent_template VARCHAR(60) NOT NULL,
  voice_id VARCHAR(60),
  persona JSONB DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_demo_agents_tenant ON demo_agents(tenant_id);

CREATE TABLE IF NOT EXISTS demo_sessions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  demo_agent_id VARCHAR NOT NULL REFERENCES demo_agents(id) ON DELETE CASCADE,
  visitor_id VARCHAR(100),
  call_session_id VARCHAR REFERENCES call_sessions(id) ON DELETE SET NULL,
  channel VARCHAR(20) DEFAULT 'web',
  duration_seconds INTEGER,
  converted BOOLEAN NOT NULL DEFAULT FALSE,
  feedback JSONB DEFAULT '{}',
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_demo_sessions_tenant ON demo_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_demo_sessions_agent ON demo_sessions(demo_agent_id);
CREATE INDEX IF NOT EXISTS idx_demo_sessions_started ON demo_sessions(started_at);
