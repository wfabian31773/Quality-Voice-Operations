import { randomUUID } from 'crypto';
import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../logger';

const logger = createLogger('ERROR_LOGGER');

export type ErrorSeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';

export interface ErrorLogEntry {
  id: string;
  tenantId: string | null;
  severity: ErrorSeverity;
  service: string | null;
  errorCode: string | null;
  message: string;
  stackTrace: string | null;
  context: Record<string, unknown>;
  callSessionId: string | null;
  occurredAt: Date;
}

export async function logError(
  tenantId: string | null,
  severity: ErrorSeverity,
  message: string,
  context: {
    service?: string;
    errorCode?: string;
    stackTrace?: string;
    callSessionId?: string;
    extra?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    const pool = getPlatformPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (tenantId) {
        await withTenantContext(client, tenantId, async () => {});
      } else {
        await client.query(`SET LOCAL row_security = off`);
      }
      await client.query(
        `INSERT INTO error_logs (id, tenant_id, severity, service, error_code, message, stack_trace, context, call_session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          randomUUID(),
          tenantId,
          severity,
          context.service ?? null,
          context.errorCode ?? null,
          message.slice(0, 2000),
          context.stackTrace?.slice(0, 5000) ?? null,
          JSON.stringify(context.extra ?? {}),
          context.callSessionId ?? null,
        ],
      );
      await client.query('COMMIT');
    } catch (innerErr) {
      await client.query('ROLLBACK');
      throw innerErr;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error('Failed to write error log to DB', { error: String(err) });
  }
}

export async function getRecentErrors(
  tenantId: string,
  limit = 50,
): Promise<ErrorLogEntry[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT * FROM error_logs WHERE tenant_id = $1 ORDER BY occurred_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    await client.query('COMMIT');
    return rows.map(mapErrorRow);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function mapErrorRow(r: Record<string, unknown>): ErrorLogEntry {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string | null,
    severity: r.severity as ErrorSeverity,
    service: r.service as string | null,
    errorCode: r.error_code as string | null,
    message: r.message as string,
    stackTrace: r.stack_trace as string | null,
    context: (r.context as Record<string, unknown>) ?? {},
    callSessionId: r.call_session_id as string | null,
    occurredAt: new Date(r.occurred_at as string),
  };
}
