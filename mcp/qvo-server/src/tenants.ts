import type { ActionTool } from '../../../platform/actions/core';

const ACTION_TOOLS: readonly ActionTool[] = [
  'scheduling',
  'sms',
  'tickets',
  'dispatch',
  'orders',
  'business',
  'calls',
];

export interface TenantSummary {
  id: string;
  name: string;
  timezone: string;
  enabledTools: ActionTool[];
}

/** Every lookup is keyed by the caller's bound tenant; there is no list-all. */
export interface TenantDirectory {
  getTenant(tenantId: string): Promise<TenantSummary | null>;
}

/**
 * Enabled tools come from `tenants.settings.enabledTools` until use-case
 * templates (PR-19) own that list. Unknown entries are dropped.
 */
export function parseEnabledTools(settings: unknown): ActionTool[] {
  const raw = (settings as { enabledTools?: unknown } | null)?.enabledTools;
  if (!Array.isArray(raw)) return [];
  return ACTION_TOOLS.filter((tool) => raw.includes(tool));
}

/** Reads through `withTenantClient`, so RLS (`qvo_app`) also pins the row. */
export function postgresTenantDirectory(): TenantDirectory {
  return {
    async getTenant(tenantId) {
      const { withTenantClient } = await import('../../../platform/db');
      return withTenantClient(tenantId, async (client) => {
        const { rows } = await client.query(
          'SELECT id, name, timezone, settings FROM tenants WHERE id = $1',
          [tenantId],
        );
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
          id: String(row.id),
          name: String(row.name),
          timezone: typeof row.timezone === 'string' && row.timezone ? row.timezone : 'America/New_York',
          enabledTools: parseEnabledTools(row.settings),
        };
      });
    },
  };
}

export function memoryTenantDirectory(tenants: TenantSummary[]): TenantDirectory {
  const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));
  return {
    async getTenant(tenantId) {
      const tenant = byId.get(tenantId);
      return tenant ? { ...tenant, enabledTools: [...tenant.enabledTools] } : null;
    },
  };
}
