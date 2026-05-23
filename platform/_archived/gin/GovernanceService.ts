import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('GIN_GOVERNANCE');

const CURRENT_POLICY_VERSION = '1.0';

export interface GinParticipationSettings {
  ginParticipation: boolean;
  ginOptedInAt: string | null;
  ginDataUsageAccepted: boolean;
}

export interface PolicyAcceptanceRecord {
  id: string;
  tenantId: string;
  action: string;
  policyVersion: string;
  acceptedBy: string | null;
  createdAt: string;
}

export async function getGinParticipation(tenantId: string): Promise<GinParticipationSettings> {
  const pool = getPlatformPool();
  const { rows } = await pool.query(
    `SELECT gin_participation, gin_opted_in_at, gin_data_usage_accepted FROM tenants WHERE id = $1`,
    [tenantId],
  );

  if (rows.length === 0) {
    return { ginParticipation: false, ginOptedInAt: null, ginDataUsageAccepted: false };
  }

  return {
    ginParticipation: rows[0].gin_participation as boolean,
    ginOptedInAt: rows[0].gin_opted_in_at ? String(rows[0].gin_opted_in_at) : null,
    ginDataUsageAccepted: rows[0].gin_data_usage_accepted as boolean,
  };
}

export async function updateGinParticipation(
  tenantId: string,
  participate: boolean,
  acceptDataUsage: boolean,
  userId?: string,
): Promise<GinParticipationSettings> {
  const pool = getPlatformPool();

  if (participate && !acceptDataUsage) {
    throw new Error('Data usage policy must be accepted to participate in GIN');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE tenants SET
         gin_participation = $2,
         gin_opted_in_at = ${participate ? 'NOW()' : 'gin_opted_in_at'},
         gin_data_usage_accepted = $3,
         updated_at = NOW()
       WHERE id = $1
       RETURNING gin_participation, gin_opted_in_at, gin_data_usage_accepted`,
      [tenantId, participate, acceptDataUsage],
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('Tenant not found');
    }

    await client.query(
      `INSERT INTO gin_policy_acceptance_records (tenant_id, action, policy_version, accepted_by)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, participate ? 'opt_in' : 'opt_out', CURRENT_POLICY_VERSION, userId || null],
    );

    await client.query('COMMIT');

    logger.info('GIN participation updated', { tenantId, participate, acceptDataUsage, policyVersion: CURRENT_POLICY_VERSION });

    return {
      ginParticipation: rows[0].gin_participation as boolean,
      ginOptedInAt: rows[0].gin_opted_in_at ? String(rows[0].gin_opted_in_at) : null,
      ginDataUsageAccepted: rows[0].gin_data_usage_accepted as boolean,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getPolicyAcceptanceHistory(
  tenantId: string,
  limit = 20,
): Promise<PolicyAcceptanceRecord[]> {
  const pool = getPlatformPool();
  const { rows } = await pool.query(
    `SELECT * FROM gin_policy_acceptance_records
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [tenantId, limit],
  );

  return rows.map(r => ({
    id: r.id as string,
    tenantId: r.tenant_id as string,
    action: r.action as string,
    policyVersion: r.policy_version as string,
    acceptedBy: (r.accepted_by as string) || null,
    createdAt: String(r.created_at),
  }));
}
