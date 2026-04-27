-- Per-user preferences blob.
--
-- Stores arbitrary user-scoped preferences as JSONB. Initial use is to track
-- the current onboarding wizard step so the user can resume where they left
-- off after closing the tab or logging out mid-onboarding.
--
-- Shape (informal): { "onboarding_step": number, "onboarding_completed": boolean, ... }

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
