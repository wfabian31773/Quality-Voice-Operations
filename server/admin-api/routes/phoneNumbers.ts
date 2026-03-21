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
const MONTHLY_COST_CENTS = 200;

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

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error('Twilio credentials not configured');
  }
  const twilio = require('twilio');
  return twilio(accountSid, authToken);
}

function getVoiceWebhookUrl(): string {
  const base = process.env.VOICE_GATEWAY_BASE_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`;
  return `${base}/twilio/voice`;
}

function getStatusCallbackUrl(): string {
  const base = process.env.VOICE_GATEWAY_BASE_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`;
  return `${base}/twilio/status`;
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
              pn.is_free_number, pn.monthly_cost_cents, pn.provisioned_via,
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

    const total = parseInt(countRows[0].total as string);

    const { rows: freeRows } = await client.query(
      `SELECT COALESCE(BOOL_OR(is_free_number), FALSE) AS has_free FROM phone_numbers WHERE tenant_id = $1`,
      [tenantId],
    );
    const hasUsedFreeNumber = freeRows[0].has_free as boolean;

    return res.json({
      phoneNumbers: rows.map(redactPhoneRow),
      total,
      limit,
      offset,
      hasUsedFreeNumber,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to list phone numbers', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list phone numbers' });
  } finally {
    client.release();
  }
});

router.get('/phone-numbers/available', requireAuth, requireRole('manager'), async (req, res) => {
  const areaCode = String(req.query.areaCode || '');
  const state = String(req.query.state || '');
  const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10), 20);

  try {
    const twilioClient = getTwilioClient();

    const searchParams: Record<string, unknown> = {
      voiceEnabled: true,
      smsEnabled: true,
      limit,
    };

    if (areaCode && /^\d{3}$/.test(areaCode)) {
      searchParams.areaCode = areaCode;
    }
    if (state && /^[A-Z]{2}$/.test(state.toUpperCase())) {
      searchParams.inRegion = state.toUpperCase();
    }

    const numbers = await twilioClient.availablePhoneNumbers('US')
      .local
      .list(searchParams);

    const available = numbers.map((n: { phoneNumber: string; friendlyName: string; locality: string; region: string; capabilities: Record<string, boolean> }) => ({
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
      locality: n.locality,
      region: n.region,
      capabilities: n.capabilities,
    }));

    return res.json({ available, monthlyCostCents: MONTHLY_COST_CENTS });
  } catch (err) {
    logger.error('Failed to search available numbers', { error: String(err) });
    return res.status(500).json({ error: 'Failed to search available phone numbers' });
  }
});

router.post('/phone-numbers/provision', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { phone_number, friendly_name, agent_id } = req.body as Record<string, unknown>;

  if (!phone_number || typeof phone_number !== 'string') {
    return res.status(400).json({ error: 'phone_number is required' });
  }
  if (!E164_REGEX.test(phone_number)) {
    return res.status(400).json({ error: 'phone_number must be in E.164 format' });
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: existingRows } = await client.query(
      `SELECT COUNT(*) AS total, COALESCE(BOOL_OR(is_free_number), FALSE) AS has_free
       FROM phone_numbers WHERE tenant_id = $1`,
      [tenantId],
    );
    const existing = existingRows[0];
    const currentCount = parseInt(existing.total as string);
    const hasFreeNumber = existing.has_free as boolean;
    const isFirstNumber = currentCount === 0 && !hasFreeNumber;

    const twilioClient = getTwilioClient();

    const purchasedNumber = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: phone_number,
      voiceUrl: getVoiceWebhookUrl(),
      voiceMethod: 'POST',
      statusCallback: getStatusCallbackUrl(),
      statusCallbackMethod: 'POST',
      friendlyName: `QVO-${tenantId}-${friendly_name || 'Line'}`,
    });

    const { rows: [pn] } = await client.query(
      `INSERT INTO phone_numbers (tenant_id, phone_number, friendly_name, twilio_sid, capabilities, status, is_free_number, monthly_cost_cents, provisioned_via)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, 'platform')
       ON CONFLICT (tenant_id, phone_number) DO UPDATE SET
         friendly_name = EXCLUDED.friendly_name, twilio_sid = EXCLUDED.twilio_sid,
         capabilities = EXCLUDED.capabilities, is_free_number = EXCLUDED.is_free_number,
         monthly_cost_cents = EXCLUDED.monthly_cost_cents, provisioned_via = EXCLUDED.provisioned_via,
         updated_at = NOW()
       RETURNING *`,
      [
        tenantId,
        phone_number,
        (friendly_name as string) || null,
        purchasedNumber.sid,
        JSON.stringify({ voice: true, sms: true }),
        isFirstNumber,
        isFirstNumber ? 0 : MONTHLY_COST_CENTS,
      ],
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

    logger.info('Phone number provisioned via Twilio', {
      tenantId,
      phoneId: pn.id,
      twilioSid: purchasedNumber.sid,
      isFree: isFirstNumber,
    });

    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'phone_number.provisioned',
      resourceType: 'phone_number',
      resourceId: pn.id as string,
      afterState: { isFree: isFirstNumber, monthlyCost: isFirstNumber ? 0 : MONTHLY_COST_CENTS },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    import('../../../platform/activation/ActivationService')
      .then(({ recordActivationEvent }) =>
        recordActivationEvent(tenantId, 'tenant_phone_connected', { phoneId: pn.id }),
      )
      .catch(() => {});

    return res.status(201).json({
      phoneNumber: redactPhoneRow(pn as Record<string, unknown>),
      isFreeNumber: isFirstNumber,
      monthlyCostCents: isFirstNumber ? 0 : MONTHLY_COST_CENTS,
      twilioSid: purchasedNumber.sid,
    });
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to provision phone number', { tenantId, error: errMsg });

    if (errMsg.includes('not available')) {
      return res.status(409).json({ error: 'This number is no longer available. Please pick a different one.' });
    }
    if (errMsg.includes('idx_phone_numbers_one_free_per_tenant') || errMsg.includes('duplicate key')) {
      return res.status(409).json({ error: 'Your free number has already been claimed. This number will be added at $2.00/month.' });
    }
    return res.status(500).json({ error: 'Failed to provision phone number. Please try again.' });
  } finally {
    client.release();
  }
});

router.post('/phone-numbers', requireAuth, requireRole('manager'), async (req, res) => {
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

router.patch('/phone-numbers/:id/routing', requireAuth, requireRole('manager'), async (req, res) => {
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

router.delete('/phone-numbers/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT id, twilio_sid, provisioned_via, phone_number FROM phone_numbers WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Phone number not found' });
    }

    const pn = rows[0] as { twilio_sid: string | null; provisioned_via: string | null; phone_number: string };

    if (pn.twilio_sid && pn.provisioned_via === 'platform') {
      try {
        const twilioClient = getTwilioClient();
        await twilioClient.incomingPhoneNumbers(pn.twilio_sid).remove();
        logger.info('Released number from Twilio', { tenantId, twilioSid: pn.twilio_sid });
      } catch (twilioErr) {
        const errMsg = String(twilioErr);
        if (errMsg.includes('not found') || errMsg.includes('20404')) {
          logger.warn('Number already removed from Twilio, proceeding with DB cleanup', {
            tenantId,
            twilioSid: pn.twilio_sid,
          });
        } else {
          await client.query('ROLLBACK');
          logger.error('Failed to release number from Twilio', {
            tenantId,
            twilioSid: pn.twilio_sid,
            error: errMsg,
          });
          return res.status(502).json({
            error: 'Failed to release number from phone network. Please try again.',
          });
        }
      }
    }

    await client.query(
      `DELETE FROM phone_numbers WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    await client.query('COMMIT');

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
    logger.error('Failed to delete phone number', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete phone number' });
  } finally {
    client.release();
  }
});

export default router;
