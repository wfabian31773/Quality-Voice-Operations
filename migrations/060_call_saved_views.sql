-- Per-tenant (and per-user) saved filter views for the Conversations page.
CREATE TABLE IF NOT EXISTS call_saved_views (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}',
  is_shared BOOLEAN NOT NULL DEFAULT false,
  created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_saved_views_tenant ON call_saved_views(tenant_id);
CREATE INDEX IF NOT EXISTS idx_call_saved_views_owner ON call_saved_views(tenant_id, created_by);

ALTER TABLE call_saved_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_call_saved_views ON call_saved_views;
CREATE POLICY tenant_isolation_call_saved_views ON call_saved_views
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);
