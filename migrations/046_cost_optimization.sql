DO $$ BEGIN
  CREATE TYPE model_tier AS ENUM ('economy', 'standard', 'premium');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE cost_component_type AS ENUM ('stt', 'llm', 'tts', 'infrastructure');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS conversation_costs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_session_id VARCHAR NOT NULL,
  stt_cost_cents INTEGER NOT NULL DEFAULT 0,
  llm_cost_cents INTEGER NOT NULL DEFAULT 0,
  tts_cost_cents INTEGER NOT NULL DEFAULT 0,
  infra_cost_cents INTEGER NOT NULL DEFAULT 0,
  total_cost_cents INTEGER NOT NULL DEFAULT 0,
  model_tier model_tier NOT NULL DEFAULT 'standard',
  model_used VARCHAR(100),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hits INTEGER NOT NULL DEFAULT 0,
  cache_misses INTEGER NOT NULL DEFAULT 0,
  prompt_tokens_saved INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, call_session_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_costs_tenant ON conversation_costs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_conversation_costs_session ON conversation_costs(call_session_id);
CREATE INDEX IF NOT EXISTS idx_conversation_costs_created ON conversation_costs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversation_costs_tier ON conversation_costs(tenant_id, model_tier);

CREATE TABLE IF NOT EXISTS response_cache (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cache_key VARCHAR(512) NOT NULL,
  intent VARCHAR(100) NOT NULL,
  response_text TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TIMESTAMP,
  ttl_seconds INTEGER NOT NULL DEFAULT 3600,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_response_cache_tenant_key ON response_cache(tenant_id, cache_key);
CREATE INDEX IF NOT EXISTS idx_response_cache_expires ON response_cache(expires_at);

CREATE TABLE IF NOT EXISTS cost_budget_settings (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  max_cost_per_conversation_cents INTEGER NOT NULL DEFAULT 500,
  alert_threshold_percent INTEGER NOT NULL DEFAULT 80,
  auto_downgrade_model BOOLEAN NOT NULL DEFAULT TRUE,
  auto_end_call BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_cost_budget_settings_tenant ON cost_budget_settings(tenant_id);

CREATE TABLE IF NOT EXISTS model_routing_log (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_session_id VARCHAR,
  query_text TEXT,
  complexity_score NUMERIC(4,2) NOT NULL DEFAULT 0,
  routed_tier model_tier NOT NULL,
  reason VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_routing_log_tenant ON model_routing_log(tenant_id, created_at);

ALTER TABLE conversation_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE response_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_budget_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_routing_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_conversation_costs ON conversation_costs
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_conversation_costs_insert ON conversation_costs
    FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_response_cache ON response_cache
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_response_cache_insert ON response_cache
    FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_cost_budget_settings ON cost_budget_settings
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_cost_budget_settings_insert ON cost_budget_settings
    FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_model_routing_log ON model_routing_log
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_model_routing_log_insert ON model_routing_log
    FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
