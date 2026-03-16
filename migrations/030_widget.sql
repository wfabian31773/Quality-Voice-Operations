CREATE TABLE IF NOT EXISTS widget_configs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id VARCHAR REFERENCES agents(id) ON DELETE SET NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  greeting TEXT DEFAULT 'Hello! How can I help you today?',
  lead_capture_fields JSONB DEFAULT '["name","email"]',
  primary_color VARCHAR(7) DEFAULT '#6366f1',
  allowed_domains TEXT[] DEFAULT '{}',
  text_chat_enabled BOOLEAN NOT NULL DEFAULT true,
  voice_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id)
);

CREATE TABLE IF NOT EXISTS widget_tokens (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  label VARCHAR(255) DEFAULT 'Default',
  revoked_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_widget_configs_tenant ON widget_configs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_widget_tokens_hash ON widget_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_widget_tokens_tenant ON widget_tokens(tenant_id);
