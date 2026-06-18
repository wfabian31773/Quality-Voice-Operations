import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const a = vi.hoisted(() => ({ logErrorMock: vi.fn() }));

vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../../platform/core/observability', () => ({ logError: a.logErrorMock }));

import { errorHandler } from './errorHandler';

function ctx(user?: Record<string, unknown>) {
  const req = { method: 'POST', path: '/x', user } as unknown as Request;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  const next = vi.fn();
  return { req, res: res as unknown as Response & { statusCode: number; body: unknown }, next: next as unknown as NextFunction };
}

beforeEach(() => a.logErrorMock.mockReset());

describe('errorHandler', () => {
  it('responds 500 and records the error for an Error instance', () => {
    const { req, res, next } = ctx({ tenantId: 't1' });
    errorHandler(new Error('boom'), req, res, next);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(a.logErrorMock).toHaveBeenCalledWith('t1', 'error', 'boom', expect.objectContaining({ service: 'admin-api' }));
  });
  it('handles a non-Error value and a missing tenant', () => {
    const { req, res, next } = ctx(undefined);
    errorHandler('plain string failure', req, res, next);
    expect(res.statusCode).toBe(500);
    expect(a.logErrorMock).toHaveBeenCalledWith(null, 'error', 'plain string failure', expect.any(Object));
  });
});
