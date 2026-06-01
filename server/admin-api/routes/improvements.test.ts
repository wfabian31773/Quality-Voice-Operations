import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  getSuggestionsMock: vi.fn(),
  getSuggestionByIdMock: vi.fn(),
  acceptSuggestionMock: vi.fn(),
  dismissSuggestionMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/analytics', () => ({
  getSuggestions: a.getSuggestionsMock,
  getSuggestionById: a.getSuggestionByIdMock,
  acceptSuggestion: a.acceptSuggestionMock,
  dismissSuggestion: a.dismissSuggestionMock,
}));

import improvementsRouter from './improvements';

function app() {
  const app = express();
  app.use(express.json());
  app.use(improvementsRouter);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.getSuggestionsMock.mockReset().mockResolvedValue([]);
  a.getSuggestionByIdMock.mockReset();
  a.acceptSuggestionMock.mockReset();
  a.dismissSuggestionMock.mockReset();
});

describe('GET /improvements/suggestions', () => {
  it('returns suggestions and passes a validated status filter', async () => {
    a.getSuggestionsMock.mockResolvedValue([{ id: 's1' }]);
    const res = await request(app()).get('/improvements/suggestions?status=accepted&agentId=ag1&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toHaveLength(1);
    expect(a.getSuggestionsMock).toHaveBeenCalledWith('t1', 'ag1', 'accepted', 10);
  });

  it('drops an invalid status filter (passes undefined) and clamps the limit', async () => {
    await request(app()).get('/improvements/suggestions?status=bogus&limit=9999');
    expect(a.getSuggestionsMock).toHaveBeenCalledWith('t1', undefined, undefined, 100);
  });

  it('rejects a viewer via the real rbac gate', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).get('/improvements/suggestions')).status).toBe(403);
  });

  it('returns 500 on failure', async () => {
    a.getSuggestionsMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/improvements/suggestions')).status).toBe(500);
  });
});

describe('GET /improvements/suggestions/:id', () => {
  it('returns the suggestion when found', async () => {
    a.getSuggestionByIdMock.mockResolvedValue({ id: 's1' });
    expect((await request(app()).get('/improvements/suggestions/s1')).body.suggestion).toEqual({ id: 's1' });
  });

  it('returns 404 when missing', async () => {
    a.getSuggestionByIdMock.mockResolvedValue(null);
    expect((await request(app()).get('/improvements/suggestions/missing')).status).toBe(404);
  });
});

describe('POST accept / dismiss', () => {
  it('accepts a suggestion', async () => {
    a.acceptSuggestionMock.mockResolvedValue({ id: 's1', status: 'accepted' });
    const res = await request(app()).post('/improvements/suggestions/s1/accept');
    expect(res.status).toBe(200);
    expect(a.acceptSuggestionMock).toHaveBeenCalledWith('t1', 's1', 'u1');
  });

  it('returns 404 when accept finds nothing to process', async () => {
    a.acceptSuggestionMock.mockResolvedValue(null);
    expect((await request(app()).post('/improvements/suggestions/x/accept')).status).toBe(404);
  });

  it('dismisses a suggestion', async () => {
    a.dismissSuggestionMock.mockResolvedValue({ id: 's1', status: 'dismissed' });
    expect((await request(app()).post('/improvements/suggestions/s1/dismiss')).status).toBe(200);
  });

  it('returns 500 when dismiss fails', async () => {
    a.dismissSuggestionMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).post('/improvements/suggestions/s1/dismiss')).status).toBe(500);
  });
});
