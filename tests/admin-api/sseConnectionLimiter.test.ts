import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSseConnectionLimiter,
  attachSseHeartbeat,
} from '../../platform/infra/rate-limit/sseConnectionLimiter';
import type { Request, Response } from 'express';

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
  it('callsLive route imports limiter + heartbeat and calls acquire before writeHead', () => {
    const src = readFileSync(
      join(process.cwd(), 'server/admin-api/routes/callsLive.ts'),
      'utf-8',
    );
    expect(src).toMatch(/createSseConnectionLimiter/);
    expect(src).toMatch(/attachSseHeartbeat/);
    expect(src).toMatch(/callsLiveSseLimiter\.acquire\(req,\s*res\)/);
    const acquireIdx = src.indexOf('callsLiveSseLimiter.acquire');
    const writeHeadIdx = src.indexOf('res.writeHead(200');
    expect(acquireIdx).toBeGreaterThan(0);
    expect(writeHeadIdx).toBeGreaterThan(acquireIdx);
  });

  it('operations route imports limiter + heartbeat and calls acquire before writeHead', () => {
    const src = readFileSync(
      join(process.cwd(), 'server/admin-api/routes/operations.ts'),
      'utf-8',
    );
    expect(src).toMatch(/createSseConnectionLimiter/);
    expect(src).toMatch(/attachSseHeartbeat/);
    expect(src).toMatch(/operationsCallLiveSseLimiter\.acquire\(req,\s*res\)/);
    const acquireIdx = src.indexOf('operationsCallLiveSseLimiter.acquire');
    const writeHeadIdx = src.indexOf('res.writeHead(200', acquireIdx);
    expect(acquireIdx).toBeGreaterThan(0);
    expect(writeHeadIdx).toBeGreaterThan(acquireIdx);
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
