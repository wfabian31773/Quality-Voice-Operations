-- Capture real OpenAI Realtime API token counts from `response.done.usage`
-- instead of the `Math.ceil(text.length / 4)` estimate.
--
-- BACKGROUND
-- ----------
-- Cost-tracking audit finding #1 (docs/audit/10-cost-tracking-audit.md
-- §2.1): the `costTracker` in `server/voice-gateway/services/openaiSession.ts`
-- counts tokens as `Math.ceil(text.length / 4)` — a char-length heuristic
-- that wildly under-counts audio token cost. The OpenAI Realtime API
-- emits a `response.done` event with a `usage` payload containing exact
-- `input_tokens`, `output_tokens`, and `input_token_details.cached_tokens`
-- (the cached-prompt discount line; OpenAI bills cached input audio at
-- ~80× less than full audio input).
--
-- This migration adds two columns to `conversation_costs` so we can:
--   1. Store the cached-token count separately (it's billed at a
--      different rate; the existing `input_tokens` column already
--      includes cached as part of the OpenAI input total).
--   2. Tag every row with the source of truth used for its counts:
--      'estimate'    = legacy char/4 heuristic — left in as a fallback
--                      when the SDK never emits a response.done.usage
--                      event for some reason.
--      'usage_event' = real OpenAI-emitted counts — the canonical case.
--      Mixed-mode is impossible by construction: the first usage event
--      observed in a call resets the running counters and flips the
--      tracker into 'usage_event' mode so estimates and actuals never
--      double-count.
--
-- The tag is critical because the dashboards in CostAnalyticsService
-- will start showing materially different numbers on a per-row basis,
-- and we need to be able to filter "show me only calls where we
-- captured real counts" to avoid mixing apples and oranges during the
-- rollout window.
--
-- DESIGN
-- ------
-- Both columns are nullable / have safe defaults so legacy rows stay
-- valid and the existing INSERT path doesn't need to be touched on its
-- non-realtime call sites.

ALTER TABLE conversation_costs
  ADD COLUMN IF NOT EXISTS cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usage_capture_source VARCHAR(20) NOT NULL DEFAULT 'estimate';

-- Index for the "show me rollups by capture source" analytics view that
-- the dashboards will gain to surface estimate-vs-actual drift during
-- the rollout window.
CREATE INDEX IF NOT EXISTS idx_conversation_costs_capture_source
  ON conversation_costs(tenant_id, usage_capture_source, created_at DESC);
