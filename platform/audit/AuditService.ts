import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('AUDIT');

export interface AuditEvent {
  tenantId: string;
  actorUserId: string;
  actorRole?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  changes?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export async function writeAuditLog(event: AuditEvent): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, event.tenantId, async () => {
      await client.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, changes, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::inet, $9)`,
        [
          event.tenantId,
          event.actorUserId,
          event.actorRole ?? null,
          event.action,
          event.resourceType,
          event.resourceId ?? null,
          JSON.stringify(event.changes ?? {}),
          event.ipAddress ?? null,
          event.userAgent ?? null,
        ],
      );
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to write audit log', { action: event.action, error: String(err) });
  } finally {
    client.release();
  }
}

export function extractIp(req: { ip?: string; headers?: Record<string, string | string[] | undefined> }): string | undefined {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.ip ?? undefined;
}
