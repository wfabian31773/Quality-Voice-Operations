ALTER TABLE tenant_agent_installations
  ADD COLUMN IF NOT EXISTS checklist_state JSONB NOT NULL DEFAULT '{}';

ALTER TABLE tenant_agent_installations
  ADD COLUMN IF NOT EXISTS customization_overrides JSONB NOT NULL DEFAULT '{}';
