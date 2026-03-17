CREATE TABLE IF NOT EXISTS workflows (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflows_tenant ON workflows(tenant_id);

ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'workflows' AND policyname = 'workflows_tenant_isolation'
  ) THEN
    EXECUTE 'CREATE POLICY workflows_tenant_isolation ON workflows USING (tenant_id = current_setting(''app.tenant_id'', TRUE)::varchar) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', TRUE)::varchar)';
  END IF;
END
$$;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS workflow_id VARCHAR REFERENCES workflows(id) ON DELETE SET NULL;
