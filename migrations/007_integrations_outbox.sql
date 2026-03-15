DO $$ BEGIN
  CREATE TYPE integration_type AS ENUM (
    'crm', 'ticketing', 'scheduling', 'ehr', 'sms', 'email', 'webhook', 'custom'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS integrations (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  integration_type integration_type NOT NULL,
  provider VARCHAR(60) NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_integrations_tenant ON integrations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_integrations_type ON integrations(integration_type);

CREATE TABLE IF NOT EXISTS connector_configs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id VARCHAR NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  config_key VARCHAR(100) NOT NULL,
  encrypted_value TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(integration_id, config_key)
);

CREATE INDEX IF NOT EXISTS idx_connector_configs_tenant ON connector_configs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_connector_configs_integration ON connector_configs(integration_id);

DO $$ BEGIN
  CREATE TYPE outbox_event_status AS ENUM (
    'pending', 'processing', 'delivered', 'failed', 'dead_letter'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS outbox_events (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(200) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  integration_id VARCHAR REFERENCES integrations(id),
  payload JSONB NOT NULL DEFAULT '{}',
  status outbox_event_status NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  next_attempt_at TIMESTAMP DEFAULT NOW(),
  delivered_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_tenant ON outbox_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_outbox_events_status_next ON outbox_events(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_events_tenant_type ON outbox_events(tenant_id, event_type);
