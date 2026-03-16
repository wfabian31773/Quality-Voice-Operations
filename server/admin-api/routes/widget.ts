import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import {
  getWidgetConfig,
  upsertWidgetConfig,
  generateWidgetToken,
  listWidgetTokens,
  revokeWidgetToken,
  validateWidgetToken,
  getPublicWidgetConfig,
} from '../../../platform/widget/WidgetTokenService';

const router = Router();
const logger = createLogger('ADMIN_WIDGET');

router.get('/widget/config', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const config = await getWidgetConfig(tenantId);
    return res.json({ config: config ?? null });
  } catch (err) {
    logger.error('Failed to get widget config', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get widget config' });
  }
});

router.put('/widget/config', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const body = req.body as Record<string, unknown>;

  const allowed: (keyof typeof body)[] = [
    'agent_id', 'enabled', 'greeting', 'lead_capture_fields',
    'primary_color', 'allowed_domains', 'text_chat_enabled', 'voice_enabled',
  ];

  const update: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) update[key] = body[key];
  }

  if (update.primary_color && typeof update.primary_color === 'string') {
    if (!/^#[0-9a-fA-F]{6}$/.test(update.primary_color)) {
      return res.status(400).json({ error: 'primary_color must be a valid hex color (e.g. #6366f1)' });
    }
  }

  try {
    const config = await upsertWidgetConfig(tenantId, update);
    return res.json({ config });
  } catch (err) {
    logger.error('Failed to update widget config', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update widget config' });
  }
});

router.get('/widget/tokens', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const tokens = await listWidgetTokens(tenantId);
    return res.json({ tokens });
  } catch (err) {
    logger.error('Failed to list widget tokens', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list widget tokens' });
  }
});

router.post('/widget/tokens', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const { label } = req.body as { label?: string };

  try {
    const result = await generateWidgetToken(tenantId, label ?? 'Default');
    return res.status(201).json({ token: result.token, plaintextToken: result.plaintextToken });
  } catch (err) {
    logger.error('Failed to generate widget token', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to generate widget token' });
  }
});

router.delete('/widget/tokens/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;

  try {
    const revoked = await revokeWidgetToken(tenantId, id);
    if (!revoked) {
      return res.status(404).json({ error: 'Token not found or already revoked' });
    }
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to revoke widget token', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to revoke widget token' });
  }
});

router.get('/widget/public-config', async (req, res) => {
  const token = req.query.token as string;
  if (!token) {
    return res.status(400).json({ error: 'Missing token parameter' });
  }

  try {
    const validated = await validateWidgetToken(token);
    if (!validated) {
      return res.status(401).json({ error: 'Invalid or revoked widget token' });
    }

    const fullConfig = await getWidgetConfig(validated.tenantId);
    if (fullConfig && fullConfig.allowed_domains && fullConfig.allowed_domains.length > 0) {
      const origin = req.headers.origin || req.headers.referer || '';
      const requestHost = origin ? new URL(origin).hostname : '';
      const allowed = fullConfig.allowed_domains.some(
        (d) => requestHost === d || requestHost.endsWith('.' + d),
      );
      if (!allowed) {
        logger.warn('Widget config request from unauthorized domain', {
          tenantId: validated.tenantId,
          origin,
          allowedDomains: fullConfig.allowed_domains,
        });
        return res.status(403).json({ error: 'Domain not authorized' });
      }
    }

    const config = await getPublicWidgetConfig(validated.tenantId);
    if (!config) {
      return res.status(404).json({ error: 'Widget not configured or disabled' });
    }

    const allowOrigin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json({ config });
  } catch (err) {
    logger.error('Failed to get public widget config', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get widget config' });
  }
});

let cachedEmbedJs: string | null = null;

router.get('/widget/embed.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');

  if (cachedEmbedJs) {
    return res.send(cachedEmbedJs);
  }

  const embedPath = path.resolve(__dirname, '../../../widget/embed.js');
  try {
    cachedEmbedJs = fs.readFileSync(embedPath, 'utf8');
    return res.send(cachedEmbedJs);
  } catch (err) {
    logger.error('Failed to read widget embed script', { error: String(err), path: embedPath });
    return res.status(404).send('// Widget embed script not found');
  }
});

export default router;
