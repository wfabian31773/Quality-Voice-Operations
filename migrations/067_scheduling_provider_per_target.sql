-- Per-agent / per-phone-number scheduling provider selection.
-- Allows a tenant who has connected both Google and Outlook calendars to
-- decide which calendar each agent or inbound number books into.
-- NULL on both columns preserves the existing behaviour (broadcast to every
-- enabled scheduling integration).
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS scheduling_provider VARCHAR(60);

ALTER TABLE phone_numbers
  ADD COLUMN IF NOT EXISTS scheduling_provider VARCHAR(60);
