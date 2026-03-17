CREATE TABLE IF NOT EXISTS digital_twin_models (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'building',
  snapshot_data JSONB NOT NULL DEFAULT '{}',
  data_range_start TIMESTAMPTZ,
  data_range_end TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  is_simulation BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_digital_twin_models_tenant ON digital_twin_models(tenant_id);
CREATE INDEX idx_digital_twin_models_status ON digital_twin_models(tenant_id, status);

ALTER TABLE digital_twin_models ENABLE ROW LEVEL SECURITY;
CREATE POLICY digital_twin_models_tenant_isolation ON digital_twin_models
  USING (tenant_id = current_setting('app.tenant_id', TRUE));

CREATE TABLE IF NOT EXISTS digital_twin_scenarios (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL DEFAULT '__system__',
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'custom',
  scenario_type TEXT NOT NULL DEFAULT 'operational',
  parameters JSONB NOT NULL DEFAULT '{}',
  is_predefined BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_digital_twin_scenarios_tenant ON digital_twin_scenarios(tenant_id);
CREATE INDEX idx_digital_twin_scenarios_category ON digital_twin_scenarios(tenant_id, category);
CREATE INDEX idx_digital_twin_scenarios_predefined ON digital_twin_scenarios(is_predefined);

ALTER TABLE digital_twin_scenarios ENABLE ROW LEVEL SECURITY;
CREATE POLICY digital_twin_scenarios_tenant_isolation ON digital_twin_scenarios
  USING (tenant_id = current_setting('app.tenant_id', TRUE) OR tenant_id = '__system__');

CREATE TABLE IF NOT EXISTS digital_twin_simulation_runs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  model_id VARCHAR NOT NULL REFERENCES digital_twin_models(id) ON DELETE CASCADE,
  scenario_id VARCHAR NOT NULL REFERENCES digital_twin_scenarios(id) ON DELETE CASCADE,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  parameters JSONB NOT NULL DEFAULT '{}',
  is_simulation BOOLEAN NOT NULL DEFAULT true,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dt_simulation_runs_tenant ON digital_twin_simulation_runs(tenant_id);
CREATE INDEX idx_dt_simulation_runs_model ON digital_twin_simulation_runs(model_id);
CREATE INDEX idx_dt_simulation_runs_status ON digital_twin_simulation_runs(tenant_id, status);

ALTER TABLE digital_twin_simulation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY dt_simulation_runs_tenant_isolation ON digital_twin_simulation_runs
  USING (tenant_id = current_setting('app.tenant_id', TRUE));

CREATE TABLE IF NOT EXISTS digital_twin_results (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id VARCHAR NOT NULL REFERENCES digital_twin_simulation_runs(id) ON DELETE CASCADE,
  result_type TEXT NOT NULL DEFAULT 'operational',
  metrics JSONB NOT NULL DEFAULT '{}',
  comparison_baseline JSONB DEFAULT '{}',
  summary TEXT,
  is_simulation BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_digital_twin_results_tenant ON digital_twin_results(tenant_id);
CREATE INDEX idx_digital_twin_results_run ON digital_twin_results(run_id);

ALTER TABLE digital_twin_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY digital_twin_results_tenant_isolation ON digital_twin_results
  USING (tenant_id = current_setting('app.tenant_id', TRUE));

CREATE TABLE IF NOT EXISTS forecast_models (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  model_id VARCHAR REFERENCES digital_twin_models(id) ON DELETE SET NULL,
  forecast_type TEXT NOT NULL,
  horizon_days INT NOT NULL DEFAULT 30,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  projections JSONB NOT NULL DEFAULT '[]',
  confidence_level FLOAT NOT NULL DEFAULT 0.8,
  metadata JSONB DEFAULT '{}',
  is_simulation BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_forecast_models_tenant ON forecast_models(tenant_id);
CREATE INDEX idx_forecast_models_type ON forecast_models(tenant_id, forecast_type);
CREATE INDEX idx_forecast_models_model ON forecast_models(model_id);

ALTER TABLE forecast_models ENABLE ROW LEVEL SECURITY;
CREATE POLICY forecast_models_tenant_isolation ON forecast_models
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
