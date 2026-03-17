CREATE TABLE IF NOT EXISTS ai_insights (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category VARCHAR(40) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  impact_estimate TEXT,
  difficulty VARCHAR(20) DEFAULT 'medium',
  estimated_revenue_impact_cents INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'new',
  action_type VARCHAR(60),
  action_payload JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  dismissed_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  accepted_by VARCHAR(64),
  measured_impact JSONB,
  analysis_period_start TIMESTAMPTZ,
  analysis_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_tenant ON ai_insights(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_insights_status ON ai_insights(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_insights_category ON ai_insights(tenant_id, category);

CREATE TABLE IF NOT EXISTS weekly_reports (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  summary TEXT NOT NULL,
  metrics_snapshot JSONB NOT NULL DEFAULT '{}',
  top_issues JSONB NOT NULL DEFAULT '[]',
  prioritized_actions JSONB NOT NULL DEFAULT '[]',
  insights_generated INTEGER NOT NULL DEFAULT 0,
  insights_accepted INTEGER NOT NULL DEFAULT 0,
  insights_dismissed INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_weekly_reports_tenant ON weekly_reports(tenant_id, week_start DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_reports_unique ON weekly_reports(tenant_id, week_start);

ALTER TABLE ai_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_reports ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_ai_insights ON ai_insights
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_weekly_reports ON weekly_reports
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
