-- Add `industry` and `company_size` columns to the tenants table.
--
-- `platform/analytics/CaseStudyService.ts` SELECTs both columns when
-- generating per-tenant case studies on every milestone cycle:
--
--   SELECT name, industry, company_size FROM tenants WHERE id = $1
--
-- Without these columns, the SELECT errors with
-- `column "industry" does not exist` and the case-study cycle fails for
-- every tenant on every run. The dev log was emitting this error
-- repeatedly:
--   [CASE_STUDY] Failed to generate case study {"tenantId":"...","error":"error: column \"industry\" does not exist"}
--
-- Defaults match the in-code fallbacks the service uses:
--   const industry    = (tenant.industry as string)    || 'general';
--   const companySize = (tenant.company_size as string) || 'small';
--
-- so existing tenants keep generating the same kind of case study they
-- would have if the columns had been present from day one.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS industry VARCHAR(64) NOT NULL DEFAULT 'general';

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS company_size VARCHAR(32) NOT NULL DEFAULT 'small';
