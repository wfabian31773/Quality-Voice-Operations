import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { withPrivilegedClient } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('PLATFORM_INTEGRATIONS_STATUS');

interface OAuthProviderSpec {
  /** Identifier used in the platform admin UI (and as map key in the response). */
  provider: string;
  /** Provider value stored in the `integrations` table and the audit log
   *  `resource_id` field for `connector.oauth_connected` events. Must match
   *  the strings written from `server/admin-api/routes/connectorOAuth.ts`. */
  connectorProvider: string;
  label: string;
  category: string;
  requiredEnv: string[];
  optionalEnv?: string[];
  docsUrl: string;
}

// Keep this list in sync with `OAUTH_PROVIDER_REGISTRY` in
// `server/admin-api/routes/connectorOAuth.ts`. The OAuth router only
// checks `*_CLIENT_ID` to decide if a provider is offered to tenants;
// this registry additionally asserts that `*_CLIENT_SECRET` is set so the
// admin console surfaces the full credential picture.
const PROVIDERS: OAuthProviderSpec[] = [
  {
    provider: 'hubspot',
    connectorProvider: 'hubspot',
    label: 'HubSpot',
    category: 'CRM',
    requiredEnv: ['HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET'],
    docsUrl: '/docs/connecting-hubspot',
  },
  {
    provider: 'salesforce',
    connectorProvider: 'salesforce',
    label: 'Salesforce',
    category: 'CRM',
    requiredEnv: ['SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET'],
    optionalEnv: ['SALESFORCE_LOGIN_URL'],
    docsUrl: '/docs/connecting-salesforce',
  },
  {
    provider: 'pipedrive',
    connectorProvider: 'pipedrive',
    label: 'Pipedrive',
    category: 'CRM',
    requiredEnv: ['PIPEDRIVE_CLIENT_ID', 'PIPEDRIVE_CLIENT_SECRET'],
    docsUrl: '/docs/connecting-pipedrive',
  },
  {
    provider: 'zoho',
    connectorProvider: 'zoho',
    label: 'Zoho CRM',
    category: 'CRM',
    requiredEnv: ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET'],
    docsUrl: '/docs/connecting-zoho',
  },
  {
    provider: 'google-calendar',
    connectorProvider: 'google-calendar',
    label: 'Google Calendar',
    category: 'Scheduling',
    requiredEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    docsUrl: '/docs/connecting-calendar',
  },
  {
    provider: 'outlook-calendar',
    connectorProvider: 'outlook-calendar',
    label: 'Outlook Calendar',
    category: 'Scheduling',
    requiredEnv: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
    optionalEnv: ['MICROSOFT_TENANT_ID'],
    docsUrl: '/docs/connecting-outlook',
  },
  {
    provider: 'slack',
    connectorProvider: 'slack',
    label: 'Slack',
    category: 'Messaging',
    requiredEnv: ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'],
    docsUrl: '/docs/connecting-slack',
  },
  {
    provider: 'quickbooks',
    connectorProvider: 'quickbooks',
    label: 'QuickBooks',
    category: 'Finance',
    requiredEnv: ['QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET'],
    optionalEnv: ['QUICKBOOKS_ENV'],
    docsUrl: '/docs/connecting-quickbooks',
  },
];

interface TenantDemandRow {
  provider: string;
  enabled_tenants: number;
  total_tenants: number;
}

interface AuditDemandRow {
  provider: string;
  attempted_tenants: number;
}

/**
 * Returns per-provider tenant demand:
 *   - enabledTenantCount: distinct tenants with that provider's connector
 *     currently enabled in the `integrations` table.
 *   - totalTenantCount: distinct tenants with a row for that provider in
 *     the `integrations` table (enabled or not).
 *   - attemptedTenantCount: distinct tenants that have ever successfully
 *     completed an OAuth connect for that provider, as recorded in
 *     `audit_logs(action='connector.oauth_connected', resource_id=<provider>)`.
 *     This is the best-effort historical demand signal — failed attempts
 *     are not currently audited.
 *
 * Both queries run with RLS disabled (`withPrivilegedClient`) so the
 * platform admin console can aggregate across all tenants.
 */
async function loadTenantDemand(): Promise<Map<string, {
  enabled: number;
  total: number;
  attempted: number;
}>> {
  const demand = new Map<string, { enabled: number; total: number; attempted: number }>();

  try {
    await withPrivilegedClient(async (client) => {
      const integrationsRes = await client.query(
        `SELECT
           provider,
           COUNT(DISTINCT tenant_id) FILTER (WHERE is_enabled = true) AS enabled_tenants,
           COUNT(DISTINCT tenant_id) AS total_tenants
         FROM integrations
         GROUP BY provider`,
      );
      for (const row of integrationsRes.rows as unknown as TenantDemandRow[]) {
        const provider = String(row.provider ?? '');
        if (!provider) continue;
        const enabled = Number(row.enabled_tenants ?? 0);
        const total = Number(row.total_tenants ?? 0);
        const existing = demand.get(provider) ?? { enabled: 0, total: 0, attempted: 0 };
        existing.enabled = enabled;
        existing.total = total;
        demand.set(provider, existing);
      }

      const auditRes = await client.query(
        `SELECT
           resource_id AS provider,
           COUNT(DISTINCT tenant_id) AS attempted_tenants
         FROM audit_logs
         WHERE action = 'connector.oauth_connected'
           AND resource_id IS NOT NULL
         GROUP BY resource_id`,
      );
      for (const row of auditRes.rows as unknown as AuditDemandRow[]) {
        const provider = String(row.provider ?? '');
        if (!provider) continue;
        const attempted = Number(row.attempted_tenants ?? 0);
        const existing = demand.get(provider) ?? { enabled: 0, total: 0, attempted: 0 };
        existing.attempted = attempted;
        demand.set(provider, existing);
      }
    });
  } catch (err) {
    logger.warn('Failed to load tenant demand for integrations status', { error: String(err) });
  }

  return demand;
}

router.get('/platform/integrations-status', requireAuth, requirePlatformAdmin, async (_req, res) => {
  const demand = await loadTenantDemand();

  const providers = PROVIDERS.map((spec) => {
    const missingRequired = spec.requiredEnv.filter((name) => {
      const value = process.env[name];
      return value === undefined || value === '';
    });
    const optionalEnv = (spec.optionalEnv ?? []).map((name) => ({
      name,
      set: Boolean(process.env[name] && process.env[name] !== ''),
    }));
    const counts = demand.get(spec.connectorProvider) ?? { enabled: 0, total: 0, attempted: 0 };
    return {
      provider: spec.provider,
      connectorProvider: spec.connectorProvider,
      label: spec.label,
      category: spec.category,
      configured: missingRequired.length === 0,
      requiredEnv: spec.requiredEnv,
      missingEnv: missingRequired,
      optionalEnv,
      docsUrl: spec.docsUrl,
      enabledTenantCount: counts.enabled,
      totalTenantCount: counts.total,
      attemptedTenantCount: counts.attempted,
    };
  });

  const configuredCount = providers.filter((p) => p.configured).length;
  const blockedTenantDemand = providers
    .filter((p) => !p.configured)
    .reduce((sum, p) => sum + Math.max(p.enabledTenantCount, p.attemptedTenantCount), 0);

  return res.json({
    providers,
    summary: {
      total: providers.length,
      configured: configuredCount,
      missing: providers.length - configuredCount,
      blockedTenantDemand,
    },
  });
});

export default router;
