-- 091_agent_templates.sql
--
-- Lets operators save the current Agent Builder canvas as a named, reusable
-- template that surfaces inside the same Templates picker the built-in
-- industry templates already use.
--
-- Each row represents a single user-authored template. The shape of
-- `workflow_definition` mirrors what the builder hands `PATCH
-- /agents/:id/workflow` (a `{ nodes, edges }` graph), and the
-- `welcome_greeting` / `system_prompt` columns hold the snapshot of the
-- agent settings at save time so loading the template restores the same
-- copy alongside the canvas. We intentionally do NOT store voice/model/
-- temperature here — those stay on the agent the user is editing — so the
-- template is purely a workflow + prompts blueprint.
--
-- Visibility model:
--   - Every template is owned by a single user (`created_by_user_id`) and
--     scoped to a tenant via `tenant_id` (RLS keeps it tenant-isolated).
--   - When `is_shared = false` the template is private to its creator.
--   - When `is_shared = true` every member of the tenant can list/load it.
--
-- The list endpoint applies the per-row visibility check after RLS, so RLS
-- only enforces tenant isolation; user-vs-shared filtering happens in the
-- query.

CREATE TABLE IF NOT EXISTS agent_templates (
  id                   VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by_user_id   VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  name                 VARCHAR(120) NOT NULL,
  description          TEXT,
  workflow_definition  JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
  welcome_greeting     TEXT,
  system_prompt        TEXT,
  language             VARCHAR(8) NOT NULL DEFAULT 'en',
  is_shared            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The Templates picker reads this table on every Agent Builder mount, so
-- the (tenant, recency) ordering needs an index to stay snappy as
-- operators accumulate templates.
CREATE INDEX IF NOT EXISTS idx_agent_templates_tenant_created
  ON agent_templates (tenant_id, created_at DESC);

-- The list endpoint filters by `created_by_user_id OR is_shared`; this
-- partial index makes the "shared with my team" branch cheap.
CREATE INDEX IF NOT EXISTS idx_agent_templates_tenant_shared
  ON agent_templates (tenant_id) WHERE is_shared = TRUE;

ALTER TABLE agent_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_templates_tenant_isolation ON agent_templates;
CREATE POLICY agent_templates_tenant_isolation ON agent_templates
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
