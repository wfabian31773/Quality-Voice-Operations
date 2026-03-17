import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import {
  recordConversionEvent,
  getWebsiteFunnel,
  getConversionTrends,
} from '../../../platform/analytics/WebsiteConversionService';
import type { ConversionStage } from '../../../platform/analytics/WebsiteConversionService';

const router = Router();
const logger = createLogger('CONVERSION_ROUTES');

const VALID_STAGES: ConversionStage[] = [
  'page_view', 'cta_click', 'demo_started', 'demo_completed',
  'signup_started', 'signup_completed', 'trial_started', 'paid',
];

const conversionRateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 60;
const RATE_WINDOW = 60 * 1000;

function checkConversionRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = conversionRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    conversionRateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of conversionRateLimitMap) {
    if (now > entry.resetAt) conversionRateLimitMap.delete(ip);
  }
}, 60 * 1000);

router.post('/conversion/event', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkConversionRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const { visitorId, stage, landingPage, utm, metadata } = req.body as {
    visitorId?: string;
    stage?: string;
    landingPage?: string;
    utm?: { source?: string; medium?: string; campaign?: string; content?: string; term?: string };
    metadata?: Record<string, unknown>;
  };

  if (!visitorId || typeof visitorId !== 'string' || visitorId.length > 100) {
    return res.status(400).json({ error: 'visitorId is required and must be under 100 characters' });
  }
  if (!stage || !VALID_STAGES.includes(stage as ConversionStage)) {
    return res.status(400).json({ error: 'Invalid stage' });
  }
  if (landingPage && (typeof landingPage !== 'string' || landingPage.length > 500)) {
    return res.status(400).json({ error: 'landingPage must be under 500 characters' });
  }
  if (utm) {
    for (const [key, val] of Object.entries(utm)) {
      if (val && (typeof val !== 'string' || val.length > 200)) {
        return res.status(400).json({ error: `utm.${key} must be a string under 200 characters` });
      }
    }
  }

  try {
    await recordConversionEvent(
      visitorId,
      stage as ConversionStage,
      landingPage ?? '/',
      utm,
      metadata,
    );
    return res.json({ ok: true });
  } catch (err) {
    logger.error('Failed to record conversion event', { error: String(err) });
    return res.status(500).json({ error: 'Failed to record event' });
  }
});

function parseDateRange(query: Record<string, unknown>): { from: Date; to: Date } {
  const now = new Date();
  const range = String(query.range ?? '30d');
  let days = 30;
  if (range === '7d') days = 7;
  else if (range === '90d') days = 90;

  if (query.from) {
    const from = new Date(String(query.from));
    const to = query.to ? new Date(String(query.to)) : now;
    if (!isNaN(from.getTime()) && !isNaN(to.getTime())) {
      return { from, to };
    }
  }

  return { from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000), to: now };
}

router.get('/admin/conversion/funnel', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { from, to } = parseDateRange(req.query as Record<string, unknown>);
    const funnel = await getWebsiteFunnel(from, to);
    return res.json(funnel);
  } catch (err) {
    logger.error('Failed to get conversion funnel', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get funnel data' });
  }
});

router.get('/admin/conversion/trends', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { from, to } = parseDateRange(req.query as Record<string, unknown>);
    const trends = await getConversionTrends(from, to);
    return res.json(trends);
  } catch (err) {
    logger.error('Failed to get conversion trends', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get trends data' });
  }
});

export default router;
