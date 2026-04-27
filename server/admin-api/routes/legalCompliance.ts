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
  status: z.enum(['compliant', 'in_progress', 'available', 'roadmap', 'not_applicable']),
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

    const today = new Date().toISOString().slice(0, 10);
    const payload = {
      version: 1 as const,
      generated_at: new Date().toISOString(),
      organization: {
        name: 'QVO — Quality Voice Operations',
        contact_security: 'security@qvo.example',
        contact_privacy: 'privacy@qvo.example',
      },
      frameworks: [
        {
          key: 'soc2',
          name: 'SOC 2 Type II',
          status: 'in_progress' as const,
          status_label: 'In progress',
          scope: 'Security & Availability — target Q4 2026',
          description:
            'Trust services criteria audit covering security and availability. Pre-audit readiness assessment complete; observation window in progress.',
          evidence_url: null,
          last_reviewed: today,
        },
        {
          key: 'hipaa',
          name: 'HIPAA',
          status: 'available' as const,
          status_label: 'Available with BAA',
          scope: 'Pro & Enterprise plans',
          description:
            'Business Associate Agreement available for healthcare customers. PHI safeguards (encryption at rest/in transit, access controls, audit logging, optional PHI-redacted logging) in place.',
          evidence_url: '/legal/dpa',
          last_reviewed: today,
        },
        {
          key: 'gdpr',
          name: 'GDPR',
          status: 'compliant' as const,
          status_label: 'Compliant',
          scope: 'EU/UK customers',
          description:
            'Standard Contractual Clauses (2021/914) incorporated by reference in our DPA. Data Subject Rights workflows (export, deletion) self-service from Settings → Privacy.',
          evidence_url: '/legal/dpa',
          last_reviewed: today,
        },
        {
          key: 'ccpa',
          name: 'CCPA / CPRA',
          status: 'compliant' as const,
          status_label: 'Compliant',
          scope: 'California residents',
          description:
            'Disclosure, deletion, and opt-out rights honored via Settings → Privacy. We do not sell personal information.',
          evidence_url: '/privacy',
          last_reviewed: today,
        },
        {
          key: 'iso27001',
          name: 'ISO 27001',
          status: 'roadmap' as const,
          status_label: 'Roadmap',
          scope: 'Targeted 2027',
          description:
            'Information Security Management System certification on roadmap following SOC 2 attestation.',
          evidence_url: null,
          last_reviewed: today,
        },
      ],
      baa: {
        available: true,
        plans: ['Pro', 'Enterprise'],
        contact: 'privacy@qvo.example',
        notes:
          'BAA is countersigned on request for Pro and Enterprise customers. Starter plans cannot store or process PHI.',
      },
      data_residency: {
        primary_region: 'United States',
        description:
          'Primary processing region is the United States (us-east). Voice recordings, transcripts, and tenant data remain in-region. EU residency available on Enterprise on request.',
      },
      subprocessors: subprocessorRows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        purpose: String(r.purpose),
        data_types: String(r.data_types),
        location: String(r.location),
        website: r.website ? String(r.website) : null,
      })),
      documents: [
        { name: 'Data Processing Addendum (template)', url: '/legal/dpa', kind: 'dpa' as const },
        { name: 'Sub-processor list', url: '/subprocessors', kind: 'list' as const },
        { name: 'Privacy policy', url: '/privacy', kind: 'page' as const },
        { name: 'Security overview', url: '/security', kind: 'page' as const },
      ],
    };

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

This export was requested by an account owner under your data-portability rights.
Questions: privacy@qvo.example
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

      let ownerEmail: string | null = null;
      let tenantName: string | null = null;
      try {
        const ctx = await fetchTenantOwnerContext(client, tenantId, request.requested_by as string);
        ownerEmail = ctx.ownerEmail;
        tenantName = ctx.tenantName;
      } catch (ctxErr) {
        logger.warn('Failed to load owner context before deletion', { tenantId, error: String(ctxErr) });
      }

      // Write the audit log BEFORE deleting the tenant — audit_logs.tenant_id has
      // a NOT NULL FK to tenants(id) so a write attempted after the tenant row is
      // gone would fail the FK and bubble a 500 back to the admin even though the
      // deletion already committed. Wrapping in try/catch ensures any write
      // failure here cannot block the executed-notification email below.
      try {
        await writeAuditLog({
          tenantId,
          actorUserId: req.user!.userId,
          actorRole: req.user!.role,
          action: 'privacy.deletion_executed',
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
      await client.query(
        `UPDATE tenant_deletion_requests SET status = 'completed' WHERE id = $1`,
        [id],
      );
      await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      await client.query('COMMIT');

      if (ownerEmail) {
        try {
          const email = deletionExecutedEmail({
            tenantName: tenantName ?? undefined,
            executedAt: new Date().toISOString().slice(0, 10),
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

      return res.json({ executed: true, tenantId });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('Failed to execute deletion request', { id, error: String(err) });
      return res.status(500).json({ error: 'Failed to execute deletion request' });
    } finally {
      client.release();
    }
  },
);

// ---------- DPA download (placeholder boilerplate) ----------
router.get('/legal/dpa', (_req, res) => {
  const dpa = `DATA PROCESSING ADDENDUM (DPA)
QVO — Quality Voice Operations
Last updated: ${new Date().toISOString().slice(0, 10)}

[DRAFT — pending legal review]

This Data Processing Addendum ("DPA") forms part of the QVO Master Services Agreement
between Customer ("Controller") and QVO ("Processor") and reflects the parties' agreement
with respect to the processing of Personal Data.

1. DEFINITIONS
   "Personal Data", "Processing", "Controller", "Processor", "Data Subject", and
   "Supervisory Authority" have the meanings given in the GDPR (Regulation 2016/679).

2. SUBJECT MATTER & DURATION
   QVO will process Personal Data only on documented instructions from Customer for the
   duration of the Services and as necessary to provide the Services.

3. NATURE & PURPOSE OF PROCESSING
   Hosting voice and SMS communications, maintaining call records, providing AI-driven
   conversational agents, billing, analytics, and platform administration.

4. CATEGORIES OF DATA SUBJECTS
   Customer's end users, callers, employees, contractors, and other individuals whose
   data Customer routes through the Services.

5. CATEGORIES OF PERSONAL DATA
   Identifiers (name, email, phone), authentication credentials, voice recordings,
   transcripts, billing details, and audit metadata.

6. SUB-PROCESSORS
   Customer authorizes QVO to engage the sub-processors listed at /subprocessors.
   QVO will provide notice of changes and an opportunity to object.

7. SECURITY
   QVO maintains administrative, technical, and physical safeguards including
   encryption in transit (TLS 1.2+) and at rest (AES-256), tenant isolation via
   Row Level Security, role-based access, and audit logging.

8. DATA SUBJECT RIGHTS
   QVO will assist Customer in responding to requests from Data Subjects to exercise
   their rights under applicable law, including access, rectification, erasure,
   restriction, portability, and objection.

9. PERSONAL DATA BREACH
   QVO will notify Customer without undue delay after becoming aware of a Personal
   Data Breach and provide reasonably available information.

10. DELETION & RETURN OF DATA
    Upon termination, QVO will delete or return Personal Data within 30 days unless
    retention is required by law.

11. INTERNATIONAL TRANSFERS
    Where Personal Data is transferred outside the EEA/UK, the parties rely on the
    Standard Contractual Clauses (2021/914) incorporated by reference.

12. AUDITS
    QVO will make available information necessary to demonstrate compliance with
    this DPA, including third-party attestation reports where available.

By signing the Master Services Agreement, Customer is deemed to have signed this DPA.

For execution copies countersigned by QVO, contact: privacy@qvo.example
`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="QVO-DPA-DRAFT.txt"');
  return res.send(dpa);
});

export default router;
