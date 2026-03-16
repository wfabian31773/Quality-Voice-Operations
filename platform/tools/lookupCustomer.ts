import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import { normalizePhone } from '../core/types';
import type { ToolDefinition, ToolContext } from './registry/types';

const logger = createLogger('TOOL_LOOKUP_CUSTOMER');

interface DbClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

async function withTenant<T>(tenantId: string, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const result = await fn(client as unknown as DbClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface LookupCustomerInput {
  phoneNumber?: string;
  name?: string;
}

interface CustomerProfile {
  phoneNumber: string;
  name: string | null;
  totalCalls: number;
  lastCallDate: string | null;
  recentCalls: Array<{
    date: string;
    agentId: string | null;
    direction: string;
    durationSeconds: number | null;
    state: string;
  }>;
  campaignContacts: Array<{
    campaignId: string;
    campaignName: string;
    status: string;
    outcome: string | null;
  }>;
}

async function lookupByPhone(tenantId: string, phone: string): Promise<CustomerProfile | null> {
  const normalized = normalizePhone(phone);

  return withTenant(tenantId, async (client) => {
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS total FROM call_sessions
       WHERE tenant_id = $1 AND (caller_number = $2 OR called_number = $2)`,
      [tenantId, normalized],
    );
    const totalCalls = (countRows[0]?.total as number) ?? 0;

    const { rows: callRows } = await client.query(
      `SELECT id, agent_id, direction, caller_number, called_number, lifecycle_state,
              duration_seconds, start_time, created_at
       FROM call_sessions
       WHERE tenant_id = $1 AND (caller_number = $2 OR called_number = $2)
       ORDER BY created_at DESC
       LIMIT 10`,
      [tenantId, normalized],
    );

    const { rows: contactRows } = await client.query(
      `SELECT cc.campaign_id, cc.name, cc.status, cc.outcome,
              c.name AS campaign_name
       FROM campaign_contacts cc
       JOIN campaigns c ON c.id = cc.campaign_id AND c.tenant_id = cc.tenant_id
       WHERE cc.tenant_id = $1 AND cc.phone_number = $2
       ORDER BY cc.updated_at DESC
       LIMIT 5`,
      [tenantId, normalized],
    );

    if (totalCalls === 0 && contactRows.length === 0) {
      return null;
    }

    const contactName = contactRows.length > 0
      ? (contactRows[0].name as string | null)
      : null;

    return {
      phoneNumber: normalized,
      name: contactName,
      totalCalls,
      lastCallDate: callRows.length > 0
        ? new Date(callRows[0].created_at as string).toISOString().split('T')[0]
        : null,
      recentCalls: callRows.map((r) => ({
        date: new Date(r.created_at as string).toISOString().split('T')[0],
        agentId: r.agent_id as string | null,
        direction: r.direction as string,
        durationSeconds: r.duration_seconds as number | null,
        state: r.lifecycle_state as string,
      })),
      campaignContacts: contactRows.map((r) => ({
        campaignId: r.campaign_id as string,
        campaignName: r.campaign_name as string,
        status: r.status as string,
        outcome: r.outcome as string | null,
      })),
    };
  });
}

async function lookupByName(tenantId: string, name: string): Promise<CustomerProfile[]> {
  return withTenant(tenantId, async (client) => {
    const pattern = `%${name}%`;

    const { rows: contactRows } = await client.query(
      `SELECT DISTINCT phone_number, name
       FROM campaign_contacts
       WHERE tenant_id = $1 AND name ILIKE $2
       LIMIT 10`,
      [tenantId, pattern],
    );

    if (contactRows.length === 0) return [];

    const phones = contactRows.map((r) => r.phone_number as string);
    const contactNameMap = new Map<string, string | null>();
    for (const r of contactRows) {
      contactNameMap.set(r.phone_number as string, r.name as string | null);
    }

    const phonePlaceholders = phones.map((_, i) => `$${i + 2}`).join(', ');

    const { rows: callRows } = await client.query(
      `SELECT id, agent_id, direction, caller_number, called_number, lifecycle_state,
              duration_seconds, start_time, created_at
       FROM call_sessions
       WHERE tenant_id = $1 AND (caller_number IN (${phonePlaceholders}) OR called_number IN (${phonePlaceholders}))
       ORDER BY created_at DESC`,
      [tenantId, ...phones],
    );

    const { rows: campaignRows } = await client.query(
      `SELECT cc.campaign_id, cc.phone_number, cc.name, cc.status, cc.outcome,
              c.name AS campaign_name
       FROM campaign_contacts cc
       JOIN campaigns c ON c.id = cc.campaign_id AND c.tenant_id = cc.tenant_id
       WHERE cc.tenant_id = $1 AND cc.phone_number IN (${phonePlaceholders})
       ORDER BY cc.updated_at DESC`,
      [tenantId, ...phones],
    );

    const profiles: CustomerProfile[] = [];
    for (const phone of phones) {
      const phoneCalls = callRows.filter((r) => r.caller_number === phone || r.called_number === phone);
      const phoneCampaigns = campaignRows.filter((r) => r.phone_number === phone).slice(0, 5);

      profiles.push({
        phoneNumber: phone,
        name: contactNameMap.get(phone) ?? null,
        totalCalls: phoneCalls.length,
        lastCallDate: phoneCalls.length > 0
          ? new Date(phoneCalls[0].created_at as string).toISOString().split('T')[0]
          : null,
        recentCalls: phoneCalls.slice(0, 10).map((r) => ({
          date: new Date(r.created_at as string).toISOString().split('T')[0],
          agentId: r.agent_id as string | null,
          direction: r.direction as string,
          durationSeconds: r.duration_seconds as number | null,
          state: r.lifecycle_state as string,
        })),
        campaignContacts: phoneCampaigns.map((r) => ({
          campaignId: r.campaign_id as string,
          campaignName: r.campaign_name as string,
          status: r.status as string,
          outcome: r.outcome as string | null,
        })),
      });
    }
    return profiles;
  });
}

async function handler(input: unknown, context: ToolContext): Promise<unknown> {
  const { tenantId } = context;
  const args = input as LookupCustomerInput;

  if (!args.phoneNumber && !args.name) {
    return { success: false, message: 'Either phoneNumber or name must be provided.' };
  }

  try {
    if (args.phoneNumber) {
      const profile = await lookupByPhone(tenantId, args.phoneNumber);
      if (!profile) {
        return { success: true, found: false, message: 'No customer found with that phone number.' };
      }
      return { success: true, found: true, customer: profile };
    }

    const profiles = await lookupByName(tenantId, args.name!);
    if (profiles.length === 0) {
      return { success: true, found: false, message: 'No customers found matching that name.' };
    }
    return { success: true, found: true, customers: profiles };
  } catch (err) {
    logger.error('lookup_customer failed', { tenantId, error: String(err) });
    return { success: false, message: 'Failed to look up customer. Please try again.' };
  }
}

export const lookupCustomerTool: ToolDefinition = {
  name: 'lookup_customer',
  description: 'Search for a customer by phone number or name. Returns their profile, call history, and campaign participation.',
  inputSchema: {
    type: 'object',
    properties: {
      phoneNumber: {
        type: 'string',
        description: 'The phone number to search for (e.g. +15551234567).',
      },
      name: {
        type: 'string',
        description: 'The customer name to search for (partial match supported).',
      },
    },
    required: [],
    additionalProperties: false,
  },
  handler,
};
