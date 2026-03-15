CREATE TABLE IF NOT EXISTS call_quality_scores (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_session_id VARCHAR NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  score FLOAT NOT NULL,
  feedback JSONB DEFAULT '{}',
  scored_by VARCHAR(100) NOT NULL DEFAULT 'gpt-4o-mini',
  scored_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_quality_tenant ON call_quality_scores(tenant_id);
CREATE INDEX IF NOT EXISTS idx_call_quality_session ON call_quality_scores(call_session_id);
CREATE INDEX IF NOT EXISTS idx_call_quality_scored_at ON call_quality_scores(tenant_id, scored_at);

ALTER TABLE call_quality_scores ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_call_quality_scores ON call_quality_scores
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE agent_prompt_versions RENAME TO legacy_agent_prompt_versions;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

CREATE TABLE agent_prompt_versions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id VARCHAR NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version INT NOT NULL,
  system_prompt TEXT NOT NULL,
  notes TEXT,
  created_by VARCHAR,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prompt_versions_agent ON agent_prompt_versions(agent_id);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_tenant ON agent_prompt_versions(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_versions_agent_version ON agent_prompt_versions(agent_id, version);

ALTER TABLE agent_prompt_versions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_agent_prompt_versions ON agent_prompt_versions
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
