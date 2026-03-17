CREATE TABLE IF NOT EXISTS autopilot_policies (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  risk_tier VARCHAR(20) NOT NULL DEFAULT 'medium',
  action_type VARCHAR(60) NOT NULL,
  requires_approval BOOLEAN NOT NULL DEFAULT true,
  approval_role VARCHAR(40) DEFAULT 'admin',
  auto_execute BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_autopilot_policies_tenant ON autopilot_policies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_autopilot_policies_action ON autopilot_policies(tenant_id, action_type);

CREATE TABLE IF NOT EXISTS autopilot_runs (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_type VARCHAR(40) NOT NULL DEFAULT 'scheduled',
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  insights_detected INTEGER NOT NULL DEFAULT 0,
  recommendations_generated INTEGER NOT NULL DEFAULT 0,
  actions_auto_executed INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_autopilot_runs_tenant ON autopilot_runs(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS autopilot_insights (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id VARCHAR(64) REFERENCES autopilot_runs(id) ON DELETE SET NULL,
  category VARCHAR(60) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'info',
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  detected_signal TEXT NOT NULL,
  data_evidence JSONB DEFAULT '{}',
  industry_pack VARCHAR(40),
  confidence_score FLOAT NOT NULL DEFAULT 0.5,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  resolved_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  analysis_period_start TIMESTAMPTZ,
  analysis_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_autopilot_insights_tenant ON autopilot_insights(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_autopilot_insights_status ON autopilot_insights(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_autopilot_insights_severity ON autopilot_insights(tenant_id, severity);
CREATE INDEX IF NOT EXISTS idx_autopilot_insights_category ON autopilot_insights(tenant_id, category);

CREATE TABLE IF NOT EXISTS autopilot_recommendations (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  insight_id VARCHAR(64) REFERENCES autopilot_insights(id) ON DELETE CASCADE,
  run_id VARCHAR(64) REFERENCES autopilot_runs(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  situation_summary TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  expected_outcome TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  confidence_score FLOAT NOT NULL DEFAULT 0.5,
  risk_tier VARCHAR(20) NOT NULL DEFAULT 'medium',
  action_type VARCHAR(60) NOT NULL,
  action_payload JSONB DEFAULT '{}',
  estimated_revenue_impact_cents INTEGER,
  estimated_cost_savings_cents INTEGER,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  approved_by VARCHAR(64),
  approved_at TIMESTAMPTZ,
  rejected_by VARCHAR(64),
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  dismissed_by VARCHAR(64),
  dismissed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  industry_pack VARCHAR(40),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_autopilot_recs_tenant ON autopilot_recommendations(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_autopilot_recs_status ON autopilot_recommendations(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_autopilot_recs_risk ON autopilot_recommendations(tenant_id, risk_tier);
CREATE INDEX IF NOT EXISTS idx_autopilot_recs_insight ON autopilot_recommendations(insight_id);

CREATE TABLE IF NOT EXISTS autopilot_approvals (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recommendation_id VARCHAR(64) NOT NULL REFERENCES autopilot_recommendations(id) ON DELETE CASCADE,
  action VARCHAR(20) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  user_role VARCHAR(40),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_autopilot_approvals_rec ON autopilot_approvals(recommendation_id);
CREATE INDEX IF NOT EXISTS idx_autopilot_approvals_tenant ON autopilot_approvals(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS autopilot_actions (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recommendation_id VARCHAR(64) REFERENCES autopilot_recommendations(id) ON DELETE SET NULL,
  action_type VARCHAR(60) NOT NULL,
  action_payload JSONB DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  executed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB DEFAULT '{}',
  error_message TEXT,
  rollback_payload JSONB,
  rolled_back BOOLEAN NOT NULL DEFAULT false,
  rolled_back_at TIMESTAMPTZ,
  rolled_back_by VARCHAR(64),
  executed_by VARCHAR(64),
  auto_executed BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_autopilot_actions_tenant ON autopilot_actions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_autopilot_actions_rec ON autopilot_actions(recommendation_id);
CREATE INDEX IF NOT EXISTS idx_autopilot_actions_status ON autopilot_actions(tenant_id, status);

CREATE TABLE IF NOT EXISTS autopilot_impact_reports (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_id VARCHAR(64) REFERENCES autopilot_actions(id) ON DELETE SET NULL,
  recommendation_id VARCHAR(64) REFERENCES autopilot_recommendations(id) ON DELETE SET NULL,
  report_type VARCHAR(40) NOT NULL DEFAULT 'post_action',
  metrics_before JSONB DEFAULT '{}',
  metrics_after JSONB DEFAULT '{}',
  measured_revenue_impact_cents INTEGER,
  measured_cost_savings_cents INTEGER,
  improvement_percentage FLOAT,
  assessment TEXT,
  measurement_period_start TIMESTAMPTZ,
  measurement_period_end TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_autopilot_impact_tenant ON autopilot_impact_reports(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_autopilot_impact_action ON autopilot_impact_reports(action_id);

CREATE TABLE IF NOT EXISTS autopilot_notifications (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recommendation_id VARCHAR(64) REFERENCES autopilot_recommendations(id) ON DELETE SET NULL,
  insight_id VARCHAR(64) REFERENCES autopilot_insights(id) ON DELETE SET NULL,
  channel VARCHAR(20) NOT NULL DEFAULT 'in_app',
  severity VARCHAR(20) NOT NULL DEFAULT 'info',
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMPTZ,
  delivered BOOLEAN NOT NULL DEFAULT false,
  delivered_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_autopilot_notif_tenant ON autopilot_notifications(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_autopilot_notif_unread ON autopilot_notifications(tenant_id, read, created_at DESC);

ALTER TABLE autopilot_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_impact_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_notifications ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_autopilot_policies ON autopilot_policies
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_autopilot_runs ON autopilot_runs
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_autopilot_insights ON autopilot_insights
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_autopilot_recommendations ON autopilot_recommendations
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_autopilot_approvals ON autopilot_approvals
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_autopilot_actions ON autopilot_actions
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_autopilot_impact_reports ON autopilot_impact_reports
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_autopilot_notifications ON autopilot_notifications
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
