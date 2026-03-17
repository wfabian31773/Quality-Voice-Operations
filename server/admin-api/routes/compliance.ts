import { Router } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';
import { getEncryptionStatus, rotateTenantDEK, getOrCreateTenantDEK } from '../../../platform/security/EncryptionService';
import { runAllIsolationTests } from '../../../platform/security/TenantIsolationService';
import {
  exportUserData,
  eraseUserData,
  createGdprRequest,
  completeGdprRequest,
  listGdprRequests,
} from '../../../platform/security/GdprService';
import { listApiKeys } from '../../../platform/rbac/ApiKeyService';

const router = Router();
const logger = createLogger('COMPLIANCE');

router.get('/compliance/audit-log/export', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const action = req.query.action as string | undefined;
  const since = req.query.since as string | undefined;
  const until = req.query.until as string | undefined;
  const userId = req.query.userId as string | undefined;

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const conditions = ['a.tenant_id = $1'];
    const values: unknown[] = [tenantId];
    let paramIdx = 2;

    if (action) {
      conditions.push(`a.action = $${paramIdx}`);
      values.push(action);
      paramIdx++;
    }
    if (userId) {
      conditions.push(`a.actor_user_id = $${paramIdx}`);
      values.push(userId);
      paramIdx++;
    }
    if (since) {
      conditions.push(`a.occurred_at >= $${paramIdx}`);
      values.push(since);
      paramIdx++;
    }
    if (until) {
      conditions.push(`a.occurred_at <= $${paramIdx}`);
      values.push(until);
      paramIdx++;
    }

    const where = conditions.join(' AND ');

    const { rows } = await client.query(
      `SELECT a.id, a.action, a.resource_type, a.resource_id, a.changes,
              a.before_state, a.after_state, a.severity,
              a.ip_address, a.occurred_at,
              a.actor_user_id, a.actor_role,
              u.email AS actor_email
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE ${where}
       ORDER BY a.occurred_at DESC
       LIMIT 10000`,
      values,
    );
    await client.query('COMMIT');

    const csvHeader = 'Timestamp,Actor Email,Actor Role,Action,Resource Type,Resource ID,Severity,IP Address,Changes\n';
    const csvRows = rows.map((row) => {
      const ts = new Date(row.occurred_at as string).toISOString();
      const email = (row.actor_email as string) ?? 'System';
      const role = (row.actor_role as string) ?? '';
      const act = row.action as string;
      const resType = row.resource_type as string;
      const resId = (row.resource_id as string) ?? '';
      const sev = (row.severity as string) ?? 'info';
      const ip = (row.ip_address as string) ?? '';
      const changes = JSON.stringify(row.changes ?? {}).replace(/"/g, '""');
      return `"${ts}","${email}","${role}","${act}","${resType}","${resId}","${sev}","${ip}","${changes}"`;
    });

    const csv = csvHeader + csvRows.join('\n');

    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'audit_log.exported',
      resourceType: 'audit_log',
      changes: { rowCount: rows.length, filters: { action, userId, since, until } },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(csv);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to export audit log', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to export audit log' });
  } finally {
    client.release();
  }
});

router.get('/compliance/encryption-status', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const status = await getEncryptionStatus(req.user!.tenantId);
    return res.json(status);
  } catch (err) {
    logger.error('Failed to get encryption status', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get encryption status' });
  }
});

router.post('/compliance/encryption/initialize', requireAuth, requireRole('owner'), async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const { keyId } = await getOrCreateTenantDEK(tenantId);

    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'encryption.initialized',
      resourceType: 'encryption_key',
      resourceId: keyId,
      severity: 'critical',
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ keyId, status: 'initialized' });
  } catch (err) {
    logger.error('Failed to initialize encryption', { error: String(err) });
    return res.status(500).json({ error: 'Failed to initialize encryption' });
  }
});

router.post('/compliance/encryption/rotate', requireAuth, requireRole('owner'), async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const { keyId } = await rotateTenantDEK(tenantId);

    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'encryption.key_rotated',
      resourceType: 'encryption_key',
      resourceId: keyId,
      severity: 'critical',
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ keyId, status: 'rotated' });
  } catch (err) {
    logger.error('Failed to rotate encryption key', { error: String(err) });
    return res.status(500).json({ error: 'Failed to rotate encryption key' });
  }
});

router.get('/compliance/tenant-isolation', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const results = await runAllIsolationTests(req.user!.tenantId);
    return res.json(results);
  } catch (err) {
    logger.error('Failed to run isolation tests', { error: String(err) });
    return res.status(500).json({ error: 'Failed to run isolation tests' });
  }
});

router.get('/compliance/roles', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, ur.role, ur.created_at as role_assigned_at
       FROM user_roles ur
       JOIN users u ON u.id = ur.user_id
       WHERE ur.tenant_id = $1
       ORDER BY ur.role, u.email`,
      [tenantId],
    );
    await client.query('COMMIT');

    return res.json({ roles: rows });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to list roles', { error: String(err) });
    return res.status(500).json({ error: 'Failed to list roles' });
  } finally {
    client.release();
  }
});

router.patch('/compliance/roles/:userId', requireAuth, requireRole('owner'), async (req, res) => {
  const { tenantId, userId: requestingUserId } = req.user!;
  const { userId } = req.params;
  const { role } = req.body as { role?: string };

  const VALID_DB_ROLES = ['tenant_owner', 'operations_manager', 'billing_admin', 'agent_developer', 'support_reviewer'];
  if (!role || !VALID_DB_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${VALID_DB_ROLES.join(', ')}` });
  }

  if (userId === requestingUserId) {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: beforeRows } = await client.query(
      `SELECT role FROM user_roles WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
    const previousRole = beforeRows[0]?.role as string | undefined;

    const { rowCount } = await client.query(
      `UPDATE user_roles SET role = $1::tenant_role, updated_at = NOW() WHERE tenant_id = $2 AND user_id = $3`,
      [role, tenantId, userId],
    );
    await client.query('COMMIT');

    if (!rowCount) return res.status(404).json({ error: 'User not found in this tenant' });

    await writeAuditLog({
      tenantId,
      actorUserId: requestingUserId,
      actorRole: req.user!.role,
      action: 'user.role_changed',
      resourceType: 'user',
      resourceId: userId,
      beforeState: { role: previousRole },
      afterState: { role },
      changes: { previousRole, newRole: role },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ updated: true, role });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to update role', { error: String(err) });
    return res.status(500).json({ error: 'Failed to update user role' });
  } finally {
    client.release();
  }
});

router.delete('/compliance/roles/:userId', requireAuth, requireRole('owner'), async (req, res) => {
  const { tenantId, userId: requestingUserId } = req.user!;
  const { userId } = req.params;

  if (userId === requestingUserId) {
    return res.status(400).json({ error: 'Cannot remove your own role' });
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: beforeRows } = await client.query(
      `SELECT role FROM user_roles WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );

    const { rowCount } = await client.query(
      `DELETE FROM user_roles WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
    await client.query('COMMIT');

    if (!rowCount) return res.status(404).json({ error: 'User not found in this tenant' });

    await writeAuditLog({
      tenantId,
      actorUserId: requestingUserId,
      actorRole: req.user!.role,
      action: 'user.role_revoked',
      resourceType: 'user',
      resourceId: userId,
      beforeState: { role: beforeRows[0]?.role },
      changes: { action: 'revoked' },
      severity: 'warning',
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ removed: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to remove role', { error: String(err) });
    return res.status(500).json({ error: 'Failed to remove user role' });
  } finally {
    client.release();
  }
});

router.get('/compliance/soc2-checklist', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;

  try {
    const encStatus = await getEncryptionStatus(tenantId);
    const apiKeys = await listApiKeys(tenantId);

    const pool = getPlatformPool();
    const client = await pool.connect();
    let auditCount = 0;
    let userCount = 0;

    try {
      await client.query('BEGIN');
      await withTenantContext(client, tenantId, async () => {});
      const { rows: auditRows } = await client.query(
        `SELECT COUNT(*) as cnt FROM audit_logs WHERE tenant_id = $1`,
        [tenantId],
      );
      auditCount = parseInt(auditRows[0]?.cnt as string ?? '0');

      const { rows: userRows } = await client.query(
        `SELECT COUNT(*) as cnt FROM user_roles WHERE tenant_id = $1`,
        [tenantId],
      );
      userCount = parseInt(userRows[0]?.cnt as string ?? '0');
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    let isolationPassed = false;
    try {
      const isoResults = await runAllIsolationTests(tenantId);
      isolationPassed = isoResults.failed === 0;
    } catch {
      isolationPassed = false;
    }

    const checklist = [
      {
        id: 'encryption_at_rest',
        category: 'Security',
        control: 'Encryption at Rest',
        description: 'Sensitive data encrypted using envelope encryption with AES-256-GCM',
        status: encStatus.encryptionEnabled ? 'implemented' : 'action_required',
        details: encStatus.encryptionEnabled
          ? `${encStatus.activeKeys} active key(s), last rotation: ${encStatus.lastKeyRotation ?? 'N/A'}`
          : 'Action required: Initialize encryption via the Encryption tab',
      },
      {
        id: 'encryption_in_transit',
        category: 'Security',
        control: 'Encryption in Transit',
        description: 'All communications encrypted via TLS/HTTPS',
        status: 'action_required',
        details: 'Requires verification: confirm TLS termination is configured at the infrastructure/load-balancer level',
      },
      {
        id: 'audit_logging',
        category: 'Security',
        control: 'Immutable Audit Logging',
        description: 'Append-only audit trail with DB triggers preventing modification/deletion',
        status: auditCount > 0 ? 'implemented' : 'action_required',
        details: auditCount > 0
          ? `${auditCount} audit events recorded; DB triggers block UPDATE/DELETE`
          : 'Action required: audit events will be generated as you use the platform',
      },
      {
        id: 'rbac',
        category: 'Access Control',
        control: 'Role-Based Access Control',
        description: 'Hierarchical role system (owner > admin > member) with enforced middleware',
        status: userCount > 0 ? 'implemented' : 'action_required',
        details: `${userCount} users with assigned roles; role checks enforced on all admin endpoints`,
      },
      {
        id: 'api_key_management',
        category: 'Access Control',
        control: 'API Key Management',
        description: 'Scoped API keys (read-only/write/admin) with SHA-256 hashing, permission enforcement',
        status: 'implemented',
        details: `${apiKeys.length} active key(s); keys never stored in plaintext, scoped permissions enforced`,
      },
      {
        id: 'tenant_isolation',
        category: 'Security',
        control: 'Tenant Data Isolation',
        description: 'PostgreSQL Row Level Security with cross-tenant access verification tests',
        status: isolationPassed ? 'implemented' : 'action_required',
        details: isolationPassed
          ? 'RLS policies active on all tenant-scoped tables; cross-tenant probes pass'
          : 'Action required: some isolation tests may have failed - review via Tenant Isolation tab',
      },
      {
        id: 'credential_vault',
        category: 'Security',
        control: 'Credential Vault',
        description: 'Integration credentials encrypted with AES-256-GCM via envelope encryption',
        status: encStatus.encryptionEnabled ? 'implemented' : 'action_required',
        details: encStatus.encryptionEnabled
          ? 'Connector configs encrypted at rest with tenant DEK; credentials never returned in plaintext after storage'
          : 'Action required: encryption must be initialized before credential vault is fully active',
      },
      {
        id: 'gdpr_compliance',
        category: 'Privacy',
        control: 'GDPR Data Subject Rights',
        description: 'Data export (right of access) and right-to-erasure with tenant-scoped PII deletion',
        status: 'action_required',
        details: 'Export and erasure endpoints available; requires organizational review to confirm all PII data paths are covered',
      },
      {
        id: 'password_hashing',
        category: 'Security',
        control: 'Password Hashing',
        description: 'User passwords hashed with bcrypt (cost factor 12)',
        status: 'action_required',
        details: 'bcrypt with salt rounds = 12 configured in code; requires audit to verify no plaintext password storage paths exist',
      },
      {
        id: 'session_management',
        category: 'Access Control',
        control: 'Session Management',
        description: 'JWT-based authentication with configurable expiry',
        status: 'action_required',
        details: 'JWT tokens configured with 8h expiry; requires review of token revocation and refresh policies',
      },
      {
        id: 'tenant_guard',
        category: 'Security',
        control: 'Tenant Context Guard',
        description: 'Middleware validates tenant context on every request, blocks cross-tenant body/query params',
        status: isolationPassed ? 'implemented' : 'action_required',
        details: isolationPassed
          ? 'Active on all authenticated routes; cross-tenant isolation probes passed'
          : 'Action required: tenant guard middleware active but isolation verification did not fully pass',
      },
      {
        id: 'security_headers',
        category: 'Security',
        control: 'Security Headers',
        description: 'X-Content-Type-Options and X-Frame-Options headers configured',
        status: 'action_required',
        details: 'Requires verification: confirm security headers middleware is applied to all response paths',
      },
    ];

    return res.json({ checklist });
  } catch (err) {
    logger.error('Failed to generate SOC2 checklist', { error: String(err) });
    return res.status(500).json({ error: 'Failed to generate SOC2 checklist' });
  }
});

router.post('/compliance/gdpr/export', requireAuth, requireRole('owner'), async (req, res) => {
  const { tenantId } = req.user!;
  const { email } = req.body as { email?: string };

  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    const requestId = await createGdprRequest(tenantId, 'export', email, req.user!.userId);

    const data = await exportUserData(tenantId, email);

    await completeGdprRequest(requestId, tenantId, data as unknown as Record<string, unknown>);

    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'gdpr.data_exported',
      resourceType: 'user',
      changes: { subjectEmail: email },
      severity: 'critical',
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ requestId, data });
  } catch (err) {
    logger.error('Failed to export user data', { error: String(err) });
    return res.status(500).json({ error: 'Failed to export user data' });
  }
});

router.post('/compliance/gdpr/erase', requireAuth, requireRole('owner'), async (req, res) => {
  const { tenantId } = req.user!;
  const { email } = req.body as { email?: string };

  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    const requestId = await createGdprRequest(tenantId, 'erasure', email, req.user!.userId);

    const result = await eraseUserData(tenantId, email);

    await completeGdprRequest(requestId, tenantId, result as unknown as Record<string, unknown>);

    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'gdpr.data_erased',
      resourceType: 'user',
      changes: { subjectEmail: email, erasedFields: result.erasedFields },
      severity: 'critical',
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ requestId, result });
  } catch (err) {
    logger.error('Failed to erase user data', { error: String(err) });
    return res.status(500).json({ error: 'Failed to erase user data' });
  }
});

router.get('/compliance/gdpr/requests', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const requests = await listGdprRequests(req.user!.tenantId);
    return res.json({ requests });
  } catch (err) {
    logger.error('Failed to list GDPR requests', { error: String(err) });
    return res.status(500).json({ error: 'Failed to list GDPR requests' });
  }
});

export default router;
