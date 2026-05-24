-- Add JSONB `details` column to usage_metrics.
--
-- Background: platform/billing/cost/CostTrackingService.ts (line ~95)
-- inserts into usage_metrics with this column, carrying per-call debug
-- payload (callSessionId, modelTier, modelUsed, inputTokens, outputTokens).
-- The column was never migrated — the original definition in
-- migrations/008_billing.sql doesn't include it.
--
-- Symptom: first prod call on 2026-05-24 crashed cost recording silently.
-- The inner conversation_costs INSERT returned its row id (logged as
-- "cost_recorded"), then the subsequent usage_metrics INSERT failed with
-- "column details does not exist", which rolled back the entire
-- transaction. Result: conversation_costs stayed empty despite the
-- success log, and the debug context never landed.
--
-- Fix: add the column as JSONB, nullable so existing rows are unaffected.
-- The code's INSERT already passes JSON.stringify(...) which Postgres
-- accepts directly as JSONB input.
--
-- Already applied to Supabase prod (mcminfvxfjuhthivdtzq) via MCP at
-- 2026-05-24 ~18:23 UTC; this file is committed so a fresh DB rebuild
-- picks it up.

ALTER TABLE usage_metrics
  ADD COLUMN IF NOT EXISTS details JSONB;
