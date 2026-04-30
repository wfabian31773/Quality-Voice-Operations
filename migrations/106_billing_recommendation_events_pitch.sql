-- Add a `pitch` dimension to billing_recommendation_events so the
-- admin funnel can split tier-switch CTAs from the optimal-branch
-- annual-only CTA (which collapses to the same current/recommended
-- tier and would otherwise be indistinguishable). All historical
-- rows are tier-switch.

ALTER TABLE billing_recommendation_events
  ADD COLUMN IF NOT EXISTS pitch VARCHAR(32) NOT NULL DEFAULT 'tier-switch';

-- Idempotent re-run: drop any prior pitch CHECK before re-adding.
DO $$
DECLARE
  c_name text;
BEGIN
  SELECT conname INTO c_name
    FROM pg_constraint
   WHERE conrelid = 'billing_recommendation_events'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%pitch%';
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE billing_recommendation_events DROP CONSTRAINT %I', c_name);
  END IF;
END $$;

ALTER TABLE billing_recommendation_events
  ADD CONSTRAINT billing_recommendation_events_pitch_check
    CHECK (pitch IN ('tier-switch', 'annual-only'));

CREATE INDEX IF NOT EXISTS idx_billing_recommendation_events_pitch_created
  ON billing_recommendation_events(pitch, created_at DESC);
