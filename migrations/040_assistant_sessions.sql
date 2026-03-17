CREATE TABLE IF NOT EXISTS assistant_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id VARCHAR NOT NULL,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  page_context TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_assistant_sessions_tenant ON assistant_sessions(tenant_id);
CREATE INDEX idx_assistant_sessions_user ON assistant_sessions(user_id);
CREATE INDEX idx_assistant_sessions_created ON assistant_sessions(created_at DESC);

CREATE TABLE IF NOT EXISTS assistant_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  parameters JSONB DEFAULT '{}'::jsonb,
  result JSONB DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_assistant_actions_session ON assistant_actions(session_id);
CREATE INDEX idx_assistant_actions_tenant ON assistant_actions(tenant_id);
CREATE INDEX idx_assistant_actions_type ON assistant_actions(action_type);

ALTER TABLE assistant_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY assistant_sessions_tenant_isolation ON assistant_sessions
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY assistant_actions_tenant_isolation ON assistant_actions
  USING (tenant_id = current_setting('app.tenant_id', true));
