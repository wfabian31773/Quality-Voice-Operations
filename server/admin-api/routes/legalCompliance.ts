import { Router } from 'express';
import JSZip from 'jszip';
import { z } from 'zod';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { requireRole, requirePlatformAdmin } from '../middleware/rbac';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';
import { createLogger } from '../../../platform/core/logger';
import { sendEmail } from '../../../platform/email/EmailService';
import {
  dataExportEmail,
  deletionScheduledEmail,
  deletionCancelledEmail,
  deletionExecutedEmail,
} from '../../../platform/email/templates';
import { buildPublicCompliancePosture } from '../../../shared/compliance/publicCompliancePosture';
import {
  discoverTenantScopedTables,
  executeExplicitTenantDeletes,
  verifyTenantRowsRemoved,
} from '../../../platform/compliance/HealthcareDeletionVerificationService';
import {
  buildTenantDeletionPlan,
  HEALTHCARE_DATA_CONTROL_MANIFEST_VERSION,
} from '../../../platform/compliance/healthcareDataControlManifest';
import { createScopedIdentifierHash } from '../../../platform/security/PiiLookupHash';

function appBaseUrl(): string {
  return process.env.APP_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? 'localhost:5173'}`;
}

async function fetchTenantOwnerContext(
  client: import('pg').PoolClient,
  tenantId: string,
  actorUserId: string,
): Promise<{ ownerEmail: string | null; tenantName: string | null }> {
  const { rows: tenantRows } = await client.query(
    `SELECT name FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const tenantName = (tenantRows[0]?.name as string | undefined) ?? null;

  const { rows: actorRows } = await client.query(
    `SELECT email FROM users WHERE id = $1`,
    [actorUserId],
  );
  let ownerEmail = (actorRows[0]?.email as string | undefined) ?? null;

  if (!ownerEmail) {
    const { rows: ownerRows } = await client.query(
      `SELECT u.email FROM users u
         JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = $1
        WHERE ur.role = 'tenant_owner'
        ORDER BY u.created_at ASC
        LIMIT 1`,
      [tenantId],
    );
    ownerEmail = (ownerRows[0]?.email as string | undefined) ?? null;
  }

  return { ownerEmail, tenantName };
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = Array.from(
    rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set<string>()),
  );
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const row of rows) lines.push(cols.map((c) => escape(row[c])).join(','));
  return lines.join('\n');
}

const router = Router();
const logger = createLogger('LEGAL_COMPLIANCE');

const deletionEvidenceRef = z.string().trim().min(3).max(500).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/,
);
const executeDeletionSchema = z.object({
  externalDeletionEvidence: z.object({
    twilio: deletionEvidenceRef,
    openai: deletionEvidenceRef,
    hosting: deletionEvidenceRef,
    messaging_connectors: deletionEvidenceRef,
    logs_backups: deletionEvidenceRef,
  }).strict(),
}).strict();

// ---------- Public: sub-processors list ----------
router.get('/public/subprocessors', async (_req, res) => {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, name, purpose, data_types, location, website, added_at, updated_at, display_order
       FROM subprocessors WHERE is_active = TRUE
       ORDER BY display_order ASC, name ASC`,
    );
    return res.json({ subprocessors: rows });
  } catch (err) {
    logger.error('Failed to list subprocessors', { error: String(err) });
    return res.status(500).json({ error: 'Failed to list subprocessors' });
  } finally {
    client.release();
  }
});

// ---------- Public: security posture ----------
// Schema for the public security posture document. Validated on every request
// so the response we ship matches the contract advertised on /security/posture.
const postureFrameworkSchema = z.object({
  key: z.string(),
  name: z.string(),
  status: z.literal('not_verified'),
  status_label: z.string(),
  scope: z.string(),
  description: z.string(),
  evidence_url: z.string().nullable(),
  last_reviewed: z.string(),
});

const postureSubprocessorSchema = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  data_types: z.string(),
  location: z.string(),
  website: z.string().nullable(),
});

const postureSchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  organization: z.object({
    name: z.string(),
    contact_security: z.string(),
    contact_privacy: z.string(),
  }),
  frameworks: z.array(postureFrameworkSchema).min(1),
  baa: z.object({
    available: z.boolean(),
    plans: z.array(z.string()),
    contact: z.string(),
    notes: z.string(),
  }),
  data_residency: z.object({
    verified: z.literal(false),
    primary_region: z.string(),
    description: z.string(),
  }),
  subprocessors: z.array(postureSubprocessorSchema),
  documents: z.array(
    z.object({ name: z.string(), url: z.string(), kind: z.enum(['dpa', 'list', 'page']) }),
  ),
});

export type SecurityPosture = z.infer<typeof postureSchema>;

router.get('/public/posture', async (_req, res) => {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rows: subprocessorRows } = await client.query(
      `SELECT id, name, purpose, data_types, location, website
       FROM subprocessors WHERE is_active = TRUE
       ORDER BY display_order ASC, name ASC`,
    );

    const payload = buildPublicCompliancePosture(
      subprocessorRows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        purpose: String(r.purpose),
        data_types: String(r.data_types),
        location: String(r.location),
        website: r.website ? String(r.website) : null,
      })),
    );

    // Validate the response against the schema before sending so any drift in
    // the payload shape (e.g. a future code change that drops a field) fails
    // loudly here instead of silently shipping an invalid contract.
    const parsed = postureSchema.safeParse(payload);
    if (!parsed.success) {
      logger.error('Security posture payload failed schema validation', {
        issues: parsed.error.issues,
      });
      return res.status(500).json({ error: 'Posture payload failed validation' });
    }

    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json(parsed.data);
  } catch (err) {
    logger.error('Failed to build security posture', { error: String(err) });
    return res.status(500).json({ error: 'Failed to build security posture' });
  } finally {
    client.release();
  }
});

// ---------- Admin: manage sub-processors ----------
router.get('/admin/subprocessors', requireAuth, requirePlatformAdmin, async (_req, res) => {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, name, purpose, data_types, location, website, added_at, updated_at, is_active, display_order
       FROM subprocessors ORDER BY display_order ASC, name ASC`,
    );
    return res.json({ subprocessors: rows });
  } finally {
    client.release();
  }
});

router.post('/admin/subprocessors', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { name, purpose, data_types, location, website, display_order } = req.body as Record<string, unknown>;
  if (!name || !purpose || !data_types) {
    return res.status(400).json({ error: 'name, purpose, and data_types are required' });
  }
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `INSERT INTO subprocessors (name, purpose, data_types, location, website, display_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, purpose, data_types, location ?? 'United States', website ?? null, display_order ?? 0],
    );
    return res.json({ subprocessor: rows[0] });
  } finally {
    client.release();
  }
});

router.patch('/admin/subprocessors/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, purpose, data_types, location, website, is_active, display_order } = req.body as Record<string, unknown>;
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `UPDATE subprocessors SET
         name = COALESCE($2, name),
         purpose = COALESCE($3, purpose),
         data_types = COALESCE($4, data_types),
         location = COALESCE($5, location),
         website = COALESCE($6, website),
         is_active = COALESCE($7, is_active),
         display_order = COALESCE($8, display_order),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, name ?? null, purpose ?? null, data_types ?? null, location ?? null, website ?? null,
       typeof is_active === 'boolean' ? is_active : null, typeof display_order === 'number' ? display_order : null],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Subprocessor not found' });
    return res.json({ subprocessor: rows[0] });
  } finally {
    client.release();
  }
});

router.delete('/admin/subprocessors/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM subprocessors WHERE id = $1`, [id]);
    return res.json({ deleted: true });
  } finally {
    client.release();
  }
});

// ---------- Tenant self-service GDPR ----------
router.post('/privacy/export', requireAuth, requireRole('owner'), async (req, res) => {
  const { tenantId, userId, role } = req.user!;
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: tenantRows } = await client.query(
      `SELECT id, name, slug, plan, status, created_at, settings FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const { rows: userRows } = await client.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.created_at, u.last_login_at, ur.role
       FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = $1
       ORDER BY u.email`,
      [tenantId],
    );
    const { rows: agentRows } = await client.query(
      `SELECT id, name, agent_type, status, created_at FROM agents WHERE tenant_id = $1`,
      [tenantId],
    );
    const { rows: phoneRows } = await client.query(
      `SELECT id, e164, status, created_at FROM phone_numbers WHERE tenant_id = $1`,
      [tenantId],
    );
    const { rows: callRows } = await client.query(
      `SELECT id, caller_number, called_number, direction, lifecycle_state, start_time, end_time, duration_seconds
       FROM call_sessions WHERE tenant_id = $1 ORDER BY start_time DESC LIMIT 5000`,
      [tenantId],
    );
    const { rows: auditRows } = await client.query(
      `SELECT action, resource_type, resource_id, severity, occurred_at FROM audit_logs
       WHERE tenant_id = $1 ORDER BY occurred_at DESC LIMIT 5000`,
      [tenantId],
    );
    await client.query('COMMIT');

    const generatedAt = new Date().toISOString();
    const payload = {
      generated_at: generatedAt,
      tenant: tenantRows[0] ?? null,
      users: userRows,
      agents: agentRows,
      phone_numbers: phoneRows,
      call_sessions: callRows,
      audit_logs: auditRows,
    };

    const readme = `QVO Data Export
Generated: ${generatedAt}
Tenant: ${tenantRows[0]?.name ?? tenantId}

Files:
  data.json            Full JSON bundle (machine-readable)
  csv/users.csv        Tenant users and roles
  csv/agents.csv       AI agents
  csv/phone_numbers.csv  Provisioned phone numbers
  csv/call_sessions.csv  Call sessions (last 5,000)
  csv/audit_logs.csv     Audit log entries (last 5,000)

This product export is not a representation that every legally relevant data store is included.
Questions: use the QVO contact form at ${appBaseUrl()}/contact
`;

    const zip = new JSZip();
    zip.file('README.txt', readme);
    zip.file('data.json', JSON.stringify(payload, null, 2));
    const csvDir = zip.folder('csv')!;
    csvDir.file('users.csv', toCsv(userRows));
    csvDir.file('agents.csv', toCsv(agentRows));
    csvDir.file('phone_numbers.csv', toCsv(phoneRows));
    csvDir.file('call_sessions.csv', toCsv(callRows));
    csvDir.file('audit_logs.csv', toCsv(auditRows));
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    await writeAuditLog({
      tenantId,
      actorUserId: userId,
      actorRole: role,
      action: 'privacy.data_exported',
      resourceType: 'tenant',
      resourceId: tenantId,
      severity: 'critical',
      changes: {
        rows: {
          users: userRows.length,
          agents: agentRows.length,
          phone_numbers: phoneRows.length,
          calls: callRows.length,
          audit: auditRows.length,
        },
        bytes: buffer.length,
      },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    try {
      const ownerCtx = await fetchTenantOwnerContext(client, tenantId, userId);
      if (ownerCtx.ownerEmail) {
        const email = dataExportEmail({
          tenantName: ownerCtx.tenantName ?? undefined,
          generatedAt,
          rowCounts: {
            users: userRows.length,
            agents: agentRows.length,
            phone_numbers: phoneRows.length,
            calls: callRows.length,
            audit: auditRows.length,
          },
          bytes: buffer.length,
          ipAddress: extractIp(req) ?? null,
          settingsUrl: `${appBaseUrl()}/settings`,
        });
        const result = await sendEmail({ to: ownerCtx.ownerEmail, subject: email.subject, html: email.html, text: email.text });
        if (!result.success) {
          logger.warn('Data export email did not send', { tenantId, error: result.error });
        }
      } else {
        logger.warn('Skipped data export email — no owner email found', { tenantId });
      }
    } catch (emailErr) {
      logger.error('Failed to send data export email', { tenantId, error: String(emailErr) });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="qvo-data-export-${generatedAt.slice(0, 10)}.zip"`);
    return res.send(buffer);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to export tenant data', { error: String(err) });
    return res.status(500).json({ error: 'Failed to export tenant data' });
  } finally {
    client.release();
  }
});

router.get('/privacy/deletion-request', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, requested_at, scheduled_for, status, reason FROM tenant_deletion_requests
       WHERE tenant_id = $1 AND status = 'pending'
       ORDER BY requested_at DESC LIMIT 1`,
      [tenantId],
    );
    return res.json({ request: rows[0] ?? null });
  } finally {
    client.release();
  }
});

router.post('/privacy/deletion-request', requireAuth, requireRole('owner'), async (req, res) => {
  const { tenantId, userId, role } = req.user!;
  const { confirmation, reason } = req.body as { confirmation?: string; reason?: string };

  if (confirmation !== 'DELETE MY ACCOUNT') {
    return res.status(400).json({ error: 'Confirmation phrase did not match. Type "DELETE MY ACCOUNT" exactly to confirm.' });
  }

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rows: existing } = await client.query(
      `SELECT id FROM tenant_deletion_requests WHERE tenant_id = $1 AND status = 'pending'`,
      [tenantId],
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'A deletion request is already pending for this account.' });
    }

    const scheduled = new Date();
    scheduled.setDate(scheduled.getDate() + 30); // 30-day cool-off

    const { rows } = await client.query(
      `INSERT INTO tenant_deletion_requests
         (tenant_id, requested_by, scheduled_for, status, reason, confirmation_text)
       VALUES ($1, $2, $3, 'pending', $4, $5) RETURNING *`,
      [tenantId, userId, scheduled.toISOString(), reason ?? null, confirmation],
    );

    await writeAuditLog({
      tenantId,
      actorUserId: userId,
      actorRole: role,
      action: 'privacy.deletion_requested',
      resourceType: 'tenant',
      resourceId: tenantId,
      severity: 'critical',
      changes: { scheduledFor: scheduled.toISOString(), reason: reason ?? null },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    try {
      const ownerCtx = await fetchTenantOwnerContext(client, tenantId, userId);
      if (ownerCtx.ownerEmail) {
        const email = deletionScheduledEmail({
          tenantName: ownerCtx.tenantName ?? undefined,
          scheduledFor: scheduled.toISOString().slice(0, 10),
          reason: reason ?? null,
          ipAddress: extractIp(req) ?? null,
          cancellationUrl: `${appBaseUrl()}/settings`,
        });
        const result = await sendEmail({ to: ownerCtx.ownerEmail, subject: email.subject, html: email.html, text: email.text });
        if (!result.success) {
          logger.warn('Deletion scheduled email did not send', { tenantId, error: result.error });
        }
      } else {
        logger.warn('Skipped deletion scheduled email — no owner email found', { tenantId });
      }
    } catch (emailErr) {
      logger.error('Failed to send deletion scheduled email', { tenantId, error: String(emailErr) });
    }

    return res.json({ request: rows[0] });
  } finally {
    client.release();
  }
});

router.delete('/privacy/deletion-request/:id', requireAuth, requireRole('owner'), async (req, res) => {
  const { tenantId, userId, role } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rowCount } = await client.query(
      `UPDATE tenant_deletion_requests
       SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $3
       WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`,
      [id, tenantId, userId],
    );
    if (!rowCount) return res.status(404).json({ error: 'Pending deletion request not found' });

    await writeAuditLog({
      tenantId,
      actorUserId: userId,
      actorRole: role,
      action: 'privacy.deletion_cancelled',
      resourceType: 'tenant',
      resourceId: tenantId,
      severity: 'warning',
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    try {
      const ownerCtx = await fetchTenantOwnerContext(client, tenantId, userId);
      if (ownerCtx.ownerEmail) {
        const email = deletionCancelledEmail({
          tenantName: ownerCtx.tenantName ?? undefined,
          cancelledAt: new Date().toISOString().slice(0, 10),
          ipAddress: extractIp(req) ?? null,
          settingsUrl: `${appBaseUrl()}/settings`,
        });
        const result = await sendEmail({ to: ownerCtx.ownerEmail, subject: email.subject, html: email.html, text: email.text });
        if (!result.success) {
          logger.warn('Deletion cancelled email did not send', { tenantId, error: result.error });
        }
      } else {
        logger.warn('Skipped deletion cancelled email — no owner email found', { tenantId });
      }
    } catch (emailErr) {
      logger.error('Failed to send deletion cancelled email', { tenantId, error: String(emailErr) });
    }

    return res.json({ cancelled: true });
  } finally {
    client.release();
  }
});

// ---------- Platform admin: execute a scheduled deletion ----------
router.post(
  '/admin/privacy/deletion-request/:id/execute',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const parsedExecution = executeDeletionSchema.safeParse(req.body);
    if (!parsedExecution.success) {
      return res.status(400).json({ error: 'Complete external deletion evidence is required' });
    }
    const { id } = req.params;
    const pool = getPlatformPool();
    const client = await pool.connect();
    try {
      const { rows: requestRows } = await client.query(
        `SELECT id, tenant_id, requested_by, scheduled_for, status
           FROM tenant_deletion_requests WHERE id = $1`,
        [id],
      );
      const request = requestRows[0];
      if (!request) return res.status(404).json({ error: 'Deletion request not found' });
      if (request.status !== 'pending') {
        return res.status(409).json({ error: `Deletion request is ${request.status as string}, not pending` });
      }
      if (new Date(request.scheduled_for as string).getTime() > Date.now()) {
        return res
          .status(400)
          .json({ error: `Scheduled date (${request.scheduled_for as string}) has not yet been reached` });
      }

      const tenantId = request.tenant_id as string;
      const tenantFingerprint = createScopedIdentifierHash(
        tenantId,
        tenantId,
        'tenant_deletion',
      );
      if (!tenantFingerprint) {
        return res.status(503).json({ error: 'Tenant deletion verification is not configured' });
      }
      const executorFingerprint = createScopedIdentifierHash(
        tenantId,
        req.user!.userId,
        'deletion_executor',
      );
      if (!executorFingerprint) {
        return res.status(503).json({ error: 'Tenant deletion verification is not configured' });
      }

      const discoveredTables = await discoverTenantScopedTables(client);
      const deletionPlan = buildTenantDeletionPlan(discoveredTables);
      if (!deletionPlan.ready) {
        logger.error('Tenant deletion blocked by incomplete data-control manifest', {
          requestId: id,
          tenantId,
          invalidIdentifiers: deletionPlan.invalidIdentifiers,
          unclassifiedTables: deletionPlan.unclassifiedTables,
        });
        return res.status(409).json({
          error: 'Tenant deletion data-control review is incomplete',
          manifestVersion: deletionPlan.manifestVersion,
          unclassifiedTables: deletionPlan.unclassifiedTables,
        });
      }

      let ownerEmail: string | null = null;
      let tenantName: string | null = null;
      try {
        const ctx = await fetchTenantOwnerContext(client, tenantId, request.requested_by as string);
        ownerEmail = ctx.ownerEmail;
        tenantName = ctx.tenantName;
      } catch (ctxErr) {
        logger.warn('Failed to load owner context before deletion', { tenantId, error: String(ctxErr) });
      }

      // Record an execution attempt before deleting the tenant. This event is
      // intentionally named "started": if verification rolls back, the audit
      // row must not falsely claim completion. On success the tenant cascade
      // removes this tenant-scoped audit row and the redacted deletion-request
      // proof below becomes the durable completion evidence.
      try {
        await writeAuditLog({
          tenantId,
          actorUserId: req.user!.userId,
          actorRole: req.user!.role,
          action: 'privacy.deletion_execution_started',
          resourceType: 'tenant',
          resourceId: tenantId,
          severity: 'critical',
          changes: { requestId: id, scheduledFor: request.scheduled_for },
          ipAddress: extractIp(req),
          userAgent: req.headers['user-agent'],
        });
      } catch (auditErr) {
        logger.error('Failed to write deletion executed audit log', { tenantId, error: String(auditErr) });
      }

      await client.query('BEGIN');
      await executeExplicitTenantDeletes(client, tenantId, deletionPlan);
      await client.query(
        `SELECT set_config('app.verified_tenant_deletion_id', $1, true)`,
        [tenantId],
      );
      await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);

      const verification = await verifyTenantRowsRemoved(
        client,
        tenantId,
        discoveredTables.map(({ table }) => table),
      );
      if (!verification.verified) {
        throw new Error(`First-party tenant deletion verification failed for ${verification.remaining.length} stores`);
      }

      await client.query(
        `UPDATE tenant_deletion_requests
            SET status = 'completed', completed_at = NOW(), tenant_fingerprint = $2,
                tenant_id = NULL, requested_by = NULL, cancelled_by = NULL,
                reason = NULL, confirmation_text = $3,
                first_party_verification = $4::jsonb,
                external_deletion_evidence = $5::jsonb
          WHERE id = $1`,
        [
          id,
          tenantFingerprint,
          '[REDACTED AFTER VERIFIED DELETION]',
          JSON.stringify({
            verified: true,
            manifestVersion: HEALTHCARE_DATA_CONTROL_MANIFEST_VERSION,
            discoveredTableCount: discoveredTables.length,
            executorFingerprint,
            verifiedAt: new Date().toISOString(),
          }),
          JSON.stringify(parsedExecution.data.externalDeletionEvidence),
        ],
      );
      await client.query('COMMIT');

      if (ownerEmail) {
        try {
          const email = deletionExecutedEmail({
            tenantName: tenantName ?? undefined,
            executedAt: new Date().toISOString().slice(0, 10),
            contactUrl: `${appBaseUrl()}/contact`,
          });
          const result = await sendEmail({ to: ownerEmail, subject: email.subject, html: email.html, text: email.text });
          if (!result.success) {
            logger.warn('Deletion executed email did not send', { tenantId, error: result.error });
          }
        } catch (emailErr) {
          logger.error('Failed to send deletion executed email', { tenantId, error: String(emailErr) });
        }
      } else {
        logger.warn('Skipped deletion executed email — no owner email found', { tenantId });
      }

      return res.json({
        executed: true,
        tenantId,
        firstPartyVerified: true,
        externalEvidenceRecorded: true,
        manifestVersion: HEALTHCARE_DATA_CONTROL_MANIFEST_VERSION,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('Failed to execute deletion request', { id, error: String(err) });
      return res.status(500).json({ error: 'Failed to execute deletion request' });
    } finally {
      client.release();
    }
  },
);

// ---------- DPA download (non-executable legal-review placeholder) ----------
router.get('/legal/dpa', (_req, res) => {
  const dpa = `DATA PROCESSING ADDENDUM (DPA)
QVO — Quality Voice Operations
Last updated: ${new Date().toISOString().slice(0, 10)}

[DRAFT PLACEHOLDER — NOT AN AGREEMENT — NOT FOR SIGNATURE]

No QVO data-processing terms, security commitments, transfer mechanisms, retention
periods, subprocessor authorizations, audit rights, breach-notification terms, or
healthcare obligations are represented as approved by this placeholder.

Before any production healthcare deployment, an authorized QVO legal/compliance owner
and the customer must approve a complete agreement covering at least:

1. parties, roles, scope, purpose, duration, and documented instructions;
2. data subjects, data categories, special-category data, and minimum-necessary use;
3. approved subprocessors, processing locations, transfer mechanisms, and change notice;
4. technical and organizational measures backed by deployment evidence;
5. incident, audit, assistance, deletion, return, backup, and legal-hold obligations;
6. healthcare-specific Business Associate Agreement requirements where applicable; and
7. signatures by authorized representatives.

Use ${appBaseUrl()}/contact to request legal review. This placeholder does not authorize
Personal Data or PHI processing.
`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="QVO-DPA-DRAFT.txt"');
  return res.send(dpa);
});

export default router;
