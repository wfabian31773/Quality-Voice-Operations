CREATE TABLE IF NOT EXISTS simulation_scenarios (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'custom',
  persona JSONB NOT NULL DEFAULT '{}',
  goals JSONB NOT NULL DEFAULT '[]',
  expected_outcomes JSONB NOT NULL DEFAULT '{}',
  difficulty TEXT NOT NULL DEFAULT 'medium',
  max_turns INT NOT NULL DEFAULT 20,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_simulation_scenarios_tenant ON simulation_scenarios(tenant_id);
CREATE INDEX idx_simulation_scenarios_category ON simulation_scenarios(tenant_id, category);

CREATE TABLE IF NOT EXISTS simulation_runs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id VARCHAR NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  scenario_ids VARCHAR[] NOT NULL DEFAULT '{}',
  total_scenarios INT NOT NULL DEFAULT 0,
  completed_scenarios INT NOT NULL DEFAULT 0,
  failed_scenarios INT NOT NULL DEFAULT 0,
  aggregate_scores JSONB,
  prompt_version_label TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_simulation_runs_tenant ON simulation_runs(tenant_id);
CREATE INDEX idx_simulation_runs_agent ON simulation_runs(tenant_id, agent_id);
CREATE INDEX idx_simulation_runs_status ON simulation_runs(tenant_id, status);

CREATE TABLE IF NOT EXISTS simulation_results (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id VARCHAR NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,
  scenario_id VARCHAR NOT NULL REFERENCES simulation_scenarios(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  transcript JSONB NOT NULL DEFAULT '[]',
  scores JSONB,
  reasoning_trace JSONB NOT NULL DEFAULT '[]',
  tool_calls JSONB NOT NULL DEFAULT '[]',
  outcome TEXT,
  failure_reason TEXT,
  turn_count INT NOT NULL DEFAULT 0,
  duration_ms INT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_simulation_results_run ON simulation_results(run_id);
CREATE INDEX idx_simulation_results_scenario ON simulation_results(scenario_id);
CREATE INDEX idx_simulation_results_tenant ON simulation_results(tenant_id);

ALTER TABLE simulation_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulation_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY simulation_scenarios_tenant_isolation ON simulation_scenarios
  USING (tenant_id = current_setting('app.tenant_id', TRUE));

CREATE POLICY simulation_runs_tenant_isolation ON simulation_runs
  USING (tenant_id = current_setting('app.tenant_id', TRUE));

CREATE POLICY simulation_results_tenant_isolation ON simulation_results
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
