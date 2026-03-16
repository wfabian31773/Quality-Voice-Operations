import { Router } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { getProvisioningStatus } from '../../../platform/tenant/provisioning/TenantProvisioningService';
import { getRegisteredTemplates } from '../../../platform/agent-templates/registry';

const router = Router();
const logger = createLogger('ADMIN_TENANTS');

router.get('/tenants/me', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT id, name, slug, domain, status, plan, settings, feature_flags, created_at, updated_at
       FROM tenants WHERE id = $1`,
      [tenantId],
    );
    await client.query('COMMIT');

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    return res.json({ tenant: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to get tenant', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve tenant' });
  } finally {
    client.release();
  }
});

router.get('/tenants/me/provisioning-status', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;

  try {
    const status = await getProvisioningStatus(tenantId);
    return res.json(status);
  } catch (err) {
    logger.error('Failed to get provisioning status', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve provisioning status' });
  }
});

router.get('/agent-types', requireAuth, (_req, res) => {
  return res.json({ agentTypes: getRegisteredTemplates() });
});

const VALID_IANA_TIMEZONES = (() => {
  try {
    return new Set(Intl.supportedValuesOf('timeZone'));
  } catch {
    return null;
  }
})();

function isValidTimezone(tz: string): boolean {
  if (VALID_IANA_TIMEZONES) return VALID_IANA_TIMEZONES.has(tz);
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

router.patch('/tenants/me', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const { name, domain, settings } = req.body as {
    name?: string;
    domain?: string;
    settings?: Record<string, unknown>;
  };

  if (settings && settings.timezone !== undefined) {
    if (typeof settings.timezone !== 'string' || !isValidTimezone(settings.timezone)) {
      return res.status(400).json({ error: `Invalid timezone: "${settings.timezone}". Must be a valid IANA timezone identifier.` });
    }
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const updates: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [tenantId];

    if (name) { values.push(name); updates.push(`name = $${values.length}`); }
    if (domain !== undefined) { values.push(domain); updates.push(`domain = $${values.length}`); }
    if (settings) { values.push(JSON.stringify(settings)); updates.push(`settings = $${values.length}`); }

    const { rows } = await client.query(
      `UPDATE tenants SET ${updates.join(', ')} WHERE id = $1
       RETURNING id, name, slug, domain, status, plan, settings, updated_at`,
      values,
    );
    await client.query('COMMIT');
    return res.json({ tenant: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to update tenant', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update tenant' });
  } finally {
    client.release();
  }
});

export default router;
