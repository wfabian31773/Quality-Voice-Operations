-- Template Registry & Marketplace Schema

CREATE TABLE IF NOT EXISTS template_registry (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  short_description VARCHAR(500) NOT NULL DEFAULT '',
  icon_url VARCHAR(500),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'deprecated', 'archived')),
  current_version VARCHAR(20) NOT NULL DEFAULT '1.0.0',
  min_plan VARCHAR(50) NOT NULL DEFAULT 'starter' CHECK (min_plan IN ('starter', 'pro', 'enterprise')),
  agent_type VARCHAR(50) NOT NULL DEFAULT 'inbound' CHECK (agent_type IN ('inbound', 'outbound')),
  default_voice VARCHAR(50) NOT NULL DEFAULT 'sage',
  default_language VARCHAR(10) NOT NULL DEFAULT 'en',
  supported_channels JSONB NOT NULL DEFAULT '["voice"]',
  required_tools JSONB NOT NULL DEFAULT '[]',
  optional_tools JSONB NOT NULL DEFAULT '[]',
  config_schema JSONB NOT NULL DEFAULT '{}',
  tags JSONB NOT NULL DEFAULT '[]',
  sort_order INT NOT NULL DEFAULT 0,
  install_count INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_template_registry_slug ON template_registry(slug);
CREATE INDEX IF NOT EXISTS idx_template_registry_status ON template_registry(status);
CREATE INDEX IF NOT EXISTS idx_template_registry_min_plan ON template_registry(min_plan);

CREATE TABLE IF NOT EXISTS template_versions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id VARCHAR NOT NULL REFERENCES template_registry(id) ON DELETE CASCADE,
  version VARCHAR(20) NOT NULL,
  changelog TEXT NOT NULL DEFAULT '',
  package_ref VARCHAR(500) NOT NULL DEFAULT '',
  release_notes TEXT NOT NULL DEFAULT '',
  is_latest BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(template_id, version)
);

CREATE INDEX IF NOT EXISTS idx_template_versions_template_id ON template_versions(template_id);
CREATE INDEX IF NOT EXISTS idx_template_versions_latest ON template_versions(template_id, is_latest) WHERE is_latest = TRUE;

CREATE TABLE IF NOT EXISTS template_categories (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon VARCHAR(50),
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS template_category_map (
  template_id VARCHAR NOT NULL REFERENCES template_registry(id) ON DELETE CASCADE,
  category_id VARCHAR NOT NULL REFERENCES template_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (template_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_template_category_map_template ON template_category_map(template_id);
CREATE INDEX IF NOT EXISTS idx_template_category_map_category ON template_category_map(category_id);

CREATE TABLE IF NOT EXISTS template_changelogs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id VARCHAR NOT NULL REFERENCES template_registry(id) ON DELETE CASCADE,
  version VARCHAR(20) NOT NULL,
  change_type VARCHAR(20) NOT NULL DEFAULT 'added' CHECK (change_type IN ('added', 'changed', 'fixed', 'removed', 'deprecated', 'security')),
  summary TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_template_changelogs_template ON template_changelogs(template_id);

CREATE TABLE IF NOT EXISTS tenant_agent_installations (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL,
  template_id VARCHAR NOT NULL REFERENCES template_registry(id) ON DELETE CASCADE,
  installed_version VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'upgrading', 'error')),
  config JSONB NOT NULL DEFAULT '{}',
  agent_id VARCHAR,
  installed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, template_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_installations_tenant ON tenant_agent_installations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_installations_template ON tenant_agent_installations(template_id);

CREATE TABLE IF NOT EXISTS template_entitlements (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id VARCHAR NOT NULL REFERENCES template_registry(id) ON DELETE CASCADE,
  plan_tier VARCHAR(50) NOT NULL CHECK (plan_tier IN ('starter', 'pro', 'enterprise')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(template_id, plan_tier)
);

CREATE INDEX IF NOT EXISTS idx_template_entitlements_template ON template_entitlements(template_id);
CREATE INDEX IF NOT EXISTS idx_template_entitlements_plan ON template_entitlements(plan_tier);

CREATE TABLE IF NOT EXISTS template_install_events (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL,
  template_id VARCHAR NOT NULL REFERENCES template_registry(id) ON DELETE CASCADE,
  event_type VARCHAR(30) NOT NULL CHECK (event_type IN ('installed', 'upgraded', 'downgraded', 'uninstalled', 'configured', 'error')),
  version VARCHAR(20),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_template_install_events_tenant ON template_install_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_template_install_events_template ON template_install_events(template_id);
CREATE INDEX IF NOT EXISTS idx_template_install_events_created ON template_install_events(created_at);

-- RLS policies for tenant-scoped tables

ALTER TABLE tenant_agent_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_install_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_tenant_agent_installations ON tenant_agent_installations
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_template_install_events ON template_install_events
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Template registry, versions, categories, changelogs, and entitlements are global (no tenant_id)
-- They are readable by all authenticated users but only writable by platform admins
-- This is enforced at the application layer
