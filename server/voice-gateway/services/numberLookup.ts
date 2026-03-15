import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('NUMBER_LOOKUP');

export interface NumberLookupResult {
  tenantId: string;
  agentId: string;
  agentType: string;
  phoneNumberId: string;
  routingId: string;
  conditions: Record<string, unknown> | null;
}

/**
 * Cross-tenant system-level query for inbound call routing.
 * This intentionally does NOT set tenant context because the tenant
 * is unknown until the phone number is resolved. The DB connection
 * role (table owner) bypasses RLS for this system operation.
 */
export async function lookupByPhoneNumber(
  calledNumber: string,
): Promise<NumberLookupResult | null> {
  const pool = getPlatformPool();
  const normalized = calledNumber.replace(/\D/g, '');
  const e164 = normalized.length === 10 ? `+1${normalized}` : `+${normalized}`;

  const { rows } = await pool.query<{
    tenant_id: string;
    agent_id: string;
    agent_type: string;
    phone_number_id: string;
    routing_id: string;
    conditions: Record<string, unknown> | null;
  }>(
    `SELECT
       pn.tenant_id,
       nr.agent_id,
       a.type AS agent_type,
       pn.id AS phone_number_id,
       nr.id AS routing_id,
       nr.conditions
     FROM phone_numbers pn
     JOIN number_routing nr ON nr.phone_number_id = pn.id AND nr.tenant_id = pn.tenant_id AND nr.is_active = true
     JOIN agents a ON a.id = nr.agent_id AND a.tenant_id = pn.tenant_id AND a.status = 'active'
     WHERE pn.phone_number = $1 AND pn.status = 'active'
     ORDER BY nr.priority ASC
     LIMIT 1`,
    [e164],
  );

  if (rows.length === 0) {
    logger.warn('No routing found for number', { phoneNumber: `***${e164.slice(-4)}` });
    return null;
  }

  const row = rows[0];
  logger.info('Number routed', {
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    phoneNumber: `***${e164.slice(-4)}`,
  });

  return {
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    agentType: row.agent_type,
    phoneNumberId: row.phone_number_id,
    routingId: row.routing_id,
    conditions: row.conditions,
  };
}

export async function getAgentConfig(tenantId: string, agentId: string) {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT id, name, type, system_prompt, voice, model, temperature,
              max_response_output_tokens, tools, knowledge_base,
              escalation_config, metadata
       FROM agents WHERE id = $1`,
      [agentId],
    );
    await client.query('COMMIT');
    return rows[0] ?? null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
