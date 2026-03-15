import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';

const logger = createLogger('TENANT_PROVISIONING');

export type ProvisioningStatus = 'pending' | 'provisioning' | 'ready';

export interface ProvisioningResult {
  tenantId: string;
  agentId: string;
  status: ProvisioningStatus;
}

export async function provisionTenant(
  tenantId: string,
  userId: string,
  plan: string,
): Promise<ProvisioningResult> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL row_security = off`);

    const { rows: lockRows } = await client.query(
      `SELECT id, status FROM tenants WHERE id = $1 FOR UPDATE`,
      [tenantId],
    );

    if (lockRows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error(`Tenant not found: ${tenantId}`);
    }

    const currentStatus = lockRows[0].status as string;
    if (currentStatus === 'active') {
      const { rows: existingAgents } = await client.query(
        `SELECT id FROM agents WHERE tenant_id = $1 LIMIT 1`, [tenantId],
      );
      await client.query('COMMIT');
      logger.info('Tenant already provisioned, skipping', { tenantId });
      return { tenantId, agentId: existingAgents[0]?.id as string ?? '', status: 'ready' };
    }

    if (currentStatus !== 'pending' && currentStatus !== 'provisioning') {
      await client.query('ROLLBACK');
      throw new Error(`Cannot provision tenant in status: ${currentStatus}`);
    }

    await client.query(
      `UPDATE tenants SET status = 'provisioning', updated_at = NOW() WHERE id = $1`,
      [tenantId],
    );

    const { rows: existingAgents } = await client.query(
      `SELECT id FROM agents WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );

    let agentId: string;
    if (existingAgents.length > 0) {
      agentId = existingAgents[0].id as string;
    } else {
      const { rows: agentRows } = await client.query(
        `INSERT INTO agents (tenant_id, name, type, status, voice, model, temperature, tools, escalation_config, metadata)
         VALUES ($1, 'Default Answering Service', 'answering-service', 'active', 'sage', 'gpt-4o-realtime-preview', 0.8, '[]', '{}', '{}')
         RETURNING id`,
        [tenantId],
      );
      agentId = agentRows[0].id as string;
    }

    const { rows: existingRole } = await client.query(
      `SELECT id FROM user_roles WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
      [userId, tenantId],
    );

    if (existingRole.length === 0) {
      await client.query(
        `INSERT INTO user_roles (user_id, tenant_id, role)
         VALUES ($1, $2, 'tenant_owner')`,
        [userId, tenantId],
      );
    }

    await client.query(
      `UPDATE tenants SET status = 'active', plan = $2, updated_at = NOW() WHERE id = $1`,
      [tenantId, plan],
    );

    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, changes)
       VALUES ($1, $2, 'system', 'provisioning_complete', 'tenant', $1, $3)`,
      [tenantId, userId, JSON.stringify({ plan, agentId, provisionedAt: new Date().toISOString() })],
    );

    await client.query('COMMIT');

    logger.info('Tenant provisioned successfully', { tenantId, userId, plan, agentId });

    return { tenantId, agentId, status: 'ready' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Tenant provisioning failed', { tenantId, userId, error: String(err) });
    throw err;
  } finally {
    client.release();
  }
}

export async function getProvisioningStatus(
  tenantId: string,
): Promise<{ status: ProvisioningStatus; agentCount: number; phoneNumberCount: number; tenantCreatedAt: string | null }> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL row_security = off`);

    const { rows: tenantRows } = await client.query(
      `SELECT status, created_at FROM tenants WHERE id = $1`,
      [tenantId],
    );

    if (tenantRows.length === 0) {
      await client.query('COMMIT');
      return { status: 'pending', agentCount: 0, phoneNumberCount: 0, tenantCreatedAt: null };
    }

    const tenantStatus = tenantRows[0].status as string;
    const tenantCreatedAt = tenantRows[0].created_at ? new Date(tenantRows[0].created_at as string).toISOString() : null;

    const { rows: agentCount } = await client.query(
      `SELECT COUNT(*) AS count FROM agents WHERE tenant_id = $1`,
      [tenantId],
    );

    const { rows: phoneCount } = await client.query(
      `SELECT COUNT(*) AS count FROM phone_numbers WHERE tenant_id = $1`,
      [tenantId],
    );

    await client.query('COMMIT');

    let status: ProvisioningStatus;
    if (tenantStatus === 'active') {
      status = 'ready';
    } else if (tenantStatus === 'provisioning') {
      status = 'provisioning';
    } else {
      status = 'pending';
    }

    return {
      status,
      agentCount: parseInt(agentCount[0].count as string, 10),
      phoneNumberCount: parseInt(phoneCount[0].count as string, 10),
      tenantCreatedAt,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
