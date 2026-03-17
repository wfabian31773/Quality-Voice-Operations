ALTER TABLE digital_twin_results
  ADD COLUMN IF NOT EXISTS recommendation_id VARCHAR,
  ADD COLUMN IF NOT EXISTS conversation_quality JSONB,
  ADD COLUMN IF NOT EXISTS validation_outcome JSONB;

CREATE INDEX IF NOT EXISTS idx_dt_results_recommendation ON digital_twin_results(recommendation_id)
  WHERE recommendation_id IS NOT NULL;
