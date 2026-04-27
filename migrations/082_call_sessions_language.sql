-- 082: Capture the agent language at the time of the call on call_sessions
--
-- Each agent has a configured `language` (migration 077_agents_language.sql),
-- but we never persisted it on the call_sessions row, so call detail pages and
-- analytics dashboards have no way to show what language a call was actually
-- handled in. That makes it impossible for admins to audit multilingual
-- coverage or notice misconfigured agents (e.g. a Spanish-language agent
-- producing English transcripts because the config drifted).
--
-- We snapshot the language onto the call row at session-creation time rather
-- than join through agents.language at query time so that:
--   * Historical reports stay correct if an admin later changes an agent's
--     language.
--   * Calls that handed off to a different agent mid-call still show the
--     language the call started in for the listing/aggregate view.
--
-- The column is intentionally nullable: rows created before this migration
-- have no language captured and we want to render those as "Unknown" rather
-- than silently default them to English (which would distort analytics).
-- New rows are populated by callPersistence.createCallSession.

ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS language VARCHAR(8);

-- Composite index to support the analytics breakdown query that aggregates
-- calls by language inside a (tenant_id, created_at) window. We follow the
-- same (tenant_id, created_at DESC, <facet>) pattern that migration 081
-- established for lifecycle_state on this same table.
CREATE INDEX IF NOT EXISTS idx_call_sessions_tenant_created_language
  ON call_sessions(tenant_id, created_at DESC, language);
