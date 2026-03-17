import { Router, Request, Response } from 'express';
import { createLogger } from '../../../platform/core/logger';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import {
  chat,
  getGreeting,
  getLeads,
  getAnalyticsSummary,
} from '../../../platform/website-agent/WebsiteSalesAgentService';

const router = Router();
const logger = createLogger('WEBSITE_AGENT_ROUTES');

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 30;
const RATE_WINDOW = 60 * 1000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 60 * 1000);

router.post('/website-agent/chat', async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  const { message, conversationId, sourcePage } = req.body as {
    message?: string;
    conversationId?: string;
    sourcePage?: string;
  };

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Message is required' });
  }

  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message too long' });
  }

  let cid = conversationId || `ws_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  if (typeof cid !== 'string' || cid.length > 100) {
    cid = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
  cid = cid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);

  let page = typeof sourcePage === 'string' ? sourcePage : '/';
  if (page.length > 200) page = page.slice(0, 200);
  page = page.replace(/[^a-zA-Z0-9/_?=&.-]/g, '').slice(0, 200);

  try {
    const result = await chat(cid, message.trim(), page);
    return res.json(result);
  } catch (err) {
    logger.error('Website agent chat error', { error: String(err) });
    return res.status(500).json({ error: 'Failed to process message' });
  }
});

router.get('/website-agent/greeting', (req: Request, res: Response) => {
  const page = (req.query.page as string) || '/';
  const greeting = getGreeting(page);
  return res.json({ greeting, page });
});

router.get('/website-agent/leads', requireAuth, requirePlatformAdmin, async (_req: Request, res: Response) => {
  try {
    const status = _req.query.status as string | undefined;
    const limit = Math.min(parseInt(_req.query.limit as string) || 50, 200);
    const offset = parseInt(_req.query.offset as string) || 0;
    const result = await getLeads(status, limit, offset);
    return res.json(result);
  } catch (err) {
    logger.error('Failed to get leads', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get leads' });
  }
});

router.get('/website-agent/analytics', requireAuth, requirePlatformAdmin, async (_req: Request, res: Response) => {
  try {
    const summary = await getAnalyticsSummary();
    return res.json(summary);
  } catch (err) {
    logger.error('Failed to get analytics', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get analytics' });
  }
});

export default router;
