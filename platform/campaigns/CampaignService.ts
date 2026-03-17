import { randomUUID } from 'crypto';
import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import type {
  Campaign, CampaignContact, CampaignMetrics, CampaignStatus,
  ContactStatus, ContactOutcome, CreateCampaignParams, UpdateCampaignParams,
  TypeSpecificMetrics, CampaignType,
} from './types';
import { getCampaignTypeDefinition } from './CampaignTypeRegistry';

const logger = createLogger('CAMPAIGN_SERVICE');

interface DbClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
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

function rowToCampaign(r: Record<string, unknown>): Campaign {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    agentId: r.agent_id as string,
    name: r.name as string,
    type: r.type as string,
    status: r.status as CampaignStatus,
    config: (typeof r.config === 'object' ? r.config : {}) as Campaign['config'],
    scheduledAt: r.scheduled_at ? new Date(r.scheduled_at as string) : null,
    startedAt: r.started_at ? new Date(r.started_at as string) : null,
    completedAt: r.completed_at ? new Date(r.completed_at as string) : null,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

function rowToContact(r: Record<string, unknown>): CampaignContact {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    campaignId: r.campaign_id as string,
    phoneNumber: r.phone_number as string,
    name: r.name as string | null,
    status: r.status as ContactStatus,
    outcome: (r.outcome as ContactOutcome) ?? null,
    attemptCount: parseInt(String(r.attempt_count ?? '0'), 10),
    lastAttemptedAt: r.last_attempted_at ? new Date(r.last_attempted_at as string) : null,
    metadata: (typeof r.metadata === 'object' && r.metadata !== null ? r.metadata : {}) as Record<string, unknown>,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

export async function createCampaign(params: CreateCampaignParams): Promise<Campaign> {
  return withTenant(params.tenantId, async (client) => {
    const id = randomUUID();
    const { rows } = await client.query(
      `INSERT INTO campaigns (id, tenant_id, agent_id, name, type, status, config, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7)
       RETURNING *`,
      [id, params.tenantId, params.agentId, params.name, params.type ?? 'outbound_call', JSON.stringify(params.config ?? {}), params.scheduledAt ?? null],
    );
    logger.info('Campaign created', { tenantId: params.tenantId, campaignId: id });
    return rowToCampaign(rows[0]);
  });
}

export async function getCampaign(tenantId: string, campaignId: string): Promise<Campaign | null> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM campaigns WHERE id = $1 AND tenant_id = $2`,
      [campaignId, tenantId],
    );
    return rows.length > 0 ? rowToCampaign(rows[0]) : null;
  });
}

export async function listCampaigns(
  tenantId: string,
  opts: { limit?: number; offset?: number; status?: CampaignStatus } = {},
): Promise<{ campaigns: Campaign[]; total: number }> {
  return withTenant(tenantId, async (client) => {
    const { limit = 20, offset = 0, status } = opts;
    const conditions = ['c.tenant_id = $1'];
    const countConditions = ['tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (status) { values.push(status); conditions.push(`c.status = $${values.length}`); countConditions.push(`status = $${values.length}`); }

    const { rows } = await client.query(
      `SELECT c.*, (SELECT COUNT(*)::int FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.tenant_id = c.tenant_id) AS contact_count FROM campaigns c WHERE ${conditions.join(' AND ')} ORDER BY c.created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*) AS total FROM campaigns WHERE ${countConditions.join(' AND ')}`,
      values,
    );
    return {
      campaigns: rows.map((r) => ({ ...rowToCampaign(r), contactCount: (r.contact_count as number) ?? 0 })),
      total: parseInt(countRows[0].total as string),
    };
  });
}

export async function updateCampaign(
  tenantId: string,
  campaignId: string,
  updates: UpdateCampaignParams,
): Promise<Campaign | null> {
  return withTenant(tenantId, async (client) => {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [campaignId, tenantId];

    if (updates.name !== undefined) { values.push(updates.name); sets.push(`name = $${values.length}`); }
    if (updates.status !== undefined) { values.push(updates.status); sets.push(`status = $${values.length}`); }
    if (updates.config !== undefined) { values.push(JSON.stringify(updates.config)); sets.push(`config = $${values.length}`); }
    if (updates.scheduledAt !== undefined) { values.push(updates.scheduledAt); sets.push(`scheduled_at = $${values.length}`); }

    if (updates.status === 'running') { sets.push(`started_at = COALESCE(started_at, NOW())`); }
    if (updates.status === 'completed' || updates.status === 'cancelled') { sets.push(`completed_at = NOW()`); }

    if (sets.length === 1) return null;

    const { rows } = await client.query(
      `UPDATE campaigns SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      values,
    );
    if (rows.length === 0) return null;
    logger.info('Campaign updated', { tenantId, campaignId, status: updates.status });
    return rowToCampaign(rows[0]);
  });
}

export async function deleteCampaign(tenantId: string, campaignId: string): Promise<boolean> {
  return withTenant(tenantId, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM campaigns WHERE id = $1 AND tenant_id = $2 AND status IN ('draft', 'cancelled')`,
      [campaignId, tenantId],
    );
    return (rowCount ?? 0) > 0;
  });
}

export async function getCampaignMetrics(tenantId: string, campaignId: string): Promise<CampaignMetrics> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT status, COUNT(*)::int AS count
       FROM campaign_contacts
       WHERE campaign_id = $1 AND tenant_id = $2
       GROUP BY status`,
      [campaignId, tenantId],
    );
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status as string] = r.count as number;

    const { rows: attemptRows } = await client.query(
      `SELECT COUNT(*)::int AS attempted FROM campaign_contact_attempts
       WHERE tenant_id = $1 AND campaign_contact_id IN (
         SELECT id FROM campaign_contacts WHERE campaign_id = $2 AND tenant_id = $1
       )`,
      [tenantId, campaignId],
    );

    return {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      attempted: (attemptRows[0]?.attempted as number) ?? 0,
      pending: counts.pending ?? 0,
      dialing: counts.dialing ?? 0,
      connected: counts.connected ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      noAnswer: counts.no_answer ?? 0,
      voicemail: counts.voicemail ?? 0,
      skipped: counts.skipped ?? 0,
      optedOut: counts.opted_out ?? 0,
    };
  });
}

export async function getActiveDialingCount(
  tenantId: string,
  campaignId: string,
): Promise<number> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS active FROM campaign_contacts
       WHERE campaign_id = $1 AND tenant_id = $2 AND status IN ('dialing', 'connected')`,
      [campaignId, tenantId],
    );
    return (rows[0]?.active as number) ?? 0;
  });
}

const DEFAULT_TENANT_MAX_CONCURRENT = 10;

export async function getTenantActiveDialingCount(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS active FROM campaign_contacts
       WHERE tenant_id = $1 AND status IN ('dialing', 'connected')`,
      [tenantId],
    );
    return (rows[0]?.active as number) ?? 0;
  });
}

export async function getTenantMaxConcurrent(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT settings FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const settings = rows[0]?.settings as Record<string, unknown> | undefined;
    const perTenant = settings?.maxConcurrentCampaignCalls as number | undefined;
    if (typeof perTenant === 'number' && perTenant > 0) return perTenant;
    return parseInt(process.env.CAMPAIGN_TENANT_MAX_CONCURRENT ?? String(DEFAULT_TENANT_MAX_CONCURRENT), 10);
  });
}

export async function addContacts(
  tenantId: string,
  campaignId: string,
  contacts: Array<{ phoneNumber: string; name?: string; metadata?: Record<string, unknown> }>,
): Promise<number> {
  return withTenant(tenantId, async (client) => {
    const campaign = await getCampaign(tenantId, campaignId);
    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    let inserted = 0;
    for (const c of contacts) {
      const { rowCount } = await client.query(
        `INSERT INTO campaign_contacts (id, tenant_id, campaign_id, phone_number, name, status, metadata)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)
         ON CONFLICT DO NOTHING`,
        [randomUUID(), tenantId, campaignId, c.phoneNumber, c.name ?? null, JSON.stringify(c.metadata ?? {})],
      );
      if ((rowCount ?? 0) > 0) inserted++;
    }
    return inserted;
  });
}

export async function getContact(
  tenantId: string,
  campaignId: string,
  contactId: string,
): Promise<CampaignContact | null> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM campaign_contacts WHERE id = $1 AND campaign_id = $2 AND tenant_id = $3 LIMIT 1`,
      [contactId, campaignId, tenantId],
    );
    return rows.length > 0 ? rowToContact(rows[0]) : null;
  });
}

export async function listContacts(
  tenantId: string,
  campaignId: string,
  opts: { limit?: number; offset?: number; status?: ContactStatus } = {},
): Promise<{ contacts: CampaignContact[]; total: number }> {
  return withTenant(tenantId, async (client) => {
    const { limit = 20, offset = 0, status } = opts;
    const conditions = ['campaign_id = $1', 'tenant_id = $2'];
    const values: unknown[] = [campaignId, tenantId];
    if (status) { values.push(status); conditions.push(`status = $${values.length}`); }

    const where = conditions.join(' AND ');
    const { rows } = await client.query(
      `SELECT * FROM campaign_contacts WHERE ${where} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS total FROM campaign_contacts WHERE ${where}`,
      values,
    );
    return {
      contacts: rows.map(rowToContact),
      total: parseInt(countRows[0].total as string),
    };
  });
}

export async function getNextPendingContact(
  tenantId: string,
  campaignId: string,
  maxAttempts = 3,
  retryDelayMinutes = 30,
): Promise<CampaignContact | null> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `UPDATE campaign_contacts
       SET status = 'dialing', attempt_count = attempt_count + 1,
           last_attempted_at = NOW(), updated_at = NOW()
       WHERE id = (
         SELECT id FROM campaign_contacts
         WHERE campaign_id = $1 AND tenant_id = $2
           AND (
             status = 'pending'
             OR (
               status IN ('failed', 'no_answer')
               AND attempt_count < $3
               AND (last_attempted_at IS NULL OR last_attempted_at < NOW() - ($4 || ' minutes')::interval)
             )
           )
         ORDER BY
           CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
           created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [campaignId, tenantId, maxAttempts, retryDelayMinutes],
    );
    return rows.length > 0 ? rowToContact(rows[0]) : null;
  });
}

export async function updateContactStatus(
  tenantId: string,
  contactId: string,
  status: ContactStatus,
  callSid?: string,
  notes?: string,
  outcome?: ContactOutcome,
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    const sets = ['status = $1', 'updated_at = NOW()'];
    const vals: unknown[] = [status, contactId, tenantId];
    if (outcome) {
      vals.push(outcome);
      sets.push(`outcome = $${vals.length}`);
    }
    await client.query(
      `UPDATE campaign_contacts SET ${sets.join(', ')} WHERE id = $2 AND tenant_id = $3`,
      vals,
    );
    if (callSid) {
      const { rowCount: updated } = await client.query(
        `UPDATE campaign_contact_attempts SET status = $1, notes = $2
         WHERE call_sid = $3 AND campaign_contact_id = $4 AND tenant_id = $5`,
        [status, notes ?? null, callSid, contactId, tenantId],
      );
      if ((updated ?? 0) === 0) {
        await client.query(
          `INSERT INTO campaign_contact_attempts (id, tenant_id, campaign_contact_id, call_sid, status, notes, attempted_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [randomUUID(), tenantId, contactId, callSid, status, notes ?? null],
        );
      }
    }
  });
}

export async function checkCampaignCompletion(tenantId: string, campaignId: string): Promise<boolean> {
  return withTenant(tenantId, async (client) => {
    const campaign = await getCampaign(tenantId, campaignId);
    const maxAttempts = (campaign?.config?.maxAttempts as number) ?? 3;

    const { rows } = await client.query(
      `SELECT COUNT(*) AS actionable FROM campaign_contacts
       WHERE campaign_id = $1 AND tenant_id = $2
         AND (
           status IN ('pending', 'dialing', 'connected')
           OR (status IN ('failed', 'no_answer') AND attempt_count < $3)
         )`,
      [campaignId, tenantId, maxAttempts],
    );
    const actionable = parseInt(rows[0].actionable as string);
    if (actionable === 0) {
      await client.query(
        `UPDATE campaigns SET status = 'completed', completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND status = 'running'`,
        [campaignId, tenantId],
      );
      logger.info('Campaign auto-completed', { tenantId, campaignId });
      return true;
    }
    return false;
  });
}

async function withPrivilegedClient<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL row_security = off`);
    const result = await fn(client as unknown as DbClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getRunningCampaigns(): Promise<Array<{ id: string; tenantId: string; agentId: string; config: Campaign['config'] }>> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT id, tenant_id, agent_id, config FROM campaigns WHERE status = 'running'`,
    );
    return rows.map((r) => ({
      id: r.id as string,
      tenantId: r.tenant_id as string,
      agentId: r.agent_id as string,
      config: (typeof r.config === 'object' && r.config !== null ? r.config : {}) as Campaign['config'],
    }));
  });
}

export async function registerCallSid(
  tenantId: string,
  contactId: string,
  callSid: string,
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO campaign_contact_attempts (id, tenant_id, campaign_contact_id, call_sid, status, attempted_at)
       VALUES ($1, $2, $3, $4, 'dialing', NOW())`,
      [randomUUID(), tenantId, contactId, callSid],
    );
  });
}

export async function resolveContactByCallSid(
  callSid: string,
): Promise<{ tenantId: string; contactId: string; campaignId: string } | null> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT cca.tenant_id, cca.campaign_contact_id, cc.campaign_id
       FROM campaign_contact_attempts cca
       JOIN campaign_contacts cc ON cc.id = cca.campaign_contact_id
       WHERE cca.call_sid = $1
       ORDER BY cca.attempted_at DESC
       LIMIT 1`,
      [callSid],
    );
    if (rows.length === 0) return null;
    return {
      tenantId: rows[0].tenant_id as string,
      contactId: rows[0].campaign_contact_id as string,
      campaignId: rows[0].campaign_id as string,
    };
  });
}

export interface CallbackReconciliation {
  campaignId: string;
  contactId: string;
  contactName: string | null;
}

export async function getTypeSpecificMetrics(
  tenantId: string,
  campaignId: string,
): Promise<TypeSpecificMetrics | null> {
  return withTenant(tenantId, async (client) => {
    const { rows: campaignRows } = await client.query(
      `SELECT type FROM campaigns WHERE id = $1 AND tenant_id = $2`,
      [campaignId, tenantId],
    );
    if (campaignRows.length === 0) return null;
    const campaignType = campaignRows[0].type as string;

    const typeDef = getCampaignTypeDefinition(campaignType);
    if (!typeDef || typeDef.dispositions.length === 0) return null;

    const { rows } = await client.query(
      `SELECT
         COALESCE(metadata->>'typeDisposition', 'no_response') AS disposition,
         COUNT(*)::int AS count
       FROM campaign_contacts
       WHERE campaign_id = $1 AND tenant_id = $2
         AND status IN ('completed', 'voicemail', 'no_answer', 'failed', 'opted_out')
       GROUP BY disposition`,
      [campaignId, tenantId],
    );

    const dispositions: Record<string, number> = {};
    for (const d of typeDef.dispositions) {
      dispositions[d.value] = 0;
    }
    let completedTotal = 0;
    for (const r of rows) {
      const key = r.disposition as string;
      dispositions[key] = (dispositions[key] ?? 0) + (r.count as number);
      completedTotal += r.count as number;
    }

    let primaryCount = 0;
    for (const pd of typeDef.primaryDispositions) {
      primaryCount += dispositions[pd] ?? 0;
    }
    const primaryRate = completedTotal > 0 ? primaryCount / completedTotal : 0;

    return {
      campaignType: campaignType as CampaignType,
      dispositions,
      primaryRate,
      primaryRateLabel: typeDef.primaryMetricLabel,
    };
  });
}

export async function updateContactTypeDisposition(
  tenantId: string,
  campaignId: string,
  contactId: string,
  typeDisposition: string,
): Promise<boolean> {
  return withTenant(tenantId, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE campaign_contacts
       SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{typeDisposition}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3 AND campaign_id = $4`,
      [JSON.stringify(typeDisposition), contactId, tenantId, campaignId],
    );
    return (rowCount ?? 0) > 0;
  });
}

export async function reconcileInboundCallback(
  tenantId: string,
  callerPhone: string,
): Promise<CallbackReconciliation | null> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT cc.id AS contact_id, cc.campaign_id, cc.name
       FROM campaign_contacts cc
       JOIN campaigns c ON c.id = cc.campaign_id AND c.tenant_id = cc.tenant_id
       WHERE cc.tenant_id = $1
         AND cc.phone_number = $2
         AND c.status IN ('running', 'paused', 'completed')
         AND cc.status IN ('completed', 'failed', 'no_answer', 'voicemail')
       ORDER BY cc.updated_at DESC
       LIMIT 1`,
      [tenantId, callerPhone],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    logger.info('Inbound callback reconciled to campaign', {
      tenantId,
      campaignId: r.campaign_id as string,
      contactId: r.contact_id as string,
    });
    return {
      campaignId: r.campaign_id as string,
      contactId: r.contact_id as string,
      contactName: r.name as string | null,
    };
  });
}
