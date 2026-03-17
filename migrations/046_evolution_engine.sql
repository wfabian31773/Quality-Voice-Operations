-- Evolution Engine tables for platform-level product intelligence

DO $$ BEGIN
  CREATE TYPE evolution_signal_source AS ENUM (
    'call_analytics', 'marketplace', 'usage_metrics', 'onboarding',
    'demo_behavior', 'support_patterns', 'churn', 'feature_request'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE evolution_scoring_dimension AS ENUM (
    'customer_demand', 'revenue_potential', 'strategic_fit',
    'development_effort', 'retention_impact', 'differentiation'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE evolution_opportunity_type AS ENUM (
    'missing_vertical', 'missing_integration', 'missing_tool',
    'onboarding_gap', 'marketplace_gap', 'retention_risk',
    'revenue_opportunity', 'ux_improvement'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE evolution_recommendation_status AS ENUM (
    'proposed', 'approved', 'rejected', 'deferred', 'in_progress', 'completed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE evolution_experiment_state AS ENUM (
    'draft', 'active', 'paused', 'concluded', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS evolution_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source evolution_signal_source NOT NULL,
  signal_type VARCHAR(100) NOT NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  tenant_id VARCHAR(255) REFERENCES tenants(id) ON DELETE SET NULL,
  strength FLOAT DEFAULT 1.0,
  raw_data JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evolution_signals_source ON evolution_signals(source);
CREATE INDEX IF NOT EXISTS idx_evolution_signals_type ON evolution_signals(signal_type);
CREATE INDEX IF NOT EXISTS idx_evolution_signals_collected ON evolution_signals(collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_signals_tenant ON evolution_signals(tenant_id);

CREATE TABLE IF NOT EXISTS evolution_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_type evolution_opportunity_type NOT NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  status VARCHAR(50) DEFAULT 'active',
  customer_demand_score FLOAT DEFAULT 0,
  revenue_potential_score FLOAT DEFAULT 0,
  strategic_fit_score FLOAT DEFAULT 0,
  development_effort_score FLOAT DEFAULT 0,
  retention_impact_score FLOAT DEFAULT 0,
  differentiation_score FLOAT DEFAULT 0,
  composite_score FLOAT DEFAULT 0,
  signal_count INT DEFAULT 0,
  affected_tenant_count INT DEFAULT 0,
  evidence JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_signal_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evolution_opportunities_type ON evolution_opportunities(opportunity_type);
CREATE INDEX IF NOT EXISTS idx_evolution_opportunities_score ON evolution_opportunities(composite_score DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_opportunities_status ON evolution_opportunities(status);

CREATE TABLE IF NOT EXISTS roadmap_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID REFERENCES evolution_opportunities(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  problem_detected TEXT NOT NULL,
  evidence_summary TEXT,
  affected_segments JSONB DEFAULT '[]',
  expected_business_impact JSONB DEFAULT '{}',
  implementation_complexity VARCHAR(50) DEFAULT 'medium',
  recommended_priority VARCHAR(50) DEFAULT 'medium',
  estimated_revenue_impact_cents BIGINT DEFAULT 0,
  estimated_effort_days INT DEFAULT 0,
  ai_explanation TEXT,
  status evolution_recommendation_status DEFAULT 'proposed',
  status_changed_by VARCHAR(255),
  status_changed_at TIMESTAMPTZ,
  status_reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_roadmap_recommendations_opp ON roadmap_recommendations(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_recommendations_status ON roadmap_recommendations(status);
CREATE INDEX IF NOT EXISTS idx_roadmap_recommendations_priority ON roadmap_recommendations(recommended_priority);

CREATE TABLE IF NOT EXISTS feature_request_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_name VARCHAR(500) NOT NULL,
  description TEXT,
  request_count INT DEFAULT 0,
  unique_tenant_count INT DEFAULT 0,
  representative_requests JSONB DEFAULT '[]',
  opportunity_id UUID REFERENCES evolution_opportunities(id) ON DELETE SET NULL,
  trend VARCHAR(50) DEFAULT 'stable',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feature_request_clusters_opp ON feature_request_clusters(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_feature_request_clusters_count ON feature_request_clusters(request_count DESC);

CREATE TABLE IF NOT EXISTS integration_demand_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_name VARCHAR(255) NOT NULL,
  category VARCHAR(100),
  demand_score FLOAT DEFAULT 0,
  request_count INT DEFAULT 0,
  unique_tenant_count INT DEFAULT 0,
  search_frequency INT DEFAULT 0,
  competitor_has BOOLEAN DEFAULT FALSE,
  estimated_revenue_impact_cents BIGINT DEFAULT 0,
  opportunity_id UUID REFERENCES evolution_opportunities(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integration_demand_name ON integration_demand_scores(integration_name);
CREATE INDEX IF NOT EXISTS idx_integration_demand_score ON integration_demand_scores(demand_score DESC);

CREATE TABLE IF NOT EXISTS vertical_expansion_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vertical_name VARCHAR(255) NOT NULL,
  current_tenant_count INT DEFAULT 0,
  growth_rate FLOAT DEFAULT 0,
  revenue_per_tenant_cents BIGINT DEFAULT 0,
  market_size_estimate VARCHAR(100),
  expansion_score FLOAT DEFAULT 0,
  demand_signals JSONB DEFAULT '[]',
  opportunity_id UUID REFERENCES evolution_opportunities(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vertical_expansion_name ON vertical_expansion_scores(vertical_name);
CREATE INDEX IF NOT EXISTS idx_vertical_expansion_score ON vertical_expansion_scores(expansion_score DESC);

CREATE TABLE IF NOT EXISTS marketplace_opportunity_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_category VARCHAR(255) NOT NULL,
  gap_description TEXT,
  demand_score FLOAT DEFAULT 0,
  install_velocity FLOAT DEFAULT 0,
  uninstall_rate FLOAT DEFAULT 0,
  search_miss_count INT DEFAULT 0,
  estimated_installs INT DEFAULT 0,
  opportunity_id UUID REFERENCES evolution_opportunities(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketplace_opp_category ON marketplace_opportunity_scores(template_category);
CREATE INDEX IF NOT EXISTS idx_marketplace_opp_score ON marketplace_opportunity_scores(demand_score DESC);

CREATE TABLE IF NOT EXISTS experiment_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_name VARCHAR(500) NOT NULL,
  experiment_type VARCHAR(100) NOT NULL,
  state evolution_experiment_state DEFAULT 'draft',
  hypothesis TEXT,
  description TEXT,
  pilot_tenant_ids JSONB DEFAULT '[]',
  config JSONB DEFAULT '{}',
  success_criteria JSONB DEFAULT '{}',
  results JSONB DEFAULT '{}',
  opportunity_id UUID REFERENCES evolution_opportunities(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  concluded_at TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_experiment_results_state ON experiment_results(state);
CREATE INDEX IF NOT EXISTS idx_experiment_results_opp ON experiment_results(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_experiment_results_type ON experiment_results(experiment_type);

CREATE TABLE IF NOT EXISTS evolution_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type VARCHAR(100) NOT NULL,
  entity_id UUID NOT NULL,
  action VARCHAR(100) NOT NULL,
  old_value JSONB,
  new_value JSONB,
  performed_by VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evolution_audit_entity ON evolution_audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_evolution_audit_created ON evolution_audit_log(created_at DESC);

-- Unique constraints for idempotent pipeline writes
CREATE UNIQUE INDEX IF NOT EXISTS idx_evolution_signals_dedup
  ON evolution_signals(source, signal_type, COALESCE(tenant_id, '__global__'), COALESCE(period_start, '1970-01-01'::timestamptz), md5(title));

CREATE UNIQUE INDEX IF NOT EXISTS idx_evolution_opportunities_dedup
  ON evolution_opportunities(opportunity_type, title);

CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_demand_dedup
  ON integration_demand_scores(integration_name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vertical_expansion_dedup
  ON vertical_expansion_scores(vertical_name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_opp_dedup
  ON marketplace_opportunity_scores(template_category);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_request_clusters_dedup
  ON feature_request_clusters(cluster_name);
