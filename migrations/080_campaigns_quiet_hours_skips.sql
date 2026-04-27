-- Track how many times the campaign scheduler reverted a contact to
-- "pending" because it was outside that contact's local call window.
-- Lets admins see at a glance whether their quiet-hours configuration
-- is too tight (huge skip count) or whether a campaign is silently
-- stalling on off-hours contacts.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS quiet_hours_skips BIGINT NOT NULL DEFAULT 0;
