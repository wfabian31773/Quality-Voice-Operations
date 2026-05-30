-- Add `industry` and `company_size` columns to the tenants table.
--
-- `platform/analytics/CaseStudyService.ts` (line ~220) SELECTs both
-- columns when generating per-tenant case studies on every milestone
-- cycle:
--
--   SELECT name, industry, company_size FROM tenants WHERE id = $1
--
-- Without these columns the SELECT errors with
-- `column "industry" does not exist` (Postgres 42703). The CASE_STUDY
-- service's surrounding catch logs a warning but the milestone cycle
-- gives up for that tenant. The error was visible in CI logs of every
-- Admin pages e2e run since the CaseStudyService shipped, e.g. run
-- 26673275486 (commit 7b6c8d1):
--
--   [298] ERROR:  column "industry" does not exist at character 14
--   [298] STATEMENT: SELECT name, industry, company_size FROM tenants WHERE id = $1
--
-- HISTORY
-- -------
-- This migration was created on feature branch
-- `claude/ironout-1-tenants-industry-column` (commits d1138af and
-- 812237f, 2026-05-23) as `109_tenants_industry_company_size.sql`,
-- but the branch was never merged. The task was marked "completed"
-- based on the branch commits without verifying the merge to `main`.
-- The cost-tracking work later claimed prefix 109 for
-- `usage_metrics_details_column.sql`, so we land it here as 113 — the
-- next free prefix after the cost-tracking batch (109-112).
--
-- DESIGN
-- ------
-- Defaults match the in-code fallbacks that CaseStudyService.ts uses:
--   const industry    = (tenant.industry as string)    || 'general';
--   const companySize = (tenant.company_size as string) || 'small';
-- so every existing tenant keeps generating the same case-study tier
-- they would have if the columns had been present from day one.
--
-- IF NOT EXISTS guards make the migration safe to re-run AND safe to
-- apply on top of any Supabase prod state that may have been
-- hand-patched (151+ migration drift, see project_db_topology
-- memory).

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS industry VARCHAR(64) NOT NULL DEFAULT 'general';

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS company_size VARCHAR(32) NOT NULL DEFAULT 'small';
