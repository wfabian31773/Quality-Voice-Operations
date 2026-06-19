/**
 * Operator diagnostics for the realtime voice-stream path.
 *
 *   POST /admin/diagnostics/realtime-stream          — run an on-demand probe
 *   GET  /admin/diagnostics/realtime-stream/metrics   — latency/failure snapshot
 *
 * Both are gated by the same `x-admin-token` (ADMIN_INTERNAL_TOKEN) used by
 * the rest of the gateway's admin surface. The probe drives the real WS path
 * so an operator can confirm — and diagnose — the realtime pipeline live,
 * without placing an actual phone call.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { createLogger } from '../../../platform/core/logger';
import { getRealtimeStreamMetrics } from '../../../platform/core/observability';
import { runRealtimeStreamDiagnostic, type StreamDiagnosticMode } from '../services/streamDiagnostic';

const router = Router();
const logger = createLogger('DIAGNOSTICS');

function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  const adminToken = process.env.ADMIN_INTERNAL_TOKEN;
  if (!adminToken) {
    logger.error('ADMIN_INTERNAL_TOKEN not configured — rejecting diagnostics request');
    res.status(503).json({ error: 'Diagnostics endpoint not available: missing server configuration' });
    return;
  }
  const provided = req.headers['x-admin-token'];
  if (provided !== adminToken) {
    logger.warn('Diagnostics request rejected: invalid token', { ip: req.ip });
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

router.post('/admin/diagnostics/realtime-stream', requireAdminToken, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    mode?: StreamDiagnosticMode;
    url?: string;
    firstAudioTimeoutMs?: number;
    handshakeGraceMs?: number;
    params?: Record<string, string>;
  };
  const mode: StreamDiagnosticMode = body.mode === 'full' ? 'full' : 'handshake';
  try {
    const report = await runRealtimeStreamDiagnostic({
      mode,
      url: body.url,
      firstAudioTimeoutMs: body.firstAudioTimeoutMs,
      handshakeGraceMs: body.handshakeGraceMs,
      params: body.params,
    });
    // 200 when the path is healthy, 503 when the probe failed — so external
    // uptime checks can treat this endpoint as a realtime-path health gate.
    return res.status(report.ok ? 200 : 503).json(report);
  } catch (err) {
    logger.error('Realtime stream diagnostic threw unexpectedly', { error: String(err) });
    return res.status(500).json({ error: 'Diagnostic failed to run', detail: String(err) });
  }
});

router.get('/admin/diagnostics/realtime-stream/metrics', requireAdminToken, (_req: Request, res: Response) => {
  try {
    return res.json(getRealtimeStreamMetrics());
  } catch (err) {
    logger.error('Failed to read realtime stream metrics', { error: String(err) });
    return res.status(500).json({ error: 'Failed to read metrics' });
  }
});

export default router;
