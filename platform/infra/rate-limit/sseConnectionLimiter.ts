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

export type SseHeartbeatHandle = (() => void) & {
  /**
   * Reset the idle-disconnect deadline. Callers (e.g. a companion ack
   * endpoint) invoke this whenever they have evidence the client is alive
   * (e.g. an explicit ack POST, a re-subscribe, etc.).
   */
  ack: () => void;
};

/**
 * Wire SSE keepalive on (req, res) with a deterministic idle-disconnect
 * deadline that does NOT depend on TCP backpressure transitions.
 *
 *  - Emits `: heartbeat\n\n` every `intervalMs` (default 15s).
 *  - Maintains a sliding `lastLivenessAt` timestamp. The connection is
 *    force-closed if `now - lastLivenessAt > idleTimeoutMs` (default 60s).
 *    A periodic checker runs at `min(intervalMs, idleTimeoutMs / 4)` so
 *    closure happens within at most one check window past the deadline.
 *  - `lastLivenessAt` is reset on any of the following client-liveness
 *    signals:
 *      • `res` `'drain'` event — client read backpressured bytes.
 *      • `req` `'data'` event — client sent any HTTP/1.1 chunked body data.
 *      • explicit `ack()` call from a companion ack endpoint.
 *    Heartbeat *writes* themselves do NOT reset liveness — successful
 *    `res.write()` only proves the kernel accepted the bytes, not that the
 *    far end read them.
 *  - Also sets a TCP-socket inactivity timeout as belt-and-suspenders for
 *    half-open TCP (no FIN/RST, no bytes flowing).
 *
 * The returned value is the cleanup function with an `.ack` property
 * attached so existing call sites (`const cleanup = attach...; cleanup();`)
 * keep working while new sites can call `cleanup.ack()`.
 */
export function attachSseHeartbeat(
  req: Request,
  res: Response,
  config: SseHeartbeatConfig = {},
): SseHeartbeatHandle {
  const intervalMs = config.intervalMs ?? 15_000;
  const idleTimeoutMs = config.idleTimeoutMs ?? 60_000;

  let lastLivenessAt = Date.now();
  let cleared = false;

  const noteLiveness = () => {
    lastLivenessAt = Date.now();
  };

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

  // Liveness signals from the transport.
  res.on('drain', noteLiveness);
  req.on('data', noteLiveness);

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(': heartbeat\n\n');
    } catch {
      forceClose();
    }
  }, intervalMs);
  if (typeof (heartbeat as { unref?: () => void }).unref === 'function') {
    (heartbeat as { unref: () => void }).unref();
  }

  // Deterministic idle-disconnect checker. Runs at a cadence that guarantees
  // at most one check window of overshoot past idleTimeoutMs.
  const checkEveryMs =
    idleTimeoutMs > 0
      ? Math.max(250, Math.min(intervalMs, Math.floor(idleTimeoutMs / 4)))
      : 0;
  const checker =
    checkEveryMs > 0
      ? setInterval(() => {
          if (cleared) return;
          if (res.writableEnded || res.destroyed) return;
          if (Date.now() - lastLivenessAt > idleTimeoutMs) {
            forceClose();
          }
        }, checkEveryMs)
      : null;
  if (checker && typeof (checker as { unref?: () => void }).unref === 'function') {
    (checker as { unref: () => void }).unref();
  }

  if (req.socket && idleTimeoutMs > 0) {
    req.socket.setTimeout(idleTimeoutMs);
    req.socket.once('timeout', forceClose);
  }

  const cleanup = (() => {
    if (cleared) return;
    cleared = true;
    clearInterval(heartbeat);
    if (checker) clearInterval(checker);
    res.off('drain', noteLiveness);
    req.off('data', noteLiveness);
  }) as SseHeartbeatHandle;
  cleanup.ack = noteLiveness;

  req.on('close', cleanup);
  res.on('close', cleanup);
  return cleanup;
}
