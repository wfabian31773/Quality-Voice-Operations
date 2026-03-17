CREATE TABLE IF NOT EXISTS case_studies (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  milestone_type VARCHAR(50) NOT NULL,
  milestone_value INTEGER NOT NULL,
  industry VARCHAR(100) NOT NULL DEFAULT 'general',
  company_size VARCHAR(50) NOT NULL DEFAULT 'small',
  metrics JSONB NOT NULL DEFAULT '{}',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  public_slug VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, milestone_type, milestone_value)
);

CREATE INDEX IF NOT EXISTS idx_case_studies_tenant ON case_studies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_case_studies_status ON case_studies(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_case_studies_slug ON case_studies(public_slug) WHERE public_slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS milestone_thresholds (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  milestone_type VARCHAR(50) NOT NULL,
  milestone_value INTEGER NOT NULL,
  label VARCHAR(200) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, milestone_type, milestone_value)
);

CREATE INDEX IF NOT EXISTS idx_milestone_thresholds_tenant ON milestone_thresholds(tenant_id);

CREATE TABLE IF NOT EXISTS website_conversion_events (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  visitor_id VARCHAR(100) NOT NULL,
  stage VARCHAR(50) NOT NULL,
  landing_page VARCHAR(500) NOT NULL DEFAULT '/',
  utm_source VARCHAR(200),
  utm_medium VARCHAR(200),
  utm_campaign VARCHAR(200),
  utm_content VARCHAR(200),
  utm_term VARCHAR(200),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wce_visitor ON website_conversion_events(visitor_id);
CREATE INDEX IF NOT EXISTS idx_wce_stage ON website_conversion_events(stage);
CREATE INDEX IF NOT EXISTS idx_wce_created ON website_conversion_events(created_at);
CREATE INDEX IF NOT EXISTS idx_wce_landing ON website_conversion_events(landing_page);
CREATE INDEX IF NOT EXISTS idx_wce_source ON website_conversion_events(utm_source);
