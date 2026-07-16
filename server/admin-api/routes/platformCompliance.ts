import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { withPrivilegedClient } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import { runAllIsolationTests } from '../../../platform/security/TenantIsolationService';
import { getOrCreateTenantDEK } from '../../../platform/security/EncryptionService';
import { getTenantIsolationSchedulerStatus } from '../../../platform/security/TenantIsolationScheduler';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';
import {
  getFederalDncSyncState,
  runFederalDncSyncCycle,
} from '../../../platform/campaigns';
import { sendEmail } from '../../../platform/email/EmailService';
import { encryptionInitializationReminderEmail } from '../../../platform/email/templates';
import {
  HEALTHCARE_APPROVAL_EVIDENCE_KEYS,
  SYNTHETIC_APPROVAL_EVIDENCE_KEYS,
  isHealthcareReceptionistIdentity,
} from '../../../shared/compliance/healthcareDeploymentApproval';
import { createPiiLookupHash, normalizeLookupPhone } from '../../../platform/security/PiiLookupHash';
import {
  MASTER_VOICE_AGENT_CORE_VERSION,
  MASTER_VOICE_AGENT_MODEL,
} from '../../../platform/agent-runtime/masterVoiceAgent';
import { HEALTHCARE_RECEPTIONIST_ROLE_VERSION } from '../../../platform/agent-templates/healthcare-receptionist';
import { verifyHealthcareControlEvidenceRefs } from '../../../platform/compliance/HealthcareControlEvidenceService';
import { verifyHealthcareActivationReadinessRef } from '../../../platform/compliance/HealthcareActivationReadinessService';
import {
  HEALTHCARE_ACTIVATION_CATALOG_COUNT,
  HEALTHCARE_ACTIVATION_CATALOG_VERSION,
  HEALTHCARE_ACTIVATION_EVIDENCE_CONTROL_COUNT,
} from '../../../shared/compliance/healthcareActivationReadiness';
import { HEALTHCARE_EVIDENCE_OWNER_ROLES } from '../../../shared/compliance/healthcareControlEvidence';
import { calculateHealthcareReadinessPreflightSha256 } from '../../../platform/compliance/HealthcareDataControlPreflight';

const router = Router();
const logger = createLogger('PLATFORM_COMPLIANCE');

const ENCRYPTION_REMINDER_ACTION = 'platform.encryption.reminder_sent';
const ENCRYPTION_INITIALIZE_ACTION = 'platform.encryption.initialized_by_admin';

const approvalEvidenceRefSchema = z.string().trim().min(3).max(500).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/,
  'Evidence references must be bounded identifiers or non-secret paths',
);
const approvalCreateSchema = z.object({
  tenantId: z.string().trim().min(1).max(255),
  agentId: z.string().trim().min(1).max(255),
  approvalKind: z.enum(['synthetic_test', 'production_healthcare']),
  expiresAt: z.string().datetime({ offset: true }),
  evidenceRefs: z.record(approvalEvidenceRefSchema),
  syntheticCallerNumbers: z.array(z.string().min(8).max(30)).min(1).max(10).optional(),
  readinessRef: z.string().regex(/^har_[a-f0-9]{3,36}$/).optional(),
}).strict();
const approvalRevokeSchema = z.object({
  reason: z.string().trim().min(3).max(500),
}).strict();
const evidenceArtifactLocatorSchema = z.string().trim().min(8).max(500).refine((value) => {
  try {
    const parsed = new URL(value);
    return ['vault:', 'grc:', 's3:', 'https:'].includes(parsed.protocol)
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === '';
  } catch {
    return false;
  }
}, 'Artifact locator must be an approved secret-free URI without query parameters or fragments');
const evidenceCreateSchema = z.object({
  tenantId: z.string().trim().min(1).max(255),
  agentId: z.string().trim().min(1).max(255),
  environment: z.enum(['staging', 'production']),
  controlKey: z.enum(HEALTHCARE_APPROVAL_EVIDENCE_KEYS),
  artifactLocator: evidenceArtifactLocatorSchema,
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  ownerRole: z.enum(['compliance', 'infrastructure', 'product_safety', 'pilot_customer']),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
const evidenceRevokeSchema = z.object({
  reason: z.string().trim().min(3).max(500),
}).strict();
const readinessPreflightSchema = z.object({
  overallStatus: z.literal('pass'),
  catalogVersion: z.literal(HEALTHCARE_ACTIVATION_CATALOG_VERSION),
  catalogCount: z.literal(HEALTHCARE_ACTIVATION_CATALOG_COUNT),
  discoveredCount: z.literal(HEALTHCARE_ACTIVATION_CATALOG_COUNT),
  tenantTableCount: z.literal(HEALTHCARE_ACTIVATION_CATALOG_COUNT),
  rlsEnabledCount: z.literal(HEALTHCARE_ACTIVATION_CATALOG_COUNT),
  verifiedControlCount: z.literal(HEALTHCARE_ACTIVATION_EVIDENCE_CONTROL_COUNT),
  callerMissingCount: z.literal(0),
  callerStaleCount: z.literal(0),
  migrationStatus: z.literal('pass'),
  schemaStatus: z.literal('pass'),
  databaseStatus: z.literal('pass'),
  keyringStatus: z.literal('pass'),
  evidenceStatus: z.literal('pass'),
  callerHashStatus: z.literal('pass'),
  retentionStatus: z.literal('pass'),
  deletionStatus: z.literal('pass'),
  preflightSha256: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  retentionPlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
  deletionEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const readinessCreateSchema = z.object({
  tenantId: z.string().trim().min(1).max(255),
  agentId: z.string().trim().min(1).max(255),
  targetEnvironment: z.enum(['production_equivalent', 'production']),
  expiresAt: z.string().datetime({ offset: true }),
  preflight: readinessPreflightSchema,
}).strict();
const readinessRevokeSchema = z.object({
  reason: z.string().trim().min(3).max(500),
}).strict();

function hasRequiredEvidence(
  evidence: Record<string, string>,
  required: readonly string[],
): boolean {
  const allowed = new Set<string>([
    ...HEALTHCARE_APPROVAL_EVIDENCE_KEYS,
    ...SYNTHETIC_APPROVAL_EVIDENCE_KEYS,
  ]);
  return Object.keys(evidence).every((key) => allowed.has(key))
    && required.every((key) => typeof evidence[key] === 'string');
}

function approvalResponse(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    agentId: String(row.agent_id),
    approvalKind: String(row.approval_kind),
    coreVersion: String(row.core_version),
    model: String(row.model),
    rolePackageId: String(row.role_package_id),
    rolePackageVersion: String(row.role_package_version),
    recordingPolicy: String(row.recording_policy),
    approvedBy: String(row.approved_by),
    approvedAt: row.approved_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? null,
    syntheticCallerCount: Number(row.synthetic_caller_count ?? 0),
    readinessRef: row.readiness_ref ? String(row.readiness_ref) : null,
  };
}

function evidenceResponse(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    evidenceRef: String(row.evidence_ref),
    tenantId: String(row.tenant_id),
    agentId: String(row.agent_id),
    environment: String(row.environment),
    controlKey: String(row.control_key),
    artifactSha256: String(row.artifact_sha256),
    ownerRole: String(row.owner_role),
    status: String(row.status),
    submittedBy: String(row.submitted_by),
    submittedAt: row.submitted_at,
    verifiedBy: row.verified_by ? String(row.verified_by) : null,
    verifiedAt: row.verified_at ?? null,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? null,
  };
}

function readinessResponse(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    readinessRef: String(row.readiness_ref),
    tenantId: String(row.tenant_id),
    agentId: String(row.agent_id),
    targetEnvironment: String(row.target_environment),
    coreVersion: String(row.core_version),
    model: String(row.model),
    rolePackageId: String(row.role_package_id),
    rolePackageVersion: String(row.role_package_version),
    recordingPolicy: String(row.recording_policy),
    catalogVersion: String(row.catalog_version),
    catalogCount: Number(row.catalog_count),
    discoveredCount: Number(row.discovered_count),
    tenantTableCount: Number(row.tenant_table_count),
    rlsEnabledCount: Number(row.rls_enabled_count),
    verifiedControlCount: Number(row.verified_control_count),
    callerMissingCount: Number(row.caller_missing_count),
    callerStaleCount: Number(row.caller_stale_count),
    status: String(row.status),
    submittedBy: String(row.submitted_by),
    submittedAt: row.submitted_at,
    verifiedBy: row.verified_by ? String(row.verified_by) : null,
    verifiedAt: row.verified_at ?? null,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? null,
  };
}

function getAppBaseUrl(): string {
  return (
    process.env.APP_URL ??
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : '')
  );
}

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
      const { rows } = await client.query(
        `
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
          COALESCE(f.tables, ARRAY[]::text[]) AS encrypted_tables,
          o.owner_user_id,
          o.owner_email,
          o.owner_first_name,
          o.owner_last_name,
          r.last_reminded_at,
          r.last_reminded_by_email,
          COALESCE(t.encryption_reminder_paused, FALSE) AS encryption_reminder_paused,
          t.encryption_reminder_paused_at,
          t.encryption_reminder_paused_reason,
          pu.email AS encryption_reminder_paused_by_email
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
        LEFT JOIN LATERAL (
          SELECT ur.user_id AS owner_user_id,
                 u.email AS owner_email,
                 u.first_name AS owner_first_name,
                 u.last_name AS owner_last_name
          FROM user_roles ur
          JOIN users u ON u.id = ur.user_id
          WHERE ur.tenant_id = t.id
            AND ur.role = 'tenant_owner'
            AND u.is_active = TRUE
          ORDER BY ur.created_at ASC
          LIMIT 1
        ) o ON TRUE
        LEFT JOIN LATERAL (
          SELECT MAX(a.occurred_at) AS last_reminded_at,
                 (ARRAY_AGG(au.email ORDER BY a.occurred_at DESC))[1] AS last_reminded_by_email
          FROM audit_logs a
          LEFT JOIN users au ON au.id = a.actor_user_id
          WHERE a.tenant_id = t.id AND a.action = $1
        ) r ON TRUE
        LEFT JOIN users pu ON pu.id = t.encryption_reminder_paused_by_user_id
        ORDER BY
          (COALESCE(k.active_keys, 0) = 0) DESC,
          t.created_at DESC
      `,
        [ENCRYPTION_REMINDER_ACTION],
      );
      return rows;
    });

    const summary = tenants.reduce<{
      total: number;
      needs_initialization: number;
      with_active_keys: number;
    }>(
      (acc, t) => {
        acc.total += 1;
        if (((t.active_keys as number) ?? 0) === 0) acc.needs_initialization += 1;
        else acc.with_active_keys += 1;
        return acc;
      },
      { total: 0, needs_initialization: 0, with_active_keys: 0 },
    );

    return res.json({ tenants, summary });
  } catch (err) {
    logger.error('Failed to query encryption status', { error: String(err) });
    return res.status(500).json({ error: 'Failed to query encryption status' });
  }
});

// ---------- Send templated reminder to a tenant owner ----------
router.post(
  '/platform/compliance/encryption/remind/:tenantId',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const targetTenantId = String(req.params.tenantId ?? '').trim();
    if (!targetTenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    try {
      const context = await withPrivilegedClient(async (client) => {
        const { rows: tenantRows } = await client.query(
          `SELECT id, name, slug FROM tenants WHERE id = $1`,
          [targetTenantId],
        );
        if (tenantRows.length === 0) return null;

        const { rows: keyRows } = await client.query(
          `SELECT COUNT(*)::int AS active_keys
           FROM encryption_keys
           WHERE tenant_id = $1 AND is_active = TRUE`,
          [targetTenantId],
        );

        const { rows: ownerRows } = await client.query(
          `SELECT u.id, u.email, u.first_name, u.last_name
           FROM user_roles ur
           JOIN users u ON u.id = ur.user_id
           WHERE ur.tenant_id = $1 AND ur.role = 'tenant_owner' AND u.is_active = TRUE
           ORDER BY ur.created_at ASC
           LIMIT 1`,
          [targetTenantId],
        );

        return {
          tenant: tenantRows[0],
          activeKeys: (keyRows[0]?.active_keys as number) ?? 0,
          owner: ownerRows[0] ?? null,
        };
      });

      if (!context) {
        return res.status(404).json({ error: 'Tenant not found' });
      }
      if (context.activeKeys > 0) {
        return res.status(409).json({
          error: 'Tenant already has an active encryption key — no reminder needed.',
        });
      }
      if (!context.owner || !context.owner.email) {
        return res.status(409).json({
          error: 'No active tenant owner is on file for this tenant — cannot send a reminder.',
        });
      }

      const tenantName = (context.tenant.name as string) ?? 'your organization';
      const ownerEmail = context.owner.email as string;
      const ownerFirst = (context.owner.first_name as string | null) ?? null;
      const ownerLast = (context.owner.last_name as string | null) ?? null;
      const ownerDisplay = [ownerFirst, ownerLast].filter(Boolean).join(' ').trim() || null;

      const baseUrl = getAppBaseUrl();
      if (!baseUrl) {
        logger.error('Cannot send encryption reminder: no absolute app URL configured', {
          targetTenantId,
        });
        return res.status(500).json({
          error:
            'Server is missing APP_URL (or REPLIT_DEV_DOMAIN). Configure one before sending reminder emails so the link is clickable.',
        });
      }
      const initializeUrl = `${baseUrl.replace(/\/$/, '')}/compliance`;

      const senderName = req.user?.email ?? 'The Quality Voice Operations team';

      const message = encryptionInitializationReminderEmail({
        tenantName,
        ownerName: ownerDisplay,
        initializeUrl,
        senderName,
      });

      const result = await sendEmail({
        to: ownerEmail,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });

      if (!result.success) {
        logger.error('Failed to deliver encryption reminder email', {
          targetTenantId,
          ownerEmail,
          error: result.error,
        });
        return res.status(502).json({
          error: result.error ?? 'Failed to deliver reminder email',
        });
      }

      await writeAuditLog({
        tenantId: targetTenantId,
        actorUserId: req.user!.userId,
        actorRole: req.user!.role,
        action: ENCRYPTION_REMINDER_ACTION,
        resourceType: 'tenant',
        resourceId: targetTenantId,
        severity: 'info',
        ipAddress: extractIp(req),
        userAgent: req.headers['user-agent'],
        changes: {
          ownerEmail,
          ownerUserId: context.owner.id as string,
          tenantName,
          messageId: result.messageId ?? null,
          sentBy: req.user?.email ?? null,
        },
      });

      return res.json({
        sent: true,
        ownerEmail,
        sentAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.error('Failed to send encryption reminder', {
        targetTenantId,
        error: String(err),
      });
      return res.status(500).json({ error: 'Failed to send encryption reminder' });
    }
  },
);

// ---------- Pause / resume the automated encryption reminder cadence ----------
//
// The recurring nudge (see `platform/security/EncryptionReminderScheduler.ts`)
// re-emails the tenant owner every N days while their tenant still has zero
// active encryption keys. Some tenants legitimately can't enable encryption
// yet (regulated migration, paused integration, etc.) so platform admins can
// park the automated cadence per-tenant from the Encryption tab. The manual
// "Send reminder" button above is intentionally NOT gated by this flag —
// pausing only suppresses the scheduler.
router.patch(
  '/platform/compliance/encryption/pause/:tenantId',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const targetTenantId = String(req.params.tenantId ?? '').trim();
    if (!targetTenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const body = (req.body ?? {}) as { paused?: unknown; reason?: unknown };
    if (typeof body.paused !== 'boolean') {
      return res.status(400).json({ error: '`paused` (boolean) is required' });
    }
    const paused = body.paused;
    const reason =
      typeof body.reason === 'string' && body.reason.trim().length > 0
        ? body.reason.trim().slice(0, 500)
        : null;

    try {
      const result = await withPrivilegedClient(async (client) => {
        const { rows: tenantRows } = await client.query(
          `SELECT id, name, COALESCE(encryption_reminder_paused, FALSE) AS was_paused
           FROM tenants WHERE id = $1`,
          [targetTenantId],
        );
        if (tenantRows.length === 0) return null;

        const wasPaused = tenantRows[0].was_paused as boolean;

        const { rows: updated } = await client.query(
          `UPDATE tenants
              SET encryption_reminder_paused = $2,
                  encryption_reminder_paused_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
                  encryption_reminder_paused_by_user_id = CASE WHEN $2 THEN $3 ELSE NULL END,
                  encryption_reminder_paused_reason = CASE WHEN $2 THEN $4 ELSE NULL END
            WHERE id = $1
            RETURNING encryption_reminder_paused,
                      encryption_reminder_paused_at,
                      encryption_reminder_paused_reason`,
          [targetTenantId, paused, req.user!.userId, reason],
        );

        return {
          tenantName: tenantRows[0].name as string,
          wasPaused,
          row: updated[0],
        };
      });

      if (!result) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      // Only audit when the value actually changed so re-clicking the same
      // toggle from the UI doesn't spam the audit feed.
      if (result.wasPaused !== paused) {
        await writeAuditLog({
          tenantId: targetTenantId,
          actorUserId: req.user!.userId,
          actorRole: req.user!.role,
          action: paused
            ? 'platform.encryption.reminder_paused'
            : 'platform.encryption.reminder_resumed',
          resourceType: 'tenant',
          resourceId: targetTenantId,
          severity: 'info',
          ipAddress: extractIp(req),
          userAgent: req.headers['user-agent'],
          changes: {
            tenantName: result.tenantName,
            paused,
            reason,
            toggledBy: req.user?.email ?? null,
          },
        });
      }

      return res.json({
        tenantId: targetTenantId,
        paused: result.row.encryption_reminder_paused as boolean,
        pausedAt: result.row.encryption_reminder_paused_at ?? null,
        reason: result.row.encryption_reminder_paused_reason ?? null,
      });
    } catch (err) {
      logger.error('Failed to toggle encryption reminder pause', {
        targetTenantId,
        paused,
        error: String(err),
      });
      return res
        .status(500)
        .json({ error: 'Failed to update encryption reminder pause flag' });
    }
  },
);

// ---------- Initialize encryption on a tenant's behalf ----------
router.post(
  '/platform/compliance/encryption/initialize/:tenantId',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const targetTenantId = String(req.params.tenantId ?? '').trim();
    if (!targetTenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    try {
      const tenant = await withPrivilegedClient(async (client) => {
        const { rows } = await client.query(
          `SELECT id, name, slug FROM tenants WHERE id = $1`,
          [targetTenantId],
        );
        return rows[0] ?? null;
      });

      if (!tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const existing = await withPrivilegedClient(async (client) => {
        const { rows } = await client.query(
          `SELECT COUNT(*)::int AS active_keys
           FROM encryption_keys
           WHERE tenant_id = $1 AND is_active = TRUE`,
          [targetTenantId],
        );
        return (rows[0]?.active_keys as number) ?? 0;
      });

      if (existing > 0) {
        return res.status(409).json({
          error: 'Tenant already has an active encryption key.',
        });
      }

      const { keyId } = await getOrCreateTenantDEK(targetTenantId);

      await writeAuditLog({
        tenantId: targetTenantId,
        actorUserId: req.user!.userId,
        actorRole: req.user!.role,
        action: ENCRYPTION_INITIALIZE_ACTION,
        resourceType: 'encryption_key',
        resourceId: keyId,
        severity: 'critical',
        ipAddress: extractIp(req),
        userAgent: req.headers['user-agent'],
        changes: {
          initiatedByPlatformAdmin: true,
          adminEmail: req.user?.email ?? null,
          tenantName: tenant.name as string,
        },
      });

      return res.json({ keyId, status: 'initialized' });
    } catch (err) {
      logger.error('Failed to initialize encryption for tenant', {
        targetTenantId,
        error: String(err),
      });
      return res.status(500).json({ error: 'Failed to initialize encryption' });
    }
  },
);

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
        `SELECT d.id, d.tenant_id, d.tenant_fingerprint,
                t.name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status,
                d.requested_by, ru.email AS requested_by_email,
                d.requested_at, d.scheduled_for, d.cancelled_at, d.status, d.reason,
                d.cancelled_by, cu.email AS cancelled_by_email,
                d.first_party_verification, d.external_deletion_evidence, d.completed_at
         FROM tenant_deletion_requests d
         LEFT JOIN tenants t ON t.id = d.tenant_id
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
        SELECT id, test_name, test_result, details, run_at,
               COALESCE(source, 'manual') AS source, run_id
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
        WITH last_marker AS (
          SELECT run_id, run_at
          FROM tenant_isolation_tests
          ORDER BY run_at DESC
          LIMIT 1
        )
        SELECT t.id, t.test_name, t.test_result, t.details, t.run_at,
               COALESCE(t.source, 'manual') AS source, t.run_id
        FROM tenant_isolation_tests t
        JOIN last_marker l ON
          (l.run_id IS NOT NULL AND t.run_id = l.run_id)
          OR (l.run_id IS NULL AND t.run_at = l.run_at)
        ORDER BY t.run_at DESC
      `);

      const { rows: lastBySource } = await client.query(`
        SELECT
          MAX(run_at) FILTER (WHERE COALESCE(source, 'manual') = 'scheduled') AS last_scheduled_run_at,
          MAX(run_at) FILTER (WHERE COALESCE(source, 'manual') = 'manual') AS last_manual_run_at
        FROM tenant_isolation_tests
      `);

      const { rows: lastScheduledRun } = await client.query(`
        WITH last_marker AS (
          SELECT run_id, run_at
          FROM tenant_isolation_tests
          WHERE COALESCE(source, 'manual') = 'scheduled'
          ORDER BY run_at DESC
          LIMIT 1
        )
        SELECT
          COUNT(*) FILTER (WHERE t.test_result = 'pass')::int AS passed,
          COUNT(*) FILTER (WHERE t.test_result = 'fail')::int AS failed,
          MAX(t.run_at) AS run_at,
          l.run_id AS run_id
        FROM tenant_isolation_tests t
        JOIN last_marker l ON
          (l.run_id IS NOT NULL AND t.run_id = l.run_id)
          OR (l.run_id IS NULL AND t.run_at = l.run_at)
        WHERE COALESCE(t.source, 'manual') = 'scheduled'
        GROUP BY l.run_id
      `);

      const { rows: lastManualRun } = await client.query(`
        WITH last_marker AS (
          SELECT run_id, run_at
          FROM tenant_isolation_tests
          WHERE COALESCE(source, 'manual') = 'manual'
          ORDER BY run_at DESC
          LIMIT 1
        )
        SELECT
          COUNT(*) FILTER (WHERE t.test_result = 'pass')::int AS passed,
          COUNT(*) FILTER (WHERE t.test_result = 'fail')::int AS failed,
          MAX(t.run_at) AS run_at,
          l.run_id AS run_id
        FROM tenant_isolation_tests t
        JOIN last_marker l ON
          (l.run_id IS NOT NULL AND t.run_id = l.run_id)
          OR (l.run_id IS NULL AND t.run_at = l.run_at)
        WHERE COALESCE(t.source, 'manual') = 'manual'
        GROUP BY l.run_id
      `);

      return {
        recent: latest,
        summary: summary[0],
        lastRun,
        lastScheduledRunAt: lastBySource[0]?.last_scheduled_run_at ?? null,
        lastManualRunAt: lastBySource[0]?.last_manual_run_at ?? null,
        lastScheduledRunSummary: lastScheduledRun[0] ?? null,
        lastManualRunSummary: lastManualRun[0] ?? null,
      };
    });

    const schedulerStatus = getTenantIsolationSchedulerStatus();

    return res.json({
      ...data,
      scheduler: schedulerStatus,
    });
  } catch (err) {
    logger.error('Failed to load isolation tests', { error: String(err) });
    return res.status(500).json({ error: 'Failed to load isolation tests' });
  }
});

router.post('/platform/compliance/isolation-tests/run', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { tenantId } = req.user!;
    const result = await runAllIsolationTests(tenantId, { source: 'manual' });

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

// ---------- Federal DNC registry sync ----------
//
// The federal DNC registry is pulled on a weekly cadence by
// `FederalDncSyncScheduler`. Support cases occasionally need an immediate
// pull (e.g. a customer reports we dialed a number that is on the public
// federal list but our snapshot is stale). These endpoints expose:
//   - GET  /platform/compliance/federal-dnc/state — the latest row from
//     `federal_dnc_sync_state` so the console can render last sync /
//     version / record count / status / error.
//   - POST /platform/compliance/federal-dnc/sync — fire one sync cycle on
//     behalf of the operator. We serialize concurrent invocations behind a
//     module-local promise so two impatient operators clicking the button
//     can't kick off two simultaneous bulk loads (each is a multi-minute,
//     ~250M-row INSERT). The action is captured in the audit log.

let inFlightSync: Promise<void> | null = null;
const SYNC_NOW_ACTION = 'platform.federal_dnc.sync_triggered';

router.get(
  '/platform/compliance/federal-dnc/state',
  requireAuth,
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const state = await getFederalDncSyncState();
      return res.json({
        state,
        running: inFlightSync !== null,
      });
    } catch (err) {
      logger.error('Failed to load federal DNC sync state', { error: String(err) });
      return res.status(500).json({ error: 'Failed to load federal DNC sync state' });
    }
  },
);

router.post(
  '/platform/compliance/federal-dnc/sync',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    if (inFlightSync) {
      return res.status(409).json({
        error: 'A federal DNC sync is already running. Wait for it to finish before starting another.',
        running: true,
      });
    }

    // Kick off the sync but don't await it before responding — the federal
    // snapshot is several gigabytes and routinely takes minutes to load,
    // which would blow past any reasonable HTTP timeout. The button on the
    // console polls `/state` to surface the result.
    inFlightSync = runFederalDncSyncCycle().finally(() => {
      inFlightSync = null;
    });

    try {
      await writeAuditLog({
        tenantId: req.user!.tenantId,
        actorUserId: req.user!.userId,
        actorRole: req.user!.role,
        action: SYNC_NOW_ACTION,
        resourceType: 'federal_dnc_registry',
        severity: 'info',
        ipAddress: extractIp(req),
        userAgent: req.headers['user-agent'],
        changes: {
          triggeredBy: req.user?.email ?? null,
          source: 'platform_admin_console',
        },
      });
    } catch (err) {
      // Don't fail the operator's click if the audit write trips — the sync
      // is already in flight. Log loudly so it's still recoverable.
      logger.error('Failed to write audit log for federal DNC sync trigger', {
        error: String(err),
      });
    }

    let state: Awaited<ReturnType<typeof getFederalDncSyncState>>;
    try {
      state = await getFederalDncSyncState();
    } catch (err) {
      logger.warn('Failed to read federal DNC sync state after triggering sync', {
        error: String(err),
      });
      state = {
        lastSyncStartedAt: null,
        lastSyncCompletedAt: null,
        lastRegistryVersion: null,
        lastRecordCount: null,
        lastStatus: null,
        lastError: null,
        updatedAt: null,
      };
    }

    return res.status(202).json({
      started: true,
      running: true,
      state,
    });
  },
);

// ---------- Platform admin users ----------
router.get('/platform/compliance/platform-admins', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const admins = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(`
        SELECT u.id, u.email, u.first_name, u.last_name, u.created_at, u.last_login_at,
               u.is_active, u.email_verified, u.mfa_enabled_at, u.mfa_last_verified_at,
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

// ---------- Authenticated healthcare control evidence ----------
router.get('/platform/compliance/healthcare-evidence', requireAuth, requirePlatformAdmin, async (req, res) => {
  const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
  if (tenantId.length > 255 || agentId.length > 255) {
    return res.status(400).json({ error: 'Invalid evidence filters' });
  }
  try {
    const rows = await withPrivilegedClient(async (client) => {
      const conditions: string[] = ['1 = 1'];
      const values: unknown[] = [];
      if (tenantId) {
        values.push(tenantId);
        conditions.push(`tenant_id = $${values.length}`);
      }
      if (agentId) {
        values.push(agentId);
        conditions.push(`agent_id = $${values.length}`);
      }
      const result = await client.query(
        `SELECT id, evidence_ref, tenant_id, agent_id, environment, control_key,
                artifact_sha256, owner_role, status, submitted_by, submitted_at,
                verified_by, verified_at, expires_at, revoked_at
           FROM healthcare_control_evidence
          WHERE ${conditions.join(' AND ')}
          ORDER BY submitted_at DESC
          LIMIT 500`,
        values,
      );
      return result.rows;
    });
    return res.json({ evidence: rows.map(evidenceResponse) });
  } catch (err) {
    logger.error('Failed to list healthcare control evidence', {
      errorType: err instanceof Error ? err.name : 'UnknownError',
    });
    return res.status(500).json({ error: 'Failed to list healthcare control evidence' });
  }
});

router.post('/platform/compliance/healthcare-evidence', requireAuth, requirePlatformAdmin, async (req, res) => {
  const parsed = evidenceCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid healthcare evidence request' });
  const input = parsed.data;
  if (input.ownerRole !== HEALTHCARE_EVIDENCE_OWNER_ROLES[input.controlKey]) {
    return res.status(400).json({ error: 'Healthcare evidence owner does not match the accountable control owner' });
  }
  const expiresAt = new Date(input.expiresAt).getTime();
  if (expiresAt <= Date.now() + 5 * 60_000 || expiresAt > Date.now() + 365 * 86_400_000) {
    return res.status(400).json({ error: 'Evidence expiry must be within 365 days' });
  }
  try {
    const row = await withPrivilegedClient<Record<string, unknown> | null>(async (client) => {
      const agentResult = await client.query(
        'SELECT id, tenant_id FROM agents WHERE id = $1 AND tenant_id = $2 LIMIT 1',
        [input.agentId, input.tenantId],
      );
      if (!agentResult.rows[0]) return null;
      const inserted = await client.query(
        `INSERT INTO healthcare_control_evidence
           (tenant_id, agent_id, environment, control_key, artifact_locator,
            artifact_sha256, owner_role, submitted_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, evidence_ref, tenant_id, agent_id, environment, control_key,
                   artifact_sha256, owner_role, status, submitted_by, submitted_at,
                   verified_by, verified_at, expires_at, revoked_at`,
        [
          input.tenantId, input.agentId, input.environment, input.controlKey,
          input.artifactLocator, input.artifactSha256, input.ownerRole,
          req.user!.userId, input.expiresAt,
        ],
      );
      return inserted.rows[0] ?? null;
    });
    if (!row) return res.status(404).json({ error: 'Agent not found for tenant' });
    await writeAuditLog({
      tenantId: input.tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'healthcare.evidence_submitted',
      resourceType: 'healthcare_control_evidence',
      resourceId: String(row.id),
      severity: 'critical',
      changes: {
        evidenceRef: String(row.evidence_ref),
        environment: input.environment,
        controlKey: input.controlKey,
        ownerRole: input.ownerRole,
        artifactSha256: input.artifactSha256,
        expiresAt: input.expiresAt,
      },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.status(201).json({ evidence: evidenceResponse(row) });
  } catch (err) {
    logger.error('Failed to submit healthcare control evidence', {
      errorType: err instanceof Error ? err.name : 'UnknownError',
    });
    return res.status(500).json({ error: 'Failed to submit healthcare control evidence' });
  }
});

router.post('/platform/compliance/healthcare-evidence/:id/verify', requireAuth, requirePlatformAdmin, async (req, res) => {
  if (!z.object({}).strict().safeParse(req.body).success) {
    return res.status(400).json({ error: 'Invalid evidence verification request' });
  }
  try {
    const row = await withPrivilegedClient(async (client) => {
      const result = await client.query(
        `UPDATE healthcare_control_evidence
            SET status = 'verified', verified_by = $2, verified_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'pending' AND submitted_by <> $2 AND expires_at > NOW()
          RETURNING id, evidence_ref, tenant_id, agent_id, environment, control_key,
                    artifact_sha256, owner_role, status, submitted_by, submitted_at,
                    verified_by, verified_at, expires_at, revoked_at`,
        [req.params.id, req.user!.userId],
      );
      return result.rows[0] ?? null;
    });
    if (!row) return res.status(409).json({ error: 'Evidence requires a different verifier and active pending status' });
    await writeAuditLog({
      tenantId: String(row.tenant_id),
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'healthcare.evidence_verified',
      resourceType: 'healthcare_control_evidence',
      resourceId: String(row.id),
      severity: 'critical',
      changes: { evidenceRef: String(row.evidence_ref), controlKey: String(row.control_key) },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.json({ evidence: evidenceResponse(row) });
  } catch (err) {
    logger.error('Failed to verify healthcare control evidence', {
      errorType: err instanceof Error ? err.name : 'UnknownError',
    });
    return res.status(500).json({ error: 'Failed to verify healthcare control evidence' });
  }
});

router.post('/platform/compliance/healthcare-evidence/:id/revoke', requireAuth, requirePlatformAdmin, async (req, res) => {
  const parsed = evidenceRevokeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid evidence revocation request' });
  try {
    const row = await withPrivilegedClient(async (client) => {
      const result = await client.query(
        `UPDATE healthcare_control_evidence
            SET status = 'revoked', revoked_by = $2, revoked_at = NOW(),
                revocation_reason = $3, updated_at = NOW()
          WHERE id = $1 AND status IN ('pending', 'verified') AND revoked_at IS NULL
          RETURNING id, evidence_ref, tenant_id, agent_id, environment, control_key,
                    artifact_sha256, owner_role, status, submitted_by, submitted_at,
                    verified_by, verified_at, expires_at, revoked_at`,
        [req.params.id, req.user!.userId, parsed.data.reason],
      );
      return result.rows[0] ?? null;
    });
    if (!row) return res.status(404).json({ error: 'Active healthcare evidence not found' });
    await writeAuditLog({
      tenantId: String(row.tenant_id),
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'healthcare.evidence_revoked',
      resourceType: 'healthcare_control_evidence',
      resourceId: String(row.id),
      severity: 'critical',
      changes: { evidenceRef: String(row.evidence_ref), reason: parsed.data.reason },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.json({ evidence: evidenceResponse(row) });
  } catch (err) {
    logger.error('Failed to revoke healthcare control evidence', {
      errorType: err instanceof Error ? err.name : 'UnknownError',
    });
    return res.status(500).json({ error: 'Failed to revoke healthcare control evidence' });
  }
});

// ---------- Immutable healthcare activation-readiness attestations ----------
router.get('/platform/compliance/healthcare-readiness', requireAuth, requirePlatformAdmin, async (req, res) => {
  const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
  if (tenantId.length > 255 || agentId.length > 255) {
    return res.status(400).json({ error: 'Invalid readiness filters' });
  }
  try {
    const rows = await withPrivilegedClient(async (client) => {
      const conditions: string[] = ['1 = 1'];
      const values: unknown[] = [];
      if (tenantId) {
        values.push(tenantId);
        conditions.push(`tenant_id = $${values.length}`);
      }
      if (agentId) {
        values.push(agentId);
        conditions.push(`agent_id = $${values.length}`);
      }
      const result = await client.query(
        `SELECT id, readiness_ref, tenant_id, agent_id, target_environment,
                core_version, model, role_package_id, role_package_version, recording_policy,
                catalog_version, catalog_count, discovered_count, tenant_table_count,
                rls_enabled_count, verified_control_count, caller_missing_count, caller_stale_count,
                status, submitted_by, submitted_at, verified_by, verified_at, expires_at, revoked_at
           FROM healthcare_activation_readiness
          WHERE ${conditions.join(' AND ')}
          ORDER BY submitted_at DESC
          LIMIT 500`,
        values,
      );
      return result.rows;
    });
    return res.json({ readiness: rows.map(readinessResponse) });
  } catch (err) {
    logger.error('Failed to list healthcare activation readiness', {
      errorType: err instanceof Error ? err.name : 'UnknownError',
    });
    return res.status(500).json({ error: 'Failed to list healthcare activation readiness' });
  }
});

router.post('/platform/compliance/healthcare-readiness', requireAuth, requirePlatformAdmin, async (req, res) => {
  const parsed = readinessCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid healthcare readiness request' });
  const input = parsed.data;
  if (calculateHealthcareReadinessPreflightSha256(input.preflight) !== input.preflight.preflightSha256) {
    return res.status(400).json({ error: 'Healthcare readiness preflight digest does not match payload' });
  }
  const expiresAt = new Date(input.expiresAt).getTime();
  if (expiresAt <= Date.now() + 5 * 60_000 || expiresAt > Date.now() + 90 * 86_400_000) {
    return res.status(400).json({ error: 'Readiness expiry must be within 90 days' });
  }
  try {
    const row = await withPrivilegedClient<Record<string, unknown> | null>(async (client) => {
      const agentResult = await client.query(
        'SELECT id, tenant_id, type FROM agents WHERE id = $1 AND tenant_id = $2 LIMIT 1',
        [input.agentId, input.tenantId],
      );
      const agent = agentResult.rows[0];
      if (!agent || !isHealthcareReceptionistIdentity(agent.type, agent.id)) return null;
      const proof = input.preflight;
      const inserted = await client.query(
        `INSERT INTO healthcare_activation_readiness
           (tenant_id, agent_id, target_environment, core_version, model,
            role_package_id, role_package_version, recording_policy,
            catalog_version, catalog_count, discovered_count, tenant_table_count,
            rls_enabled_count, verified_control_count, caller_missing_count, caller_stale_count,
            migration_status, schema_status, database_status, keyring_status, evidence_status,
            caller_hash_status, retention_status, deletion_status, preflight_sha256,
            evidence_snapshot_sha256, retention_plan_sha256, deletion_evidence_sha256,
            submitted_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'disabled',
                 $8, $9, $10, $11, $12, $13, $14, $15,
                 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass',
                 $16, $17, $18, $19, $20, $21)
         RETURNING id, readiness_ref, tenant_id, agent_id, target_environment,
                   core_version, model, role_package_id, role_package_version, recording_policy,
                   catalog_version, catalog_count, discovered_count, tenant_table_count,
                   rls_enabled_count, verified_control_count, caller_missing_count, caller_stale_count,
                   status, submitted_by, submitted_at, verified_by, verified_at, expires_at, revoked_at`,
        [
          input.tenantId, input.agentId, input.targetEnvironment,
          MASTER_VOICE_AGENT_CORE_VERSION, MASTER_VOICE_AGENT_MODEL,
          'healthcare-receptionist', HEALTHCARE_RECEPTIONIST_ROLE_VERSION,
          proof.catalogVersion, proof.catalogCount, proof.discoveredCount,
          proof.tenantTableCount, proof.rlsEnabledCount, proof.verifiedControlCount,
          proof.callerMissingCount, proof.callerStaleCount,
          proof.preflightSha256, proof.evidenceSnapshotSha256,
          proof.retentionPlanSha256, proof.deletionEvidenceSha256,
          req.user!.userId, input.expiresAt,
        ],
      );
      return inserted.rows[0] ?? null;
    });
    if (!row) return res.status(404).json({ error: 'Healthcare agent not found' });
    await writeAuditLog({
      tenantId: input.tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'healthcare.readiness_submitted',
      resourceType: 'healthcare_activation_readiness',
      resourceId: String(row.id),
      severity: 'critical',
      changes: {
        readinessRef: String(row.readiness_ref),
        targetEnvironment: input.targetEnvironment,
        catalogVersion: input.preflight.catalogVersion,
        catalogCount: input.preflight.catalogCount,
        expiresAt: input.expiresAt,
      },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.status(201).json({ readiness: readinessResponse(row) });
  } catch (err) {
    logger.error('Failed to submit healthcare activation readiness', {
      errorType: err instanceof Error ? err.name : 'UnknownError',
    });
    return res.status(500).json({ error: 'Failed to submit healthcare activation readiness' });
  }
});

router.post('/platform/compliance/healthcare-readiness/:id/verify', requireAuth, requirePlatformAdmin, async (req, res) => {
  const readinessId = typeof req.params.id === 'string' ? req.params.id : '';
  if (!z.object({}).strict().safeParse(req.body).success || !/^[A-Za-z0-9_-]{1,64}$/.test(readinessId)) {
    return res.status(400).json({ error: 'Invalid readiness verification request' });
  }
  try {
    const row = await withPrivilegedClient(async (client) => {
      const result = await client.query(
        `UPDATE healthcare_activation_readiness
            SET status = 'verified', verified_by = $2, verified_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'pending' AND submitted_by <> $2 AND expires_at > NOW()
          RETURNING id, readiness_ref, tenant_id, agent_id, target_environment,
                    core_version, model, role_package_id, role_package_version, recording_policy,
                    catalog_version, catalog_count, discovered_count, tenant_table_count,
                    rls_enabled_count, verified_control_count, caller_missing_count, caller_stale_count,
                    status, submitted_by, submitted_at, verified_by, verified_at, expires_at, revoked_at`,
        [readinessId, req.user!.userId],
      );
      return result.rows[0] ?? null;
    });
    if (!row) return res.status(409).json({ error: 'Readiness requires a different verifier and active pending status' });
    await writeAuditLog({
      tenantId: String(row.tenant_id),
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'healthcare.readiness_verified',
      resourceType: 'healthcare_activation_readiness',
      resourceId: String(row.id),
      severity: 'critical',
      changes: { readinessRef: String(row.readiness_ref), targetEnvironment: String(row.target_environment) },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.json({ readiness: readinessResponse(row) });
  } catch (err) {
    logger.error('Failed to verify healthcare activation readiness', {
      errorType: err instanceof Error ? err.name : 'UnknownError',
    });
    return res.status(500).json({ error: 'Failed to verify healthcare activation readiness' });
  }
});

router.post('/platform/compliance/healthcare-readiness/:id/revoke', requireAuth, requirePlatformAdmin, async (req, res) => {
  const parsed = readinessRevokeSchema.safeParse(req.body);
  const readinessId = typeof req.params.id === 'string' ? req.params.id : '';
  if (!parsed.success || !/^[A-Za-z0-9_-]{1,64}$/.test(readinessId)) {
    return res.status(400).json({ error: 'Invalid readiness revocation request' });
  }
  try {
    const row = await withPrivilegedClient(async (client) => {
      const result = await client.query(
        `UPDATE healthcare_activation_readiness
            SET status = 'revoked', revoked_by = $2, revoked_at = NOW(),
                revocation_reason = $3, updated_at = NOW()
          WHERE id = $1 AND status IN ('pending', 'verified') AND revoked_at IS NULL
          RETURNING id, readiness_ref, tenant_id, agent_id, target_environment,
                    core_version, model, role_package_id, role_package_version, recording_policy,
                    catalog_version, catalog_count, discovered_count, tenant_table_count,
                    rls_enabled_count, verified_control_count, caller_missing_count, caller_stale_count,
                    status, submitted_by, submitted_at, verified_by, verified_at, expires_at, revoked_at`,
        [readinessId, req.user!.userId, parsed.data.reason],
      );
      return result.rows[0] ?? null;
    });
    if (!row) return res.status(404).json({ error: 'Active healthcare readiness not found' });
    await writeAuditLog({
      tenantId: String(row.tenant_id),
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'healthcare.readiness_revoked',
      resourceType: 'healthcare_activation_readiness',
      resourceId: String(row.id),
      severity: 'critical',
      changes: { readinessRef: String(row.readiness_ref), reason: parsed.data.reason },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.json({ readiness: readinessResponse(row) });
  } catch (err) {
    logger.error('Failed to revoke healthcare activation readiness', {
      errorType: err instanceof Error ? err.name : 'UnknownError',
    });
    return res.status(500).json({ error: 'Failed to revoke healthcare activation readiness' });
  }
});

// ---------- Fail-closed healthcare deployment approvals ----------
router.get('/platform/compliance/healthcare-approvals', requireAuth, requirePlatformAdmin, async (req, res) => {
  const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
  try {
    const rows = await withPrivilegedClient(async (client) => {
      const values: unknown[] = [];
      const where = tenantId ? 'WHERE hda.tenant_id = $1' : '';
      if (tenantId) values.push(tenantId);
      const result = await client.query(
        `SELECT hda.id, hda.tenant_id, hda.agent_id, hda.approval_kind,
                hda.core_version, hda.model, hda.role_package_id,
                hda.role_package_version, hda.recording_policy, hda.approved_by,
                hda.approved_at, hda.expires_at, hda.revoked_at, hda.readiness_ref,
                jsonb_array_length(hda.synthetic_caller_hashes)::int AS synthetic_caller_count
           FROM healthcare_deployment_approvals hda
           ${where}
          ORDER BY hda.approved_at DESC
          LIMIT 500`,
        values,
      );
      return result.rows;
    });
    return res.json({ approvals: rows.map(approvalResponse) });
  } catch (err) {
    logger.error('Failed to list healthcare deployment approvals', { error: String(err) });
    return res.status(500).json({ error: 'Failed to list healthcare deployment approvals' });
  }
});

router.post('/platform/compliance/healthcare-approvals', requireAuth, requirePlatformAdmin, async (req, res) => {
  const parsed = approvalCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid healthcare approval request' });
  const input = parsed.data;
  if (input.approvalKind === 'production_healthcare' && !input.readinessRef) {
    return res.status(400).json({ error: 'Production approvals require verified activation readiness' });
  }
  if (input.approvalKind === 'synthetic_test' && input.readinessRef) {
    return res.status(400).json({ error: 'Synthetic approvals cannot use production activation readiness' });
  }
  const requiredEvidence = input.approvalKind === 'production_healthcare'
    ? HEALTHCARE_APPROVAL_EVIDENCE_KEYS
    : SYNTHETIC_APPROVAL_EVIDENCE_KEYS;
  if (!hasRequiredEvidence(input.evidenceRefs, requiredEvidence)) {
    return res.status(400).json({ error: 'Required approval evidence is incomplete' });
  }
  if (input.approvalKind === 'production_healthcare' && input.syntheticCallerNumbers) {
    return res.status(400).json({ error: 'Production approvals cannot include synthetic caller numbers' });
  }
  if (input.approvalKind === 'synthetic_test' && !input.syntheticCallerNumbers) {
    return res.status(400).json({ error: 'Synthetic approvals require authorized test callers' });
  }

  const expiresAt = new Date(input.expiresAt);
  const now = Date.now();
  const maxDays = input.approvalKind === 'synthetic_test' ? 30 : 90;
  if (expiresAt.getTime() <= now + 5 * 60_000 || expiresAt.getTime() > now + maxDays * 86_400_000) {
    return res.status(400).json({ error: `Approval expiry must be within ${maxDays} days` });
  }

  if (input.approvalKind === 'production_healthcare') {
    try {
      const evidenceDecision = await verifyHealthcareControlEvidenceRefs({
        tenantId: input.tenantId,
        agentId: input.agentId,
        approvalExpiresAt: input.expiresAt,
        evidenceRefs: input.evidenceRefs,
      });
      if (!evidenceDecision.valid) {
        return res.status(400).json({ error: 'Production healthcare evidence is not verified' });
      }
      const readinessDecision = await verifyHealthcareActivationReadinessRef({
        tenantId: input.tenantId,
        agentId: input.agentId,
        targetEnvironment: 'production',
        approvalExpiresAt: input.expiresAt,
        readinessRef: input.readinessRef ?? '',
      });
      if (!readinessDecision.valid) {
        return res.status(400).json({ error: 'Production healthcare readiness is not verified' });
      }
    } catch (err) {
      logger.error('Healthcare evidence verification unavailable', {
        errorType: err instanceof Error ? err.name : 'UnknownError',
      });
      return res.status(503).json({ error: 'Healthcare evidence verification is unavailable' });
    }
  }

  const callerHashes: string[] = [];
  for (const callerNumber of input.syntheticCallerNumbers ?? []) {
    if (!normalizeLookupPhone(callerNumber)) {
      return res.status(400).json({ error: 'Invalid synthetic caller number' });
    }
    const hash = createPiiLookupHash(input.tenantId, callerNumber, 'synthetic_test');
    if (!hash) {
      return res.status(503).json({ error: 'Healthcare approval hashing is not configured' });
    }
    if (!callerHashes.includes(hash)) callerHashes.push(hash);
  }

  try {
    const row = await withPrivilegedClient<Record<string, unknown> | null>(async (client) => {
      const agentResult = await client.query(
        `SELECT id, tenant_id, type FROM agents WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
        [input.agentId, input.tenantId],
      );
      const agent = agentResult.rows[0];
      if (!agent || !isHealthcareReceptionistIdentity(agent.type, agent.id)) return null;

      await client.query(
        `UPDATE healthcare_deployment_approvals
            SET revoked_at = NOW(), revoked_by = $3,
                revocation_reason = 'Superseded by a newer approval', updated_at = NOW()
          WHERE tenant_id = $1 AND agent_id = $2 AND revoked_at IS NULL`,
        [input.tenantId, input.agentId, req.user!.userId],
      );
      const inserted = await client.query(
        `INSERT INTO healthcare_deployment_approvals
           (tenant_id, agent_id, approval_kind, core_version, model,
            role_package_id, role_package_version, recording_policy,
            evidence_refs, readiness_ref, synthetic_caller_hashes, approved_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'disabled', $8::jsonb, $9, $10::jsonb, $11, $12)
         RETURNING id, tenant_id, agent_id, approval_kind, core_version, model,
                   role_package_id, role_package_version, recording_policy,
                   approved_by, approved_at, expires_at, revoked_at, readiness_ref`,
        [
          input.tenantId,
          input.agentId,
          input.approvalKind,
          MASTER_VOICE_AGENT_CORE_VERSION,
          MASTER_VOICE_AGENT_MODEL,
          'healthcare-receptionist',
          HEALTHCARE_RECEPTIONIST_ROLE_VERSION,
          JSON.stringify(input.evidenceRefs),
          input.readinessRef ?? null,
          JSON.stringify(callerHashes),
          req.user!.userId,
          input.expiresAt,
        ],
      );
      const insertedRow = inserted.rows[0] as Record<string, unknown> | undefined;
      return insertedRow
        ? { ...insertedRow, synthetic_caller_count: callerHashes.length }
        : null;
    });
    if (!row) return res.status(404).json({ error: 'Healthcare agent not found' });

    await writeAuditLog({
      tenantId: input.tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'healthcare.approval_created',
      resourceType: 'healthcare_deployment_approval',
      resourceId: String(row.id),
      severity: 'critical',
      changes: {
        approvalKind: input.approvalKind,
        expiresAt: input.expiresAt,
        syntheticCallerCount: callerHashes.length,
        coreVersion: MASTER_VOICE_AGENT_CORE_VERSION,
        rolePackageVersion: HEALTHCARE_RECEPTIONIST_ROLE_VERSION,
        readinessRef: input.readinessRef ?? null,
      },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.status(201).json({ approval: approvalResponse(row) });
  } catch (err) {
    logger.error('Failed to create healthcare deployment approval', { error: String(err) });
    return res.status(500).json({ error: 'Failed to create healthcare deployment approval' });
  }
});

router.post('/platform/compliance/healthcare-approvals/:id/revoke', requireAuth, requirePlatformAdmin, async (req, res) => {
  const parsed = approvalRevokeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid revocation request' });
  try {
    const row = await withPrivilegedClient(async (client) => {
      const result = await client.query(
        `UPDATE healthcare_deployment_approvals
            SET revoked_at = NOW(), revoked_by = $2, revocation_reason = $3, updated_at = NOW()
          WHERE id = $1 AND revoked_at IS NULL
          RETURNING id, tenant_id, agent_id, approval_kind, core_version, model,
                    role_package_id, role_package_version, recording_policy,
                    approved_by, approved_at, expires_at, revoked_at`,
        [req.params.id, req.user!.userId, parsed.data.reason],
      );
      return result.rows[0] ?? null;
    });
    if (!row) return res.status(404).json({ error: 'Active healthcare approval not found' });
    await writeAuditLog({
      tenantId: String(row.tenant_id),
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'healthcare.approval_revoked',
      resourceType: 'healthcare_deployment_approval',
      resourceId: String(row.id),
      severity: 'critical',
      changes: { reason: parsed.data.reason },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.json({ approval: approvalResponse(row) });
  } catch (err) {
    logger.error('Failed to revoke healthcare deployment approval', { error: String(err) });
    return res.status(500).json({ error: 'Failed to revoke healthcare deployment approval' });
  }
});

export default router;
