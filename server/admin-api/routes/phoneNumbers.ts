import { Router } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { redactPHI } from '../../../platform/core/phi/redact';
import { createLogger } from '../../../platform/core/logger';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';

const router = Router();
const logger = createLogger('ADMIN_PHONE_NUMBERS');

const E164_REGEX = /^\+[1-9]\d{7,14}$/;

function paginate(req: { query: Record<string, unknown> }): { limit: number; offset: number } {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  return { limit, offset: (page - 1) * limit };
}

function redactPhoneRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    phone_number: row.phone_number ? redactPHI(row.phone_number as string) : null,
  };
}

router.get('/phone-numbers', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT pn.id, pn.phone_number, pn.friendly_name, pn.twilio_sid, pn.capabilities,
              pn.status, pn.provisioned_at, pn.created_at,
              nr.agent_id AS routed_agent_id, nr.is_active AS routing_active
       FROM phone_numbers pn
       LEFT JOIN number_routing nr ON nr.phone_number_id = pn.id AND nr.is_active = TRUE
       WHERE pn.tenant_id = $1
       ORDER BY pn.created_at DESC
       LIMIT $2 OFFSET $3`,
      [tenantId, limit, offset],
    );

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*) AS total FROM phone_numbers WHERE tenant_id = $1`,
      [tenantId],
    );
    await client.query('COMMIT');

    return res.json({
      phoneNumbers: rows.map(redactPhoneRow),
      total: parseInt(countRows[0].total as string),
      limit,
      offset,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to list phone numbers', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list phone numbers' });
  } finally {
    client.release();
  }
});

router.post('/phone-numbers', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const { phone_number, friendly_name, twilio_sid, agent_id, capabilities } = req.body as Record<string, unknown>;

  if (!phone_number || typeof phone_number !== 'string') {
    return res.status(400).json({ error: 'phone_number is required' });
  }
  if (!E164_REGEX.test(phone_number)) {
    return res.status(400).json({ error: 'phone_number must be in E.164 format (e.g. +12125551234)' });
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: [pn] } = await client.query(
      `INSERT INTO phone_numbers (tenant_id, phone_number, friendly_name, twilio_sid, capabilities, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       ON CONFLICT (tenant_id, phone_number) DO UPDATE SET
         friendly_name = EXCLUDED.friendly_name, twilio_sid = EXCLUDED.twilio_sid,
         capabilities = EXCLUDED.capabilities, updated_at = NOW()
       RETURNING *`,
      [tenantId, phone_number, friendly_name ?? null, twilio_sid ?? null,
       JSON.stringify(capabilities ?? { voice: true, sms: true })],
    );

    if (agent_id) {
      await client.query(
        `INSERT INTO number_routing (tenant_id, phone_number_id, agent_id, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (phone_number_id, agent_id) DO UPDATE SET is_active = TRUE`,
        [tenantId, pn.id, agent_id],
      );
    }

    await client.query('COMMIT');
    logger.info('Phone number added', { tenantId, phoneId: pn.id });
    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'phone_number.created',
      resourceType: 'phone_number',
      resourceId: pn.id as string,
      afterState: { phoneNumber: phone_number, agentId: agent_id ?? null },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    import('../../../platform/activation/ActivationService')
      .then(({ recordActivationEvent }) => recordActivationEvent(tenantId, 'tenant_phone_connected', { phoneId: pn.id }))
      .catch(() => {});
    return res.status(201).json({ phoneNumber: redactPhoneRow(pn as Record<string, unknown>) });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to add phone number', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to add phone number' });
  } finally {
    client.release();
  }
});

router.patch('/phone-numbers/:id/routing', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { agent_id } = req.body as Record<string, unknown>;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT id FROM phone_numbers WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (rows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Phone number not found' });
    }

    await client.query(
      `UPDATE number_routing SET is_active = FALSE WHERE phone_number_id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (agent_id) {
      await client.query(
        `INSERT INTO number_routing (tenant_id, phone_number_id, agent_id, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (phone_number_id, agent_id) DO UPDATE SET is_active = TRUE`,
        [tenantId, id, agent_id],
      );
    }

    await client.query('COMMIT');
    logger.info('Phone number routing updated', { tenantId, phoneId: id, agentId: agent_id ?? null });
    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'phone_number.routing_updated',
      resourceType: 'phone_number',
      resourceId: id,
      changes: { agentId: agent_id ?? null },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.json({ updated: true, phoneNumberId: id, agentId: agent_id ?? null });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to update routing', { tenantId, phoneId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to update routing' });
  } finally {
    client.release();
  }
});

router.delete('/phone-numbers/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rowCount } = await client.query(
      `DELETE FROM phone_numbers WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    if (!rowCount) return res.status(404).json({ error: 'Phone number not found' });
    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'phone_number.deleted',
      resourceType: 'phone_number',
      resourceId: id,
      severity: 'warning',
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to delete phone number' });
  } finally {
    client.release();
  }
});

export default router;
