import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { generateApiKey, listApiKeys, revokeApiKey } from '../../../platform/rbac/ApiKeyService';
import { createLogger } from '../../../platform/core/logger';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';

const router = Router();
const logger = createLogger('ADMIN_API_KEYS');

router.get('/settings/api-keys', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const keys = await listApiKeys(req.user!.tenantId);
    res.json({ keys });
  } catch (err) {
    logger.error('Failed to list API keys', { error: String(err) });
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

router.post('/settings/api-keys', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, scopes, expiresAt } = req.body as {
    name?: string;
    scopes?: string[];
    expiresAt?: string;
  };

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  try {
    const result = await generateApiKey(
      req.user!.tenantId,
      name.trim(),
      scopes ?? ['*'],
      expiresAt ? new Date(expiresAt) : null,
    );

    writeAuditLog({
      tenantId: req.user!.tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'api_key.created',
      resourceType: 'api_key',
      resourceId: result.key.id,
      changes: { name: name.trim() },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({ key: result.key, plaintextKey: result.plaintextKey });
  } catch (err) {
    logger.error('Failed to generate API key', { error: String(err) });
    res.status(500).json({ error: 'Failed to generate API key' });
  }
});

router.delete('/settings/api-keys/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const revoked = await revokeApiKey(req.user!.tenantId, req.params.id);
    if (!revoked) {
      res.status(404).json({ error: 'API key not found or already revoked' });
      return;
    }

    writeAuditLog({
      tenantId: req.user!.tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'api_key.revoked',
      resourceType: 'api_key',
      resourceId: req.params.id,
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to revoke API key', { error: String(err) });
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

export default router;
