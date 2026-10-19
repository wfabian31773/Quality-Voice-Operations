-- Every plan includes every template (Wayne, Oct 19 2026).
--
-- Plans differ only in minutes and usage caps (monthly minutes/calls/SMS with
-- overage, calls/hour, minutes/day); no vertical, template, tool or feature is
-- gated on plan tier. See docs/shop/tools-spec.md, "Plans and entitlements".
--
-- template_registry.min_plan and template_entitlements stay in the schema
-- (no drops, no CHECK changes), but from here on min_plan is always 'starter'
-- and every (template, tier) row is enabled. The app no longer reads either to
-- gate installs (platform/marketplace/EntitlementService.ts); the seed script
-- and developer-submission approval write the same values
-- (platform/marketplace/templateEntitlements.ts).
--
-- Data only. Three statements:
--   1. any template with a higher min_plan becomes 'starter';
--   2. any disabled entitlement row becomes enabled;
--   3. any missing (template, tier) row is inserted as enabled.
--
-- Safe to re-run: every statement only touches rows that still differ (3
-- upserts on UNIQUE (template_id, plan_tier) and updates only disabled rows),
-- so a second run writes no rows. On the
-- test DB (template_registry and template_entitlements empty) all three are
-- no-ops.

UPDATE template_registry
   SET min_plan = 'starter', updated_at = NOW()
 WHERE min_plan <> 'starter';

UPDATE template_entitlements
   SET enabled = TRUE
 WHERE enabled = FALSE;

INSERT INTO template_entitlements (template_id, plan_tier, enabled)
SELECT tr.id, tier.plan_tier, TRUE
  FROM template_registry tr
 CROSS JOIN (VALUES ('starter'), ('pro'), ('enterprise')) AS tier(plan_tier)
ON CONFLICT (template_id, plan_tier) DO UPDATE SET enabled = TRUE
 WHERE template_entitlements.enabled = FALSE;
