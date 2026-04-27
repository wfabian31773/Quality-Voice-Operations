import type { Request, Response } from 'express';

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

// Single shared per-tenant SSE concurrency limiter. Both /calls/live and
// /operations/calls/:callId/live share this instance so the cap is tenant-
// wide across all live-stream surfaces, not per-route.
let sharedTenantSseLimiter: SseConnectionLimiter | null = null;

export function getTenantSseConnectionLimiter(): SseConnectionLimiter {
  if (!sharedTenantSseLimiter) {
    sharedTenantSseLimiter = createSseConnectionLimiter({
      maxConcurrent: resolveLiveStreamCap(process.env.TENANT_LIVE_STREAM_CAP),
    });
  }
  return sharedTenantSseLimiter;
}

export function __resetTenantSseConnectionLimiterForTesting(
  next: SseConnectionLimiter | null = null,
): void {
  sharedTenantSseLimiter = next;
}

// Registry of active SSE connections keyed by (tenantId, connectionId), used
// by the companion ack endpoint to refresh a stream's idle deadline.
const sseRegistry = new Map<string, () => void>();
const registryKey = (tenantId: string, connectionId: string) =>
  `${tenantId}:${connectionId}`;

export function registerSseConnection(
  tenantId: string,
  connectionId: string,
  ack: () => void,
): () => void {
  const key = registryKey(tenantId, connectionId);
  sseRegistry.set(key, ack);
  return () => {
    if (sseRegistry.get(key) === ack) sseRegistry.delete(key);
  };
}

export function ackSseConnection(tenantId: string, connectionId: string): boolean {
  const fn = sseRegistry.get(registryKey(tenantId, connectionId));
  if (!fn) return false;
  fn();
  return true;
}

export function clearSseRegistry(): void {
  sseRegistry.clear();
}

export interface SseHeartbeatConfig {
  intervalMs?: number;
  idleTimeoutMs?: number;
}

export type SseHeartbeatHandle = (() => void) & {
  /** Reset the idle-disconnect deadline. */
  ack: () => void;
};

/**
 * SSE keepalive with a deterministic idle-disconnect deadline.
 *
 * Emits `: heartbeat\n\n` every `intervalMs` (default 15s). Maintains a
 * sliding `lastLivenessAt` and force-closes when `now - lastLivenessAt`
 * exceeds `idleTimeoutMs` (default 60s). Successful server writes do NOT
 * count as liveness; only client-initiated signals do:
 *   - `res` 'drain' (client read backpressured bytes)
 *   - explicit `handle.ack()` (companion ack endpoint)
 *
 * Returns a cleanup function with an `.ack` property attached.
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
    res.end();
    req.socket?.destroy();
  };

  res.on('drain', noteLiveness);

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(': heartbeat\n\n');
  }, intervalMs);

  const checkEveryMs =
    idleTimeoutMs > 0
      ? Math.max(50, Math.min(intervalMs, Math.floor(idleTimeoutMs / 4)))
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

  const cleanup = (() => {
    if (cleared) return;
    cleared = true;
    clearInterval(heartbeat);
    if (checker) clearInterval(checker);
    res.off('drain', noteLiveness);
  }) as SseHeartbeatHandle;
  cleanup.ack = noteLiveness;

  req.on('close', cleanup);
  res.on('close', cleanup);
  return cleanup;
}
