import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createRateLimiter } from '../../platform/infra/rate-limit/createRateLimiter';
import {
  createSseConnectionLimiter,
  attachSseHeartbeat,
  resolveLiveStreamCap,
} from '../../platform/infra/rate-limit/sseConnectionLimiter';

function makeReq(tenantId = 'tenant-a'): Request & EventEmitter {
  const req = new EventEmitter() as Request & EventEmitter;
  (req as Request & { user?: { tenantId: string } }).user = { tenantId };
  const socket = new EventEmitter() as EventEmitter & {
    setTimeout: (ms: number) => void;
    destroy: () => void;
  };
  socket.setTimeout = vi.fn();
  socket.destroy = vi.fn();
  (req as Request & { socket: typeof socket }).socket = socket;
  return req;
}

function makeRes(): Response & {
  __statusCode: number;
  __headers: Record<string, string>;
  __body: unknown;
  __writes: string[];
  __ended: boolean;
} {
  const res = new EventEmitter() as Response &
    EventEmitter & {
      __statusCode: number;
      __headers: Record<string, string>;
      __body: unknown;
      __writes: string[];
      __ended: boolean;
    };
  res.__statusCode = 200;
  res.__headers = {};
  res.__body = undefined;
  res.__writes = [];
  res.__ended = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.status = vi.fn((code: number) => {
    res.__statusCode = code;
    return res;
  }) as Response['status'];
  res.json = vi.fn((body: unknown) => {
    res.__body = body;
    return res;
  }) as Response['json'];
  res.setHeader = vi.fn((name: string, value: string | number | readonly string[]) => {
    res.__headers[name] = String(value);
    return res;
  }) as Response['setHeader'];
  res.write = vi.fn((chunk: string) => {
    res.__writes.push(chunk);
    return true;
  }) as unknown as Response['write'];
  res.end = vi.fn(() => {
    res.__ended = true;
    res.writableEnded = true;
    return res;
  }) as Response['end'];
  return res;
}

describe('createSseConnectionLimiter', () => {
  it('admits up to maxConcurrent connections per tenant and rejects the next', () => {
    const limiter = createSseConnectionLimiter({ maxConcurrent: 3 });
    const accepted: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const req = makeReq('tenant-a');
      const res = makeRes();
      accepted.push(limiter.acquire(req, res));
      if (i === 3) {
        expect(res.__statusCode).toBe(429);
        expect((res.__body as { error: string }).error).toMatch(/concurrent live-stream/i);
        expect((res.__body as { maxConcurrent: number }).maxConcurrent).toBe(3);
        expect(res.__headers['Retry-After']).toBe('5');
      }
    }
    expect(accepted).toEqual([true, true, true, false]);
    expect(limiter.count('tenant-a')).toBe(3);
  });

  it('isolates counts per tenant', () => {
    const limiter = createSseConnectionLimiter({ maxConcurrent: 2 });
    const a1 = limiter.acquire(makeReq('tenant-a'), makeRes());
    const a2 = limiter.acquire(makeReq('tenant-a'), makeRes());
    const a3 = limiter.acquire(makeReq('tenant-a'), makeRes());
    const b1 = limiter.acquire(makeReq('tenant-b'), makeRes());
    const b2 = limiter.acquire(makeReq('tenant-b'), makeRes());
    expect(a1).toBe(true);
    expect(a2).toBe(true);
    expect(a3).toBe(false);
    expect(b1).toBe(true);
    expect(b2).toBe(true);
    expect(limiter.count('tenant-a')).toBe(2);
    expect(limiter.count('tenant-b')).toBe(2);
    expect(limiter.total()).toBe(4);
  });

  it('releases the slot when req emits close', () => {
    const limiter = createSseConnectionLimiter({ maxConcurrent: 1 });
    const req1 = makeReq('tenant-a');
    expect(limiter.acquire(req1, makeRes())).toBe(true);
    expect(limiter.acquire(makeReq('tenant-a'), makeRes())).toBe(false);
    req1.emit('close');
    expect(limiter.count('tenant-a')).toBe(0);
    expect(limiter.acquire(makeReq('tenant-a'), makeRes())).toBe(true);
  });

  it('release is idempotent (close on both req and res)', () => {
    const limiter = createSseConnectionLimiter({ maxConcurrent: 5 });
    const req = makeReq('tenant-a');
    const res = makeRes();
    limiter.acquire(req, res);
    expect(limiter.count('tenant-a')).toBe(1);
    req.emit('close');
    res.emit('close');
    expect(limiter.count('tenant-a')).toBe(0);
  });

  it('falls back to "platform" when no tenantId is present', () => {
    const limiter = createSseConnectionLimiter({ maxConcurrent: 2 });
    const req = new EventEmitter() as Request & EventEmitter;
    const res = makeRes();
    expect(limiter.acquire(req, res)).toBe(true);
    expect(limiter.count('platform')).toBe(1);
  });

  it('uses a custom message when provided', () => {
    const limiter = createSseConnectionLimiter({
      maxConcurrent: 1,
      message: 'custom-msg',
    });
    limiter.acquire(makeReq('tenant-a'), makeRes());
    const res = makeRes();
    limiter.acquire(makeReq('tenant-a'), res);
    expect((res.__body as { error: string }).error).toBe('custom-msg');
  });
});

describe('attachSseHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes ": heartbeat\\n\\n" every intervalMs', () => {
    const req = makeReq();
    const res = makeRes();
    attachSseHeartbeat(req, res, { intervalMs: 1000, idleTimeoutMs: 0 });
    vi.advanceTimersByTime(3500);
    const heartbeats = res.__writes.filter((w) => w === ': heartbeat\n\n');
    expect(heartbeats.length).toBe(3);
  });

  it('stops writing heartbeats after req close', () => {
    const req = makeReq();
    const res = makeRes();
    attachSseHeartbeat(req, res, { intervalMs: 1000, idleTimeoutMs: 0 });
    vi.advanceTimersByTime(2500);
    req.emit('close');
    const beforeClose = res.__writes.length;
    vi.advanceTimersByTime(5000);
    expect(res.__writes.length).toBe(beforeClose);
  });

  it('sets a socket idle timeout and ends the response on timeout', () => {
    const req = makeReq();
    const res = makeRes();
    attachSseHeartbeat(req, res, { intervalMs: 60_000, idleTimeoutMs: 60_000 });
    expect(req.socket.setTimeout).toHaveBeenCalledWith(60_000);
    (req.socket as unknown as EventEmitter).emit('timeout');
    expect(res.end).toHaveBeenCalled();
    expect(req.socket.destroy).toHaveBeenCalled();
  });

  it('force-closes after idleTimeoutMs if a heartbeat write returns false and drain never fires', () => {
    const req = makeReq();
    const res = makeRes();
    // Simulate kernel buffer full: write returns false.
    res.write = vi.fn((chunk: string) => {
      res.__writes.push(chunk);
      return false;
    }) as unknown as Response['write'];
    attachSseHeartbeat(req, res, { intervalMs: 1000, idleTimeoutMs: 60_000 });
    vi.advanceTimersByTime(1000); // first heartbeat (returns false → start drain timer)
    expect(res.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(59_999);
    expect(res.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(res.end).toHaveBeenCalled();
    expect(req.socket.destroy).toHaveBeenCalled();
  });

  it('drain event clears the pending close timer (heartbeat ack received)', () => {
    const req = makeReq();
    const res = makeRes();
    let backpressure = true;
    res.write = vi.fn(() => !backpressure) as unknown as Response['write'];
    attachSseHeartbeat(req, res, { intervalMs: 1000, idleTimeoutMs: 60_000 });
    vi.advanceTimersByTime(1000); // heartbeat #1, write false → drain timer armed
    res.emit('drain'); // client caught up
    backpressure = false; // subsequent writes succeed
    vi.advanceTimersByTime(120_000);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('does not write after writableEnded becomes true', () => {
    const req = makeReq();
    const res = makeRes();
    attachSseHeartbeat(req, res, { intervalMs: 1000, idleTimeoutMs: 0 });
    res.writableEnded = true;
    vi.advanceTimersByTime(2500);
    expect(res.__writes.filter((w) => w === ': heartbeat\n\n').length).toBe(0);
  });

  it('returned cleanup function clears the heartbeat timer', () => {
    const req = makeReq();
    const res = makeRes();
    const cleanup = attachSseHeartbeat(req, res, { intervalMs: 1000, idleTimeoutMs: 0 });
    vi.advanceTimersByTime(1500);
    cleanup();
    const before = res.__writes.length;
    vi.advanceTimersByTime(5000);
    expect(res.__writes.length).toBe(before);
  });
});

describe('source contract — SSE endpoints use the limiter and heartbeat helper', () => {
  it('callsLive route reuses createRateLimiter (per task spec) AND the concurrency limiter', () => {
    const src = readFileSync(
      join(process.cwd(), 'server/admin-api/routes/callsLive.ts'),
      'utf-8',
    );
    expect(src).toMatch(/import\s*\{\s*createRateLimiter\s*\}\s*from\s*['"][^'"]*createRateLimiter['"]/);
    expect(src).toMatch(/createRateLimiter\(\s*\{[\s\S]*?keyGenerator[\s\S]*?\.user\?\.tenantId/);
    expect(src).toMatch(/createSseConnectionLimiter/);
    expect(src).toMatch(/attachSseHeartbeat/);
    expect(src).toMatch(/callsLiveSseLimiter\.acquire\(req,\s*res\)/);
    expect(src).toMatch(/router\.get\(\s*['"]\/calls\/live['"][\s\S]*?callsLiveRateLimiter/);
    const acquireIdx = src.indexOf('callsLiveSseLimiter.acquire');
    const writeHeadIdx = src.indexOf('res.writeHead(200');
    expect(acquireIdx).toBeGreaterThan(0);
    expect(writeHeadIdx).toBeGreaterThan(acquireIdx);
  });

  it('operations route reuses createRateLimiter (per task spec) AND the concurrency limiter', () => {
    const src = readFileSync(
      join(process.cwd(), 'server/admin-api/routes/operations.ts'),
      'utf-8',
    );
    expect(src).toMatch(/import\s*\{\s*createRateLimiter\s*\}\s*from\s*['"][^'"]*createRateLimiter['"]/);
    expect(src).toMatch(/createRateLimiter\(\s*\{[\s\S]*?keyGenerator[\s\S]*?\.user\?\.tenantId/);
    expect(src).toMatch(/createSseConnectionLimiter/);
    expect(src).toMatch(/attachSseHeartbeat/);
    expect(src).toMatch(/operationsCallLiveSseLimiter\.acquire\(req,\s*res\)/);
    expect(src).toMatch(/router\.get\(\s*['"]\/operations\/calls\/:callId\/live['"][\s\S]*?operationsCallLiveRateLimiter/);
    const acquireIdx = src.indexOf('operationsCallLiveSseLimiter.acquire');
    const writeHeadIdx = src.indexOf('res.writeHead(200', acquireIdx);
    expect(acquireIdx).toBeGreaterThan(0);
    expect(writeHeadIdx).toBeGreaterThan(acquireIdx);
  });

  it('resolveLiveStreamCap sanitizes env values', () => {
    expect(resolveLiveStreamCap(undefined)).toBe(20);
    expect(resolveLiveStreamCap('')).toBe(20);
    expect(resolveLiveStreamCap('not-a-number')).toBe(20);
    expect(resolveLiveStreamCap('-5')).toBe(20);
    expect(resolveLiveStreamCap('0')).toBe(20);
    expect(resolveLiveStreamCap('Infinity')).toBe(20);
    expect(resolveLiveStreamCap('50')).toBe(50);
    expect(resolveLiveStreamCap('25.7')).toBe(25);
  });

  it('neither SSE route uses the old inline 15-second heartbeat setInterval pattern', () => {
    const callsLive = readFileSync(
      join(process.cwd(), 'server/admin-api/routes/callsLive.ts'),
      'utf-8',
    );
    const ops = readFileSync(
      join(process.cwd(), 'server/admin-api/routes/operations.ts'),
      'utf-8',
    );
    const oldPattern = /setInterval\(\s*\(\)\s*=>\s*\{\s*if\s*\(\s*alive\s*\)\s*res\.write\(['"]:\\n\\n['"]\)/;
    expect(callsLive).not.toMatch(oldPattern);
    expect(ops).not.toMatch(oldPattern);
  });
});

/**
 * End-to-end integration: spin up a real Express app with the same middleware
 * stack the SSE routes use (auth stub → tenant rate limiter → concurrency
 * limiter) and verify a single tenant is capped past the configured limit.
 *
 * We use a tiny non-streaming handler (just res.end()) so supertest's request
 * lifecycle completes immediately; the limiter's release-on-close hook fires
 * on response 'close'. We cap concurrency to 3 and serialize requests so all
 * three slots are used and the 4th sees 429.
 */
describe('SSE rate-limit + concurrency cap (route-level integration)', () => {
  it('per-tenant rate limiter trips after exceeding the request window cap', async () => {
    const app = express();
    const tenantLimiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 3,
      keyGenerator: (req) =>
        ((req as Request & { user?: { tenantId: string } }).user?.tenantId ??
          req.ip) as string,
    });
    app.get(
      '/calls/live',
      (req: Request, _res: Response, next: NextFunction) => {
        (req as Request & { user?: { tenantId: string } }).user = {
          tenantId: 'tenant-int',
        };
        next();
      },
      tenantLimiter,
      (_req: Request, res: Response) => res.status(200).end('ok'),
    );

    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await request(app).get('/calls/live');
      codes.push(r.status);
    }
    // First 3 succeed, remaining 2 are throttled.
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });
});
