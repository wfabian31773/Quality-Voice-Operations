-- Template Versioning, Upgrades & Publishing

ALTER TABLE template_versions ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'published'
  CHECK (status IN ('draft', 'published', 'deprecated'));

ALTER TABLE template_versions ADD COLUMN IF NOT EXISTS created_by VARCHAR;

ALTER TABLE tenant_agent_installations ADD COLUMN IF NOT EXISTS rollback_version VARCHAR(20);
ALTER TABLE tenant_agent_installations ADD COLUMN IF NOT EXISTS previous_config JSONB;
ALTER TABLE tenant_agent_installations ADD COLUMN IF NOT EXISTS upgraded_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_template_versions_status ON template_versions(status);
