import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { getPlatformPool } from '../../../platform/db';
import { createRateLimiter } from '../../../platform/infra/rate-limit/createRateLimiter';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('DEMO_ANALYTICS');
const router = Router();

const DEMO_TENANT_ID = 'demo';
const DEMO_DATA_RETENTION_MS = 15 * 60 * 1000;

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded)) return forwarded[0];
  return req.socket?.remoteAddress ?? 'unknown';
}

function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

const demoActivityLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 30,
  message: 'Too many demo requests. Please try again shortly.',
  keyGenerator: (req) => `demo:${getClientIp(req)}`,
});

const demoCTALimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 20,
  message: 'Too many requests.',
  keyGenerator: (req) => `demo-cta:${getClientIp(req)}`,
});

export async function recordDemoAnalyticsEvent(
  eventType: string,
  ipHash: string,
  agentType?: string,
  durationSeconds?: number,
  ctaType?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    const pool = getPlatformPool();
    await pool.query(
      `INSERT INTO demo_analytics (event_type, agent_type, ip_hash, duration_seconds, cta_type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [eventType, agentType ?? null, ipHash, durationSeconds ?? null, ctaType ?? null, JSON.stringify(metadata ?? {})],
    );
  } catch (err) {
    logger.warn('Failed to record demo analytics event', { eventType, error: String(err) });
  }
}

export function scheduleDemoDataCleanup(callSessionId: string, retentionMs: number = DEMO_DATA_RETENTION_MS): void {
  setTimeout(async () => {
    try {
      const pool = getPlatformPool();
      await pool.query(
        `DELETE FROM call_events WHERE call_session_id = $1 AND tenant_id = $2`,
        [callSessionId, DEMO_TENANT_ID],
      );
      await pool.query(
        `UPDATE call_sessions SET context = '{}'::jsonb WHERE id = $1 AND tenant_id = $2`,
        [callSessionId, DEMO_TENANT_ID],
      );
      logger.info('Demo session data cleaned up', { callSessionId });
    } catch (err) {
      logger.warn('Failed to clean up demo session data', { callSessionId, error: String(err) });
    }
  }, retentionMs);
}

async function sweepStaleDemoData(): Promise<void> {
  try {
    const pool = getPlatformPool();
    const retentionMinutes = Math.ceil(DEMO_DATA_RETENTION_MS / 60_000);
    const { rowCount: eventsDeleted } = await pool.query(
      `DELETE FROM call_events
       WHERE tenant_id = $1
         AND call_session_id IN (
           SELECT id FROM call_sessions
           WHERE tenant_id = $1
             AND lifecycle_state IN ('CALL_COMPLETED', 'CALL_FAILED', 'WORKFLOW_FAILED', 'ESCALATION_FAILED')
             AND end_time IS NOT NULL
             AND end_time < NOW() - INTERVAL '1 minute' * $2
         )`,
      [DEMO_TENANT_ID, retentionMinutes],
    );
    const { rowCount: sessionsCleared } = await pool.query(
      `UPDATE call_sessions
       SET context = '{}'::jsonb
       WHERE tenant_id = $1
         AND lifecycle_state IN ('CALL_COMPLETED', 'CALL_FAILED', 'WORKFLOW_FAILED', 'ESCALATION_FAILED')
         AND end_time IS NOT NULL
         AND end_time < NOW() - INTERVAL '1 minute' * $2
         AND context != '{}'::jsonb`,
      [DEMO_TENANT_ID, retentionMinutes],
    );
    if ((eventsDeleted ?? 0) > 0 || (sessionsCleared ?? 0) > 0) {
      logger.info('Stale demo data swept', { eventsDeleted, sessionsCleared });
    }
  } catch (err) {
    logger.warn('Demo data sweep failed', { error: String(err) });
  }
}

setInterval(sweepStaleDemoData, 5 * 60_000);

function mapEventType(raw: string): string {
  const map: Record<string, string> = {
    call_received: 'call_started',
    agent_connected: 'call_started',
    workflow_execution_start: 'workflow_triggered',
    tool_start: 'workflow_triggered',
    tool_end: 'workflow_triggered',
    escalation_active: 'workflow_triggered',
    escalation_success: 'workflow_triggered',
    escalation_failed: 'workflow_triggered',
    call_completed: 'call_ended',
    session_closed: 'call_ended',
  };
  return map[raw.toLowerCase()] ?? raw.toLowerCase();
}

router.get('/demo/activity', demoActivityLimiter, async (_req: Request, res: Response) => {
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query(
      `SELECT
         ce.id,
         ce.event_type,
         a.name AS agent_name,
         cs.duration_seconds,
         ce.occurred_at
       FROM call_events ce
       JOIN call_sessions cs ON cs.id = ce.call_session_id
       JOIN agents a ON a.id = cs.agent_id
       WHERE ce.tenant_id = $1
         AND LOWER(ce.event_type) IN ('call_received', 'agent_connected', 'workflow_execution_start', 'tool_start', 'tool_end', 'call_completed', 'session_closed', 'escalation_active', 'escalation_success', 'escalation_failed')
       ORDER BY ce.occurred_at DESC
       LIMIT 10`,
      [DEMO_TENANT_ID],
    );

    const events = rows.map((row) => {
      const mapped = mapEventType(row.event_type as string);
      return {
        id: row.id as string,
        eventType: mapped,
        agentName: row.agent_name as string,
        durationSeconds: mapped === 'call_ended' ? (row.duration_seconds as number | null) : null,
        timestamp: row.occurred_at as string,
      };
    });

    res.json({ events });
  } catch (err) {
    console.error('[DEMO] Failed to fetch activity:', err);
    res.status(500).json({ error: 'Failed to fetch demo activity' });
  }
});

router.get('/demo/stats', demoActivityLimiter, async (_req: Request, res: Response) => {
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query(
      `SELECT demo_call_count FROM tenants WHERE id = $1`,
      [DEMO_TENANT_ID],
    );

    const totalCalls = rows[0]?.demo_call_count ?? 0;

    const { rows: sessionCount } = await pool.query(
      `SELECT COUNT(*) AS count FROM call_sessions WHERE tenant_id = $1`,
      [DEMO_TENANT_ID],
    );

    res.json({
      totalCalls: Math.max(totalCalls as number, parseInt(sessionCount[0]?.count as string, 10)),
    });
  } catch (err) {
    console.error('[DEMO] Failed to fetch stats:', err);
    res.status(500).json({ error: 'Failed to fetch demo stats' });
  }
});

router.get('/demo/phones', demoActivityLimiter, async (_req: Request, res: Response) => {
  try {
    const pool = getPlatformPool();

    const { rows: tenantCheck } = await pool.query(
      `SELECT id FROM tenants WHERE id = $1 AND is_demo = true`,
      [DEMO_TENANT_ID],
    );

    if (tenantCheck.length === 0) {
      res.json({ configured: false, phones: [], message: 'Demo system is not configured.' });
      return;
    }

    const { rows } = await pool.query(
      `SELECT
         pn.phone_number,
         pn.friendly_name,
         da.agent_template
       FROM phone_numbers pn
       LEFT JOIN number_routing nr ON nr.phone_number_id = pn.id AND nr.is_active = true
       LEFT JOIN agents a ON a.id = nr.agent_id
       LEFT JOIN demo_agents da ON da.tenant_id = pn.tenant_id AND da.agent_template = a.type
       WHERE pn.tenant_id = $1
         AND pn.is_demo = true
         AND pn.status = 'active'
       ORDER BY pn.friendly_name`,
      [DEMO_TENANT_ID],
    );

    const isPlaceholder = (num: string) => num.startsWith('+1555') || num.startsWith('+15550');

    const phones = rows.map((r) => ({
      phoneNumber: r.phone_number as string,
      friendlyName: r.friendly_name as string,
      agentTemplate: (r.agent_template as string) ?? null,
      isPlaceholder: isPlaceholder(r.phone_number as string),
    }));

    res.json({
      configured: phones.some((p) => !p.isPlaceholder),
      phones,
    });
  } catch (err) {
    console.error('[DEMO] Failed to fetch phones:', err);
    res.status(500).json({ error: 'Failed to fetch demo phones' });
  }
});

const DEMO_AGENT_METADATA: Record<string, { icon: string; category: string; useCases: string[] }> = {
  'answering-service': {
    icon: 'headphones',
    category: 'General',
    useCases: ['Take messages', 'Route calls by priority', 'After-hours coverage'],
  },
  'medical-after-hours': {
    icon: 'stethoscope',
    category: 'Healthcare',
    useCases: ['Triage urgency levels', 'Collect callback info', 'Notify on-call providers'],
  },
  'dental': {
    icon: 'calendar',
    category: 'Healthcare',
    useCases: ['Schedule appointments', 'New patient intake', 'Emergency detection'],
  },
  'property-management': {
    icon: 'building',
    category: 'Real Estate',
    useCases: ['Qualify buyer/seller leads', 'Schedule showings', 'Property inquiries'],
  },
  'legal': {
    icon: 'scale',
    category: 'Professional Services',
    useCases: ['Case intake & categorization', 'Schedule consultations', 'Practice area routing'],
  },
  'customer-support': {
    icon: 'help-circle',
    category: 'Support',
    useCases: ['Create support tickets', 'Troubleshoot issues', 'Escalation handling'],
  },
  'collections': {
    icon: 'dollar-sign',
    category: 'Financial',
    useCases: ['Account lookup', 'Payment arrangements', 'FDCPA compliance'],
  },
  'home-services': {
    icon: 'wrench',
    category: 'Home Services',
    useCases: ['Book repair appointments', 'Qualify emergencies', 'Dispatch technicians'],
  },
};

router.get('/demo/agents', demoActivityLimiter, async (_req: Request, res: Response) => {
  try {
    const pool = getPlatformPool();

    const { rows: tenantCheck } = await pool.query(
      `SELECT id FROM tenants WHERE id = $1 AND is_demo = true`,
      [DEMO_TENANT_ID],
    );

    if (tenantCheck.length === 0) {
      res.json({ agents: [], message: 'Demo system is not configured.' });
      return;
    }

    const { rows } = await pool.query(
      `SELECT
         da.id,
         da.name,
         da.description,
         da.agent_template,
         da.voice_id,
         da.is_active,
         pn.phone_number
       FROM demo_agents da
       LEFT JOIN agents a ON a.tenant_id = da.tenant_id AND a.type = da.agent_template AND a.status = 'active'
       LEFT JOIN number_routing nr ON nr.agent_id = a.id AND nr.is_active = true
       LEFT JOIN phone_numbers pn ON pn.id = nr.phone_number_id AND pn.is_demo = true AND pn.status = 'active'
       WHERE da.tenant_id = $1
         AND da.is_active = true
       ORDER BY da.name`,
      [DEMO_TENANT_ID],
    );

    const isPlaceholder = (num: string) => num.startsWith('+1555') || num.startsWith('+15550');

    const agents = rows.map((r) => {
      const template = r.agent_template as string;
      const meta = DEMO_AGENT_METADATA[template] ?? { icon: 'phone', category: 'General', useCases: [] };
      const phoneNumber = (r.phone_number as string) ?? null;

      return {
        id: r.id as string,
        name: r.name as string,
        type: template,
        description: r.description as string,
        template,
        voiceId: r.voice_id as string,
        phoneNumber,
        isPlaceholder: phoneNumber ? isPlaceholder(phoneNumber) : true,
        icon: meta.icon,
        category: meta.category,
        capabilities: meta.useCases,
        useCases: meta.useCases,
      };
    });

    res.json({ agents });
  } catch (err) {
    console.error('[DEMO] Failed to fetch agents:', err);
    res.status(500).json({ error: 'Failed to fetch demo agents' });
  }
});

router.post('/demo/track-cta', demoCTALimiter, async (req: Request, res: Response) => {
  try {
    const { ctaType, agentType } = req.body as { ctaType?: string; agentType?: string };

    if (!ctaType || typeof ctaType !== 'string') {
      res.status(400).json({ error: 'ctaType is required' });
      return;
    }

    const allowedCtaTypes = ['start_free_trial', 'book_demo'];
    if (!allowedCtaTypes.includes(ctaType)) {
      res.status(400).json({ error: 'Invalid ctaType' });
      return;
    }

    const ipHash = hashIp(getClientIp(req));
    await recordDemoAnalyticsEvent('cta_clicked', ipHash, agentType, undefined, ctaType);

    res.json({ ok: true });
  } catch (err) {
    logger.warn('Failed to track CTA click', { error: String(err) });
    res.status(500).json({ error: 'Failed to track CTA click' });
  }
});

router.get('/demo/analytics', requireAuth, requirePlatformAdmin, async (_req: Request, res: Response) => {
  try {
    const pool = getPlatformPool();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { rows: callStats } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE event_type = 'call_started') AS calls_started,
         COUNT(*) FILTER (WHERE event_type = 'call_completed') AS calls_completed,
         COUNT(*) FILTER (WHERE event_type = 'call_abandoned') AS calls_abandoned,
         COUNT(*) FILTER (WHERE event_type = 'cta_clicked') AS cta_clicks
       FROM demo_analytics
       WHERE created_at >= $1`,
      [todayStart.toISOString()],
    );

    const stats = callStats[0] ?? {};
    const started = parseInt(stats.calls_started as string, 10) || 0;
    const completed = parseInt(stats.calls_completed as string, 10) || 0;
    const abandoned = parseInt(stats.calls_abandoned as string, 10) || 0;
    const ctaClicks = parseInt(stats.cta_clicks as string, 10) || 0;

    const totalFinished = completed + abandoned;
    const completionRate = totalFinished > 0 ? Math.round((completed / totalFinished) * 100) : 0;
    const ctaClickRate = started > 0 ? Math.round((ctaClicks / started) * 100) : 0;

    const { rows: ctaBreakdown } = await pool.query(
      `SELECT cta_type, COUNT(*) AS count
       FROM demo_analytics
       WHERE event_type = 'cta_clicked' AND created_at >= $1
       GROUP BY cta_type`,
      [todayStart.toISOString()],
    );

    res.json({
      today: {
        callsStarted: started,
        callsCompleted: completed,
        callsAbandoned: abandoned,
        completionRate,
        ctaClicks,
        ctaClickRate,
        ctaBreakdown: ctaBreakdown.map((r) => ({
          type: r.cta_type as string,
          count: parseInt(r.count as string, 10),
        })),
      },
    });
  } catch (err) {
    logger.error('Failed to fetch demo analytics', { error: String(err) });
    res.status(500).json({ error: 'Failed to fetch demo analytics' });
  }
});

export default router;
