import type { Request, Response } from 'express';

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

export function attachSseHeartbeat(
  req: Request,
  res: Response,
  config: SseHeartbeatConfig = {},
): () => void {
  const intervalMs = config.intervalMs ?? 15_000;
  const idleTimeoutMs = config.idleTimeoutMs ?? 60_000;

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, intervalMs);
  if (typeof (heartbeat as { unref?: () => void }).unref === 'function') {
    (heartbeat as { unref: () => void }).unref();
  }

  if (req.socket && idleTimeoutMs > 0) {
    req.socket.setTimeout(idleTimeoutMs);
    const onTimeout = () => {
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
    req.socket.once('timeout', onTimeout);
  }

  let cleared = false;
  const cleanup = () => {
    if (cleared) return;
    cleared = true;
    clearInterval(heartbeat);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  return cleanup;
}
