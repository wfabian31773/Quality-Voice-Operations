CREATE TABLE IF NOT EXISTS call_sentiment_scores (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_session_id VARCHAR NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  sentiment_score FLOAT NOT NULL,
  sentiment_label TEXT NOT NULL DEFAULT 'neutral',
  confidence FLOAT NOT NULL DEFAULT 0.0,
  details JSONB DEFAULT '{}',
  scored_by TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_sentiment_scores_tenant ON call_sentiment_scores(tenant_id);
CREATE INDEX IF NOT EXISTS idx_call_sentiment_scores_session ON call_sentiment_scores(call_session_id);
CREATE INDEX IF NOT EXISTS idx_call_sentiment_scores_scored_at ON call_sentiment_scores(tenant_id, scored_at);

ALTER TABLE call_sentiment_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS call_sentiment_scores_tenant_isolation ON call_sentiment_scores;
CREATE POLICY call_sentiment_scores_tenant_isolation ON call_sentiment_scores
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS call_topic_classifications (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_session_id VARCHAR NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  primary_topic TEXT NOT NULL,
  secondary_topics TEXT[] DEFAULT '{}',
  confidence FLOAT NOT NULL DEFAULT 0.0,
  details JSONB DEFAULT '{}',
  classified_by TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_topic_classifications_tenant ON call_topic_classifications(tenant_id);
CREATE INDEX IF NOT EXISTS idx_call_topic_classifications_session ON call_topic_classifications(call_session_id);
CREATE INDEX IF NOT EXISTS idx_call_topic_classifications_topic ON call_topic_classifications(tenant_id, primary_topic);

ALTER TABLE call_topic_classifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS call_topic_classifications_tenant_isolation ON call_topic_classifications;
CREATE POLICY call_topic_classifications_tenant_isolation ON call_topic_classifications
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS call_conversion_stages (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_session_id VARCHAR NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  reached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_conversion_stages_tenant ON call_conversion_stages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_call_conversion_stages_session ON call_conversion_stages(call_session_id);
CREATE INDEX IF NOT EXISTS idx_call_conversion_stages_stage ON call_conversion_stages(tenant_id, stage, reached_at);

ALTER TABLE call_conversion_stages ADD CONSTRAINT uq_conversion_stage_per_call UNIQUE (tenant_id, call_session_id, stage);

ALTER TABLE call_conversion_stages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS call_conversion_stages_tenant_isolation ON call_conversion_stages;
CREATE POLICY call_conversion_stages_tenant_isolation ON call_conversion_stages
  USING (tenant_id = current_setting('app.tenant_id', true));
