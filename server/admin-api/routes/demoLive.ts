import { Router, type Request, type Response } from 'express';
import { getPlatformPool } from '../../../platform/db';
import { createRateLimiter } from '../../../platform/infra/rate-limit/createRateLimiter';
import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('DEMO_LIVE');
const router = Router();

const DEMO_TENANT_ID = 'demo';

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded)) return forwarded[0];
  return req.socket?.remoteAddress ?? 'unknown';
}

const demoSSEStreamLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 5,
  message: 'Too many SSE connections. Please try again shortly.',
  keyGenerator: (req) => `demo-sse-stream:${getClientIp(req)}`,
});

const demoSSEPollLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 20,
  message: 'Too many polling requests. Please try again shortly.',
  keyGenerator: (req) => `demo-sse-poll:${getClientIp(req)}`,
});

interface CallEventRow {
  id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  occurred_at: string;
  from_state: string | null;
  to_state: string | null;
}

interface CallSessionRow {
  id: string;
  lifecycle_state: string;
  caller_number: string | null;
  agent_id: string;
  agent_name: string | null;
  start_time: string;
  end_time: string | null;
  duration_seconds: number | null;
  context: Record<string, unknown> | null;
}

function findPairedToolStart(
  allEvents: CallEventRow[],
  toolEndEvent: CallEventRow,
  _seenIds: Set<string>,
): string | null {
  const toolName = (toolEndEvent.payload as Record<string, unknown> | null)?.tool;
  if (!toolName) return null;
  for (let i = allEvents.length - 1; i >= 0; i--) {
    const e = allEvents[i];
    if (
      e.event_type.toLowerCase() === 'tool_start' &&
      (e.payload as Record<string, unknown> | null)?.tool === toolName &&
      new Date(e.occurred_at as string) <= new Date(toolEndEvent.occurred_at as string)
    ) {
      return e.id;
    }
  }
  return null;
}

router.get('/demo/live/:callId', demoSSEStreamLimiter, async (req: Request, res: Response) => {
  const { callId } = req.params;

  if (!callId || typeof callId !== 'string' || callId.length > 100) {
    res.status(400).json({ error: 'Invalid call ID' });
    return;
  }

  const pool = getPlatformPool();

  try {
    const { rows: sessionCheck } = await pool.query(
      `SELECT id FROM call_sessions WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [callId, DEMO_TENANT_ID],
    );

    if (sessionCheck.length === 0) {
      res.status(404).json({ error: 'Call not found' });
      return;
    }
  } catch (err) {
    logger.error('Failed to validate call session', { callId, error: String(err) });
    res.status(500).json({ error: 'Internal error' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(':\n\n');

  let alive = true;
  const seenEventIds = new Set<string>();
  let lastState: string | null = null;
  let lastTranscriptLength = 0;
  let trailingPartialLine = '';

  const poll = async () => {
    if (!alive) return;

    try {
      const { rows: sessionRows } = await pool.query<CallSessionRow>(
        `SELECT cs.id, cs.lifecycle_state, cs.caller_number, cs.agent_id,
                a.name AS agent_name, cs.start_time, cs.end_time,
                cs.duration_seconds, cs.context
         FROM call_sessions cs
         LEFT JOIN agents a ON a.id = cs.agent_id AND a.tenant_id = cs.tenant_id
         WHERE cs.id = $1 AND cs.tenant_id = $2`,
        [callId, DEMO_TENANT_ID],
      );

      if (sessionRows.length === 0) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'Call session not found' })}\n\n`);
        return;
      }

      const session = sessionRows[0];

      if (session.lifecycle_state !== lastState) {
        lastState = session.lifecycle_state;
        res.write(`event: call_state\ndata: ${JSON.stringify({
          callId: session.id,
          state: session.lifecycle_state,
          agentName: session.agent_name,
          startTime: session.start_time,
          endTime: session.end_time,
          durationSeconds: session.duration_seconds,
        })}\n\n`);
      }

      const transcript = session.context?.transcript as string | undefined;
      if (transcript && transcript.length > lastTranscriptLength) {
        const newContent = transcript.substring(lastTranscriptLength);
        lastTranscriptLength = transcript.length;

        const combined = trailingPartialLine + newContent;
        const parts = combined.split('\n');
        trailingPartialLine = combined.endsWith('\n') ? '' : (parts.pop() ?? '');

        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const callerMatch = trimmed.match(/^CALLER:\s*(.+)/i);
          const agentMatch = trimmed.match(/^AGENT:\s*(.+)/i);

          if (callerMatch) {
            res.write(`event: transcript\ndata: ${JSON.stringify({
              speaker: 'caller',
              text: callerMatch[1],
              timestamp: new Date().toISOString(),
            })}\n\n`);
          } else if (agentMatch) {
            res.write(`event: transcript\ndata: ${JSON.stringify({
              speaker: 'agent',
              text: agentMatch[1],
              timestamp: new Date().toISOString(),
            })}\n\n`);
          }
        }
      }

      const { rows: eventRows } = await pool.query<CallEventRow>(
        `SELECT id, event_type, payload, occurred_at, from_state, to_state
         FROM call_events
         WHERE call_session_id = $1 AND tenant_id = $2
         ORDER BY occurred_at ASC, id ASC
         LIMIT 200`,
        [callId, DEMO_TENANT_ID],
      );

      for (const event of eventRows) {
        if (seenEventIds.has(event.id)) continue;
        seenEventIds.add(event.id);

        const eventType = event.event_type.toLowerCase();

        if (eventType === 'tool_start') {
          res.write(`event: tool_start\ndata: ${JSON.stringify({
            invocationId: event.id,
            tool: (event.payload as Record<string, unknown>)?.tool ?? 'unknown',
            timestamp: event.occurred_at,
          })}\n\n`);
        } else if (eventType === 'tool_end') {
          const toolPayload = event.payload as Record<string, unknown> | null;
          res.write(`event: tool_end\ndata: ${JSON.stringify({
            invocationId: event.id,
            tool: toolPayload?.tool ?? 'unknown',
            pairedStartId: findPairedToolStart(eventRows, event, seenEventIds),
            timestamp: event.occurred_at,
          })}\n\n`);
        } else if (eventType === 'escalation_active') {
          res.write(`event: escalation\ndata: ${JSON.stringify({
            target: (event.payload as Record<string, unknown>)?.target,
            timestamp: event.occurred_at,
          })}\n\n`);
        }

        res.write(`event: activity\ndata: ${JSON.stringify({
          id: event.id,
          eventType: event.event_type,
          fromState: event.from_state,
          toState: event.to_state,
          payload: event.payload,
          timestamp: event.occurred_at,
        })}\n\n`);
      }
    } catch (err) {
      logger.error('Demo SSE poll failed', { callId, error: String(err) });
    }
  };

  await poll();

  const interval = setInterval(poll, 2000);

  const heartbeat = setInterval(() => {
    if (alive) res.write(':\n\n');
  }, 15000);

  req.on('close', () => {
    alive = false;
    clearInterval(interval);
    clearInterval(heartbeat);
  });
});

router.get('/demo/active-call', demoSSEPollLimiter, async (_req: Request, res: Response) => {
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query(
      `SELECT cs.id, cs.lifecycle_state, cs.caller_number, cs.agent_id,
              a.name AS agent_name, cs.start_time
       FROM call_sessions cs
       LEFT JOIN agents a ON a.id = cs.agent_id AND a.tenant_id = cs.tenant_id
       WHERE cs.tenant_id = $1
         AND cs.lifecycle_state NOT IN ('CALL_COMPLETED', 'CALL_FAILED', 'WORKFLOW_FAILED', 'ESCALATION_FAILED')
       ORDER BY cs.start_time DESC
       LIMIT 5`,
      [DEMO_TENANT_ID],
    );

    res.json({ activeCalls: rows.map((r) => ({
      callId: r.id as string,
      state: r.lifecycle_state as string,
      agentName: r.agent_name as string | null,
      startTime: r.start_time as string,
    })) });
  } catch (err) {
    logger.error('Failed to fetch active demo calls', { error: String(err) });
    res.status(500).json({ error: 'Failed to fetch active calls' });
  }
});

export default router;
