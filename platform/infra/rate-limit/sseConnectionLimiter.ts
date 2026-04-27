import type { Request, Response } from 'express';

/**
 * Resolve the per-tenant live-stream cap from an env var with sane fallbacks.
 * Centralized so all SSE routes share the same parsing rules and don't drift.
 *
 *   - missing or empty → fallback (default 20)
 *   - non-numeric, NaN, Infinity → fallback
 *   - < 1 → fallback
 *   - otherwise → floor(value)
 */
export function resolveLiveStreamCap(
  raw: string | undefined,
  fallback = 20,
): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

export interface SseConnectionLimiterConfig {
  maxConcurrent: number;
  message?: string;
}

export interface SseConnectionLimiter {
  acquire: (req: Request, res: Response) => boolean;
  count: (tenantId: string) => number;
  total: () => number;
  clear: () => void;
}

function getTenantId(req: Request): string {
  const fromUser = (req as Request & { user?: { tenantId?: string } }).user?.tenantId;
  if (fromUser) return fromUser;
  const fromReq = (req as Request & { tenantId?: string }).tenantId;
  return fromReq ?? 'platform';
}

export function createSseConnectionLimiter(config: SseConnectionLimiterConfig): SseConnectionLimiter {
  const max = Math.max(1, config.maxConcurrent);
  const message =
    config.message ?? 'Too many concurrent live-stream connections for this tenant.';
  const counts = new Map<string, number>();

  return {
    acquire(req: Request, res: Response): boolean {
      const tenantId = getTenantId(req);
      const current = counts.get(tenantId) ?? 0;
      if (current >= max) {
        res.setHeader('Retry-After', '5');
        res.status(429).json({
          error: message,
          maxConcurrent: max,
          current,
        });
        return false;
      }
      counts.set(tenantId, current + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const c = counts.get(tenantId) ?? 0;
        if (c <= 1) counts.delete(tenantId);
        else counts.set(tenantId, c - 1);
      };
      req.on('close', release);
      res.on('close', release);
      return true;
    },
    count(tenantId: string): number {
      return counts.get(tenantId) ?? 0;
    },
    total(): number {
      let n = 0;
      for (const v of counts.values()) n += v;
      return n;
    },
    clear(): void {
      counts.clear();
    },
  };
}

export interface SseHeartbeatConfig {
  intervalMs?: number;
  idleTimeoutMs?: number;
}

/**
 * Wire SSE keepalive on (req, res):
 *  - Emits `: heartbeat\n\n` every `intervalMs` (default 15s).
 *  - Treats the TCP `drain` event as the client-side acknowledgment of a
 *    heartbeat. If a heartbeat write returns false (kernel buffer full)
 *    AND `drain` does not fire within `idleTimeoutMs` (default 60s), the
 *    response is force-closed. This implements "auto-disconnect after
 *    60s of no heartbeat ack" — backpressure that never clears means the
 *    far end has stopped reading.
 *  - Also sets a socket-level inactivity timeout as belt-and-suspenders for
 *    half-open TCP (no FIN/RST, no bytes flowing).
 */
export function attachSseHeartbeat(
  req: Request,
  res: Response,
  config: SseHeartbeatConfig = {},
): () => void {
  const intervalMs = config.intervalMs ?? 15_000;
  const idleTimeoutMs = config.idleTimeoutMs ?? 60_000;

  let pendingDrainTimer: NodeJS.Timeout | null = null;

  const forceClose = () => {
    try {
      res.end();
    } catch {
      /* noop */
    }
    try {
      req.socket?.destroy();
    } catch {
      /* noop */
    }
  };

  const onDrain = () => {
    if (pendingDrainTimer) {
      clearTimeout(pendingDrainTimer);
      pendingDrainTimer = null;
    }
  };
  res.on('drain', onDrain);

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    let ok = false;
    try {
      ok = Boolean(res.write(': heartbeat\n\n'));
    } catch {
      forceClose();
      return;
    }
    if (!ok && !pendingDrainTimer && idleTimeoutMs > 0) {
      // Backpressure: client isn't draining. Wait up to idleTimeoutMs for
      // 'drain' before declaring the connection dead.
      pendingDrainTimer = setTimeout(() => {
        pendingDrainTimer = null;
        forceClose();
      }, idleTimeoutMs);
      if (typeof (pendingDrainTimer as { unref?: () => void }).unref === 'function') {
        (pendingDrainTimer as { unref: () => void }).unref();
      }
    }
  }, intervalMs);
  if (typeof (heartbeat as { unref?: () => void }).unref === 'function') {
    (heartbeat as { unref: () => void }).unref();
  }

  if (req.socket && idleTimeoutMs > 0) {
    req.socket.setTimeout(idleTimeoutMs);
    req.socket.once('timeout', forceClose);
  }

  let cleared = false;
  const cleanup = () => {
    if (cleared) return;
    cleared = true;
    clearInterval(heartbeat);
    if (pendingDrainTimer) {
      clearTimeout(pendingDrainTimer);
      pendingDrainTimer = null;
    }
    res.off('drain', onDrain);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  return cleanup;
}
