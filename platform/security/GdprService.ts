import { getPlatformPool, withTenantContext, withPrivilegedClient } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('GDPR');

export interface GdprExportData {
  user: Record<string, unknown> | null;
  roles: Record<string, unknown>[];
  auditLogs: Record<string, unknown>[];
  callSessions: Record<string, unknown>[];
  campaignContacts: Record<string, unknown>[];
}

export async function exportUserData(tenantId: string, userEmail: string): Promise<GdprExportData> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: userRows } = await client.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.created_at, u.last_login_at, u.is_active, u.email_verified
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = $2
       WHERE u.email = $1`,
      [userEmail.toLowerCase(), tenantId],
    );

    const user = userRows[0] ?? null;
    const userId = user?.id as string | undefined;

    let roles: Record<string, unknown>[] = [];
    let auditLogs: Record<string, unknown>[] = [];
    let callSessions: Record<string, unknown>[] = [];
    let campaignContacts: Record<string, unknown>[] = [];

    if (userId) {
      const { rows: roleRows } = await client.query(
        `SELECT role, created_at FROM user_roles WHERE user_id = $1 AND tenant_id = $2`,
        [userId, tenantId],
      );
      roles = roleRows;

      const { rows: auditRows } = await client.query(
        `SELECT action, resource_type, resource_id, changes, ip_address, occurred_at
         FROM audit_logs WHERE actor_user_id = $1 AND tenant_id = $2
         ORDER BY occurred_at DESC LIMIT 1000`,
        [userId, tenantId],
      );
      auditLogs = auditRows;

      try {
        const { rows: callRows } = await client.query(
          `SELECT cs.id, cs.caller_number, cs.called_number, cs.direction, cs.lifecycle_state,
                  cs.start_time, cs.end_time, cs.duration_seconds
           FROM call_sessions cs
           WHERE cs.tenant_id = $1 AND cs.id IN (
             SELECT al.resource_id FROM audit_logs al
             WHERE al.tenant_id = $1 AND al.actor_user_id = $2 AND al.resource_type = 'call'
           )
           ORDER BY cs.start_time DESC LIMIT 500`,
          [tenantId, userId],
        );
        callSessions = callRows;
      } catch {
        logger.warn('Could not export call sessions for user', { tenantId, userId });
      }

      try {
        const { rows: campRows } = await client.query(
          `SELECT cc.id, cc.phone_number, cc.status, cc.created_at
           FROM campaign_contacts cc
           WHERE cc.tenant_id = $1 AND cc.phone_number IN (
             SELECT DISTINCT cs.caller_number FROM call_sessions cs
             JOIN audit_logs al ON al.resource_id = cs.id AND al.actor_user_id = $2 AND al.tenant_id = $1
             WHERE cs.tenant_id = $1
           )
           LIMIT 500`,
          [tenantId, userId],
        );
        campaignContacts = campRows;
      } catch {
        logger.warn('Could not export campaign contacts for user', { tenantId, userId });
      }
    }

    await client.query('COMMIT');

    return { user, roles, auditLogs, callSessions, campaignContacts };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function eraseUserData(tenantId: string, userEmail: string): Promise<{ erasedFields: string[]; userId: string | null }> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  const erasedFields: string[] = [];

  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL row_security = off');

    const { rows: userRows } = await client.query(
      `SELECT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = $2
       WHERE u.email = $1`,
      [userEmail.toLowerCase(), tenantId],
    );

    if (userRows.length === 0) {
      await client.query('COMMIT');
      return { erasedFields: [], userId: null };
    }

    const userId = userRows[0].id as string;

    const { rows: otherTenantRoles } = await client.query(
      `SELECT id FROM user_roles WHERE user_id = $1 AND tenant_id != $2`,
      [userId, tenantId],
    );

    const hasOtherTenants = otherTenantRoles.length > 0;

    if (!hasOtherTenants) {
      await client.query(
        `UPDATE users SET
           first_name = '[REDACTED]',
           last_name = '[REDACTED]',
           email = CONCAT('erased_', id, '@redacted.local'),
           password_hash = NULL,
           is_active = FALSE,
           updated_at = NOW()
         WHERE id = $1`,
        [userId],
      );
      erasedFields.push('users.first_name', 'users.last_name', 'users.email', 'users.password_hash');
    } else {
      logger.info('User belongs to other tenants, only removing tenant role', { tenantId, userId });
    }

    await client.query(
      `DELETE FROM user_roles WHERE user_id = $1 AND tenant_id = $2`,
      [userId, tenantId],
    );
    erasedFields.push('user_roles');

    try {
      await client.query(
        `DELETE FROM user_invitations WHERE email = $1 AND tenant_id = $2`,
        [userEmail.toLowerCase(), tenantId],
      );
      erasedFields.push('user_invitations');
    } catch {
      logger.warn('Could not erase invitations', { tenantId, userEmail });
    }

    try {
      const { rowCount: callRows } = await client.query(
        `UPDATE call_sessions SET
           caller_number = '[REDACTED]',
           context = jsonb_set(
             jsonb_set(COALESCE(context, '{}'), '{transcript}', '"[REDACTED]"'),
             '{caller_name}', '"[REDACTED]"'
           ),
           updated_at = NOW()
         WHERE tenant_id = $1 AND caller_number IN (
           SELECT DISTINCT cs2.caller_number FROM call_sessions cs2
           JOIN audit_logs al ON al.resource_id = cs2.id AND al.actor_user_id = $2 AND al.tenant_id = $1
           WHERE cs2.tenant_id = $1
         )`,
        [tenantId, userId],
      );
      if (callRows && callRows > 0) {
        erasedFields.push(`call_sessions (${callRows} rows redacted)`);
      }
    } catch {
      logger.warn('Could not erase call session PII', { tenantId, userId });
    }

    try {
      const { rowCount: campaignRows } = await client.query(
        `UPDATE campaign_contacts SET
           phone_number = '[REDACTED]',
           updated_at = NOW()
         WHERE tenant_id = $1 AND phone_number IN (
           SELECT DISTINCT cs.caller_number FROM call_sessions cs
           JOIN audit_logs al ON al.resource_id = cs.id AND al.actor_user_id = $2 AND al.tenant_id = $1
           WHERE cs.tenant_id = $1
         )`,
        [tenantId, userId],
      );
      if (campaignRows && campaignRows > 0) {
        erasedFields.push(`campaign_contacts (${campaignRows} rows redacted)`);
      }
    } catch {
      logger.warn('Could not erase campaign contact PII', { tenantId, userId });
    }

    await client.query('COMMIT');

    logger.info('GDPR erasure completed', { tenantId, userId, erasedFields });
    return { erasedFields, userId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function createGdprRequest(
  tenantId: string,
  requestType: 'export' | 'erasure',
  subjectEmail: string,
  requestedBy: string,
): Promise<string> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `INSERT INTO gdpr_requests (tenant_id, request_type, subject_email, requested_by, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id`,
      [tenantId, requestType, subjectEmail.toLowerCase(), requestedBy],
    );

    await client.query('COMMIT');
    return rows[0].id as string;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function processGdprRequest(requestId: string, tenantId: string): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL row_security = off');

    const { rows } = await client.query(
      `SELECT request_type, subject_email, status FROM gdpr_requests WHERE id = $1 AND tenant_id = $2`,
      [requestId, tenantId],
    );

    if (rows.length === 0) throw new Error('GDPR request not found');
    if (rows[0].status !== 'pending') throw new Error('Request already processed');

    const requestType = rows[0].request_type as string;
    const subjectEmail = rows[0].subject_email as string;

    await client.query(
      `UPDATE gdpr_requests SET status = 'processing' WHERE id = $1`,
      [requestId],
    );
    await client.query('COMMIT');

    try {
      let resultData: Record<string, unknown>;

      if (requestType === 'export') {
        const exportData = await exportUserData(tenantId, subjectEmail);
        resultData = exportData as unknown as Record<string, unknown>;
      } else {
        const eraseResult = await eraseUserData(tenantId, subjectEmail);
        resultData = eraseResult as unknown as Record<string, unknown>;
      }

      await withPrivilegedClient(async (privClient) => {
        await privClient.query(
          `UPDATE gdpr_requests SET status = 'completed', result_data = $1, completed_at = NOW() WHERE id = $2`,
          [JSON.stringify(resultData), requestId],
        );
      });
    } catch (processErr) {
      await withPrivilegedClient(async (privClient) => {
        await privClient.query(
          `UPDATE gdpr_requests SET status = 'failed', result_data = $1 WHERE id = $2`,
          [JSON.stringify({ error: String(processErr) }), requestId],
        );
      });
      throw processErr;
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function completeGdprRequest(
  requestId: string,
  tenantId: string,
  resultData: Record<string, unknown>,
): Promise<void> {
  await withPrivilegedClient(async (privClient) => {
    await privClient.query(
      `UPDATE gdpr_requests SET status = 'completed', result_data = $1, completed_at = NOW()
       WHERE id = $2 AND tenant_id = $3`,
      [JSON.stringify(resultData), requestId, tenantId],
    );
  });
}

export async function listGdprRequests(tenantId: string): Promise<Record<string, unknown>[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT g.id, g.request_type, g.subject_email, g.status, g.completed_at, g.created_at,
              u.email as requested_by_email
       FROM gdpr_requests g
       LEFT JOIN users u ON u.id = g.requested_by
       WHERE g.tenant_id = $1
       ORDER BY g.created_at DESC`,
      [tenantId],
    );

    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
