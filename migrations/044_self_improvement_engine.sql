CREATE TABLE IF NOT EXISTS prompt_improvement_suggestions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id),
  agent_id VARCHAR NOT NULL REFERENCES agents(id),
  source_call_session_id VARCHAR REFERENCES call_sessions(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
  weakness_category TEXT NOT NULL CHECK (weakness_category IN ('prompt_structure', 'question_ordering', 'objection_handling', 'workflow_efficiency', 'tone', 'accuracy', 'resolution')),
  weakness_description TEXT NOT NULL,
  affected_turns JSONB DEFAULT '[]',
  current_prompt_section TEXT NOT NULL,
  suggested_prompt_section TEXT NOT NULL,
  rationale TEXT NOT NULL,
  simulation_score_before NUMERIC(4,2),
  simulation_score_after NUMERIC(4,2),
  simulation_details JSONB DEFAULT '{}',
  accepted_by VARCHAR REFERENCES users(id),
  accepted_at TIMESTAMPTZ,
  dismissed_by VARCHAR REFERENCES users(id),
  dismissed_at TIMESTAMPTZ,
  applied_prompt_version INTEGER,
  quality_score_before NUMERIC(4,2),
  quality_score_after NUMERIC(4,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pis_tenant_agent ON prompt_improvement_suggestions(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_pis_tenant_status ON prompt_improvement_suggestions(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_pis_created_at ON prompt_improvement_suggestions(created_at);

ALTER TABLE prompt_improvement_suggestions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'prompt_improvement_suggestions' AND policyname = 'tenant_isolation_prompt_improvement_suggestions'
  ) THEN
    CREATE POLICY tenant_isolation_prompt_improvement_suggestions ON prompt_improvement_suggestions
      USING (tenant_id = current_setting('app.tenant_id')::text);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS improvement_metrics (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id),
  agent_id VARCHAR NOT NULL REFERENCES agents(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  suggestions_generated INTEGER NOT NULL DEFAULT 0,
  suggestions_accepted INTEGER NOT NULL DEFAULT 0,
  suggestions_dismissed INTEGER NOT NULL DEFAULT 0,
  avg_quality_before NUMERIC(4,2),
  avg_quality_after NUMERIC(4,2),
  quality_delta NUMERIC(4,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, agent_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_im_tenant_agent ON improvement_metrics(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_im_period ON improvement_metrics(period_start, period_end);

ALTER TABLE improvement_metrics ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'improvement_metrics' AND policyname = 'tenant_isolation_improvement_metrics'
  ) THEN
    CREATE POLICY tenant_isolation_improvement_metrics ON improvement_metrics
      USING (tenant_id = current_setting('app.tenant_id')::text);
  END IF;
END $$;
