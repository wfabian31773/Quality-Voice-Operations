import type { PoolClient } from 'pg';
import { PLAN_TIERS } from '../../shared/billing/planCatalog';

// Every plan includes every template (docs/shop/tools-spec.md, "Plans and
// entitlements"). template_registry.min_plan and template_entitlements stay in
// the schema, but min_plan is always 'starter' and every tier row is enabled.
// Writers must use these instead of deriving either from a manifest's minPlan.

export const TEMPLATE_MIN_PLAN = 'starter';

export async function enableTemplateForAllPlans(
  client: Pick<PoolClient, 'query'>,
  templateId: string,
): Promise<void> {
  for (const tier of PLAN_TIERS) {
    await client.query(
      `INSERT INTO template_entitlements (template_id, plan_tier, enabled)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (template_id, plan_tier) DO UPDATE SET enabled = TRUE`,
      [templateId, tier],
    );
  }
}
