import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { withPrivilegedClient } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import { runAllIsolationTests } from '../../../platform/security/TenantIsolationService';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';

const router = Router();
const logger = createLogger('PLATFORM_COMPLIANCE');

// ---------- Overview KPIs ----------
router.get('/platform/compliance/overview', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const data = await withPrivilegedClient(async (client) => {
      const { rows: tenantRows } = await client.query(`
        SELECT
          COUNT(*)::int AS total_tenants,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active_tenants,
          COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended_tenants
        FROM tenants
      `);

      const { rows: encRows } = await client.query(`
        SELECT
          COUNT(DISTINCT tenant_id)::int AS encrypted_tenants,
          COUNT(*) FILTER (WHERE is_active = TRUE)::int AS active_keys,
          COUNT(*) FILTER (WHERE rotated_at IS NOT NULL)::int AS rotated_keys,
          MAX(created_at) AS last_key_created_at,
          MAX(rotated_at) AS last_key_rotated_at
        FROM encryption_keys
      `);

      const { rows: subRows } = await client.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE is_active = TRUE)::int AS active
        FROM subprocessors
      `);

      const { rows: delRows } = await client.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
        FROM tenant_deletion_requests
      `);

      const { rows: auditRows } = await client.query(`
        SELECT
          COUNT(*) FILTER (WHERE occurred_at >= NOW() - INTERVAL '24 hours')::int AS last_24h,
          COUNT(*) FILTER (WHERE occurred_at >= NOW() - INTERVAL '7 days')::int AS last_7d,
          COUNT(*) FILTER (WHERE severity = 'critical' AND occurred_at >= NOW() - INTERVAL '7 days')::int AS critical_7d,
          COUNT(*) FILTER (WHERE severity = 'warning' AND occurred_at >= NOW() - INTERVAL '7 days')::int AS warning_7d
        FROM audit_logs
      `);

      const { rows: isoRows } = await client.query(`
        SELECT
          COUNT(*)::int AS total_runs,
          COUNT(*) FILTER (WHERE test_result = 'pass')::int AS passed,
          COUNT(*) FILTER (WHERE test_result = 'fail')::int AS failed,
          MAX(run_at) AS last_run_at
        FROM tenant_isolation_tests
        WHERE run_at >= NOW() - INTERVAL '30 days'
      `);

      const { rows: adminRows } = await client.query(`
        SELECT COUNT(*)::int AS total
        FROM users WHERE is_platform_admin = TRUE
      `);

      return {
        tenants: tenantRows[0],
        encryption: encRows[0],
        subprocessors: subRows[0],
        deletionRequests: delRows[0],
        auditEvents: auditRows[0],
        isolationTests: isoRows[0],
        platformAdmins: adminRows[0],
      };
    });

    return res.json(data);
  } catch (err) {
    logger.error('Failed to load compliance overview', { error: String(err) });
    return res.status(500).json({ error: 'Failed to load compliance overview' });
  }
});

// ---------- Cross-tenant audit log ----------
router.get('/platform/compliance/audit-log', requireAuth, requirePlatformAdmin, async (req, res) => {
  const tenantFilter = (req.query.tenantId as string | undefined)?.trim() || undefined;
  const action = (req.query.action as string | undefined)?.trim() || undefined;
  const severity = (req.query.severity as string | undefined)?.trim() || undefined;
  const since = (req.query.since as string | undefined) || undefined;
  const until = (req.query.until as string | undefined) || undefined;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 200);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  const offset = (page - 1) * limit;

  try {
    const result = await withPrivilegedClient(async (client) => {
      const conditions: string[] = ['1 = 1'];
      const values: unknown[] = [];
      let idx = 1;
      if (tenantFilter) {
        conditions.push(`a.tenant_id = $${idx++}`);
        values.push(tenantFilter);
      }
      if (action) {
        conditions.push(`a.action = $${idx++}`);
        values.push(action);
      }
      if (severity) {
        conditions.push(`a.severity = $${idx++}`);
        values.push(severity);
      }
      if (since) {
        conditions.push(`a.occurred_at >= $${idx++}`);
        values.push(since);
      }
      if (until) {
        conditions.push(`a.occurred_at <= $${idx++}`);
        values.push(until);
      }
      const where = conditions.join(' AND ');

      const { rows } = await client.query(
        `SELECT a.id, a.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug,
                a.action, a.resource_type, a.resource_id,
                a.changes, a.before_state, a.after_state, a.severity,
                a.ip_address, a.occurred_at,
                a.actor_user_id, a.actor_role,
                u.email AS actor_email
         FROM audit_logs a
         LEFT JOIN tenants t ON t.id = a.tenant_id
         LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE ${where}
         ORDER BY a.occurred_at DESC
         LIMIT $${idx++} OFFSET $${idx++}`,
        [...values, limit, offset],
      );

      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS total FROM audit_logs a WHERE ${where}`,
        values,
      );

      return { events: rows, total: countRows[0].total as number };
    });

    return res.json({ ...result, page, limit });
  } catch (err) {
    logger.error('Failed to query platform audit log', { error: String(err) });
    return res.status(500).json({ error: 'Failed to query platform audit log' });
  }
});

router.get('/platform/compliance/audit-log/export', requireAuth, requirePlatformAdmin, async (req, res) => {
  const tenantFilter = (req.query.tenantId as string | undefined)?.trim() || undefined;
  const action = (req.query.action as string | undefined)?.trim() || undefined;
  const severity = (req.query.severity as string | undefined)?.trim() || undefined;
  const since = (req.query.since as string | undefined) || undefined;
  const until = (req.query.until as string | undefined) || undefined;

  try {
    const rows = await withPrivilegedClient(async (client) => {
      const conditions: string[] = ['1 = 1'];
      const values: unknown[] = [];
      let idx = 1;
      if (tenantFilter) { conditions.push(`a.tenant_id = $${idx++}`); values.push(tenantFilter); }
      if (action) { conditions.push(`a.action = $${idx++}`); values.push(action); }
      if (severity) { conditions.push(`a.severity = $${idx++}`); values.push(severity); }
      if (since) { conditions.push(`a.occurred_at >= $${idx++}`); values.push(since); }
      if (until) { conditions.push(`a.occurred_at <= $${idx++}`); values.push(until); }

      const { rows: data } = await client.query(
        `SELECT a.occurred_at, a.tenant_id, t.slug AS tenant_slug, t.name AS tenant_name,
                u.email AS actor_email, a.actor_role, a.action,
                a.resource_type, a.resource_id, a.severity, a.ip_address, a.changes
         FROM audit_logs a
         LEFT JOIN tenants t ON t.id = a.tenant_id
         LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY a.occurred_at DESC
         LIMIT 50000`,
        values,
      );
      return data;
    });

    const escape = (v: unknown): string => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const header = ['Timestamp', 'Tenant ID', 'Tenant Slug', 'Tenant Name', 'Actor Email', 'Actor Role',
      'Action', 'Resource Type', 'Resource ID', 'Severity', 'IP Address', 'Changes'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
        r.tenant_id, r.tenant_slug, r.tenant_name, r.actor_email, r.actor_role,
        r.action, r.resource_type, r.resource_id, r.severity, r.ip_address, r.changes,
      ].map(escape).join(','));
    }

    if (req.user) {
      await writeAuditLog({
        tenantId: req.user.tenantId,
        actorUserId: req.user.userId,
        actorRole: req.user.role,
        action: 'platform.audit_log.exported',
        resourceType: 'platform_audit_log',
        severity: 'info',
        ipAddress: extractIp(req),
        userAgent: req.headers['user-agent'],
        changes: { rowCount: rows.length, filters: { tenantFilter, action, severity, since, until } },
      });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition',
      `attachment; filename="platform-audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(lines.join('\n'));
  } catch (err) {
    logger.error('Failed to export platform audit log', { error: String(err) });
    return res.status(500).json({ error: 'Failed to export platform audit log' });
  }
});

// ---------- Per-tenant encryption status ----------
router.get('/platform/compliance/encryption', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const tenants = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(`
        SELECT
          t.id AS tenant_id,
          t.name AS tenant_name,
          t.slug AS tenant_slug,
          t.status AS tenant_status,
          t.plan,
          COALESCE(k.active_keys, 0)::int AS active_keys,
          COALESCE(k.total_keys, 0)::int AS total_keys,
          k.last_key_created_at,
          k.last_rotation_at,
          COALESCE(f.encrypted_field_count, 0)::int AS encrypted_field_count,
          COALESCE(f.tables, ARRAY[]::text[]) AS encrypted_tables
        FROM tenants t
        LEFT JOIN (
          SELECT tenant_id,
                 COUNT(*) FILTER (WHERE is_active = TRUE) AS active_keys,
                 COUNT(*) AS total_keys,
                 MAX(created_at) AS last_key_created_at,
                 MAX(rotated_at) AS last_rotation_at
          FROM encryption_keys
          GROUP BY tenant_id
        ) k ON k.tenant_id = t.id
        LEFT JOIN (
          SELECT tenant_id,
                 COUNT(*) AS encrypted_field_count,
                 ARRAY_AGG(DISTINCT table_name) AS tables
          FROM encrypted_fields
          GROUP BY tenant_id
        ) f ON f.tenant_id = t.id
        ORDER BY t.created_at DESC
      `);
      return rows;
    });
    return res.json({ tenants });
  } catch (err) {
    logger.error('Failed to query encryption status', { error: String(err) });
    return res.status(500).json({ error: 'Failed to query encryption status' });
  }
});

// ---------- Tenant deletion requests across all tenants ----------
router.get('/platform/compliance/deletion-requests', requireAuth, requirePlatformAdmin, async (req, res) => {
  const status = (req.query.status as string | undefined)?.trim() || undefined;
  try {
    const requests = await withPrivilegedClient(async (client) => {
      const conditions: string[] = ['1 = 1'];
      const values: unknown[] = [];
      let idx = 1;
      if (status) {
        conditions.push(`d.status = $${idx++}`);
        values.push(status);
      }
      const { rows } = await client.query(
        `SELECT d.id, d.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status,
                d.requested_by, ru.email AS requested_by_email,
                d.requested_at, d.scheduled_for, d.cancelled_at, d.status, d.reason,
                d.cancelled_by, cu.email AS cancelled_by_email
         FROM tenant_deletion_requests d
         JOIN tenants t ON t.id = d.tenant_id
         LEFT JOIN users ru ON ru.id = d.requested_by
         LEFT JOIN users cu ON cu.id = d.cancelled_by
         WHERE ${conditions.join(' AND ')}
         ORDER BY d.requested_at DESC
         LIMIT 200`,
        values,
      );
      return rows;
    });
    return res.json({ requests });
  } catch (err) {
    logger.error('Failed to list deletion requests', { error: String(err) });
    return res.status(500).json({ error: 'Failed to list deletion requests' });
  }
});

// ---------- Tenant isolation test results ----------
router.get('/platform/compliance/isolation-tests', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const data = await withPrivilegedClient(async (client) => {
      const { rows: latest } = await client.query(`
        SELECT id, test_name, test_result, details, run_at
        FROM tenant_isolation_tests
        ORDER BY run_at DESC
        LIMIT 100
      `);

      const { rows: summary } = await client.query(`
        SELECT
          COUNT(*) FILTER (WHERE test_result = 'pass')::int AS passed,
          COUNT(*) FILTER (WHERE test_result = 'fail')::int AS failed,
          MAX(run_at) AS last_run_at
        FROM tenant_isolation_tests
        WHERE run_at >= NOW() - INTERVAL '30 days'
      `);

      const { rows: lastRun } = await client.query(`
        SELECT id, test_name, test_result, details, run_at
        FROM tenant_isolation_tests
        WHERE run_at = (SELECT MAX(run_at) FROM tenant_isolation_tests)
      `);

      return { recent: latest, summary: summary[0], lastRun };
    });
    return res.json(data);
  } catch (err) {
    logger.error('Failed to load isolation tests', { error: String(err) });
    return res.status(500).json({ error: 'Failed to load isolation tests' });
  }
});

router.post('/platform/compliance/isolation-tests/run', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { tenantId } = req.user!;
    const result = await runAllIsolationTests(tenantId);

    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'platform.isolation_tests.run',
      resourceType: 'tenant_isolation',
      severity: result.failed > 0 ? 'critical' : 'info',
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
      changes: { passed: result.passed, failed: result.failed },
    });

    return res.json(result);
  } catch (err) {
    logger.error('Failed to run isolation tests', { error: String(err) });
    return res.status(500).json({ error: 'Failed to run isolation tests' });
  }
});

// ---------- Platform admin users ----------
router.get('/platform/compliance/platform-admins', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const admins = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(`
        SELECT u.id, u.email, u.first_name, u.last_name, u.created_at, u.last_login_at,
               COALESCE(role_counts.tenant_count, 0)::int AS tenant_role_count
        FROM users u
        LEFT JOIN (
          SELECT user_id, COUNT(*) AS tenant_count FROM user_roles GROUP BY user_id
        ) role_counts ON role_counts.user_id = u.id
        WHERE u.is_platform_admin = TRUE
        ORDER BY u.email
      `);
      return rows;
    });
    return res.json({ admins });
  } catch (err) {
    logger.error('Failed to list platform admins', { error: String(err) });
    return res.status(500).json({ error: 'Failed to list platform admins' });
  }
});

// ---------- Encrypted-fields aggregate (used to render KPI on Encryption tab) ----------
router.get('/platform/compliance/encrypted-fields', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const data = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(`
        SELECT table_name, COUNT(*)::int AS field_count, COUNT(DISTINCT tenant_id)::int AS tenant_count
        FROM encrypted_fields
        GROUP BY table_name
        ORDER BY field_count DESC
      `);
      return rows;
    });
    return res.json({ fields: data });
  } catch (err) {
    logger.error('Failed to load encrypted fields summary', { error: String(err) });
    return res.status(500).json({ error: 'Failed to load encrypted fields summary' });
  }
});

export default router;
