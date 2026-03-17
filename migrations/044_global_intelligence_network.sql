ALTER TABLE tenants ADD COLUMN IF NOT EXISTS gin_participation BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS gin_opted_in_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS gin_data_usage_accepted BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS gin_aggregation_runs (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_type VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  tenants_processed INTEGER NOT NULL DEFAULT 0,
  signals_collected INTEGER NOT NULL DEFAULT 0,
  patterns_detected INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_gin_aggregation_runs_status ON gin_aggregation_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS global_insight_patterns (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  pattern_type VARCHAR(60) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  industry_vertical VARCHAR(60),
  confidence_score NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  sample_size INTEGER NOT NULL DEFAULT 0,
  impact_estimate TEXT,
  metadata JSONB DEFAULT '{}',
  aggregation_run_id VARCHAR(64) REFERENCES gin_aggregation_runs(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_global_insight_patterns_type ON global_insight_patterns(pattern_type, is_active);
CREATE INDEX IF NOT EXISTS idx_global_insight_patterns_industry ON global_insight_patterns(industry_vertical, is_active);

CREATE TABLE IF NOT EXISTS global_prompt_patterns (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  prompt_category VARCHAR(60) NOT NULL,
  industry_vertical VARCHAR(60),
  pattern_description TEXT NOT NULL,
  example_prompt TEXT,
  effectiveness_score NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  sample_size INTEGER NOT NULL DEFAULT 0,
  conversion_rate_avg NUMERIC(5,4),
  avg_call_duration_seconds NUMERIC(8,2),
  metadata JSONB DEFAULT '{}',
  aggregation_run_id VARCHAR(64) REFERENCES gin_aggregation_runs(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_global_prompt_patterns_category ON global_prompt_patterns(prompt_category, is_active);
CREATE INDEX IF NOT EXISTS idx_global_prompt_patterns_industry ON global_prompt_patterns(industry_vertical, is_active);

CREATE TABLE IF NOT EXISTS industry_benchmarks (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  industry_vertical VARCHAR(60) NOT NULL,
  metric_name VARCHAR(80) NOT NULL,
  metric_value NUMERIC(12,4) NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0,
  percentile_25 NUMERIC(12,4),
  percentile_50 NUMERIC(12,4),
  percentile_75 NUMERIC(12,4),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  aggregation_run_id VARCHAR(64) REFERENCES gin_aggregation_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_industry_benchmarks_vertical ON industry_benchmarks(industry_vertical, metric_name, period_end DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_industry_benchmarks_unique ON industry_benchmarks(industry_vertical, metric_name, period_start, period_end);

CREATE TABLE IF NOT EXISTS workflow_performance_metrics (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  industry_vertical VARCHAR(60),
  workflow_type VARCHAR(60) NOT NULL,
  metric_name VARCHAR(80) NOT NULL,
  metric_value NUMERIC(12,4) NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  aggregation_run_id VARCHAR(64) REFERENCES gin_aggregation_runs(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_perf_metrics_type ON workflow_performance_metrics(workflow_type, metric_name, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_perf_metrics_industry ON workflow_performance_metrics(industry_vertical, workflow_type);

CREATE TABLE IF NOT EXISTS network_recommendations (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_pattern_id VARCHAR(64),
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  recommendation_type VARCHAR(60) NOT NULL,
  industry_vertical VARCHAR(60),
  estimated_impact TEXT,
  confidence_score NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  dismissed_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_network_recommendations_tenant ON network_recommendations(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_network_recommendations_industry ON network_recommendations(industry_vertical, recommendation_type);

ALTER TABLE network_recommendations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_network_recommendations ON network_recommendations
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS gin_policy_acceptance_records (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action VARCHAR(20) NOT NULL,
  policy_version VARCHAR(20) NOT NULL DEFAULT '1.0',
  accepted_by VARCHAR(64),
  ip_address VARCHAR(45),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gin_policy_acceptance_tenant ON gin_policy_acceptance_records(tenant_id, created_at DESC);
