/**
 * Coverage for `/me/preferences` GET/PATCH endpoints that back the
 * "resume the onboarding wizard where users left off" feature (BL-042).
 *
 * The wizard reads `onboarding_step` and `onboarding_completed` from the
 * users.preferences JSONB blob and writes back as the user advances. These
 * tests mount the users router with a mocked platform pool so we can pin
 * down four important behaviours:
 *
 *   1. GET returns the persisted preferences (or `{}` when none).
 *   2. PATCH shallow-merges new keys into the existing JSONB blob,
 *      preserving unrelated keys.
 *   3. PATCH rejects non-object payloads and oversized payloads.
 *   4. PATCH returns 404 when the user row no longer exists.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn(),
  ),
  withPrivilegedClient: vi.fn(),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(async () => {}),
  extractIp: () => '127.0.0.1',
}));

vi.mock('../../platform/email/EmailService', () => ({
  sendEmail: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../platform/email/templates', () => ({
  invitationEmail: () => ({ subject: '', html: '', text: '' }),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'owner',
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  simpleToDatabaseRole: (r: string) => r,
  dbRoleToSimple: (r: string) => r,
}));

import usersRouter from '../../server/admin-api/routes/users';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(usersRouter);
  return app;
}

interface Stub {
  match: (sql: string) => boolean;
  rows: Record<string, unknown>[];
  rowCount?: number;
}

function installQueryStubs(stubs: Stub[]): void {
  queryMock.mockImplementation(async (sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    if (/SET LOCAL/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    for (const s of stubs) {
      if (s.match(sql)) {
        return { rows: s.rows, rowCount: s.rowCount ?? s.rows.length };
      }
    }
    return { rows: [], rowCount: 0 };
  });
}

describe('GET /me/preferences', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
  });

  it('returns the saved onboarding step so the wizard can resume', async () => {
    installQueryStubs([
      {
        match: (sql) => /SELECT preferences FROM users/i.test(sql),
        rows: [{ preferences: { onboarding_step: 2, theme: 'dark' } }],
      },
    ]);

    const res = await request(buildApp()).get('/me/preferences');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      preferences: { onboarding_step: 2, theme: 'dark' },
    });
    expect(releaseMock).toHaveBeenCalled();
  });

  it('returns an empty object when the user has no preferences yet', async () => {
    installQueryStubs([
      {
        match: (sql) => /SELECT preferences FROM users/i.test(sql),
        rows: [{ preferences: null }],
      },
    ]);

    const res = await request(buildApp()).get('/me/preferences');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ preferences: {} });
  });
});

describe('PATCH /me/preferences', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
  });

  it('shallow-merges onboarding_step into the existing JSONB blob', async () => {
    let observedSql = '';
    let observedValues: unknown[] | undefined;
    queryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/UPDATE users\s+SET preferences/i.test(sql)) {
        observedSql = sql;
        observedValues = values;
        return {
          rows: [
            {
              preferences: {
                theme: 'dark',
                onboarding_step: 2,
              },
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp())
      .patch('/me/preferences')
      .send({ onboarding_step: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      preferences: { theme: 'dark', onboarding_step: 2 },
    });
    // The handler MUST use a JSONB concat (`||`) so existing keys are
    // preserved. Anything else (a wholesale assignment) would silently
    // erase unrelated preferences when the wizard updates a single key.
    expect(observedSql).toMatch(/COALESCE\(preferences, '\{\}'::jsonb\)\s*\|\|\s*\$1::jsonb/i);
    expect(observedValues?.[0]).toBe(JSON.stringify({ onboarding_step: 2 }));
    expect(observedValues?.[1]).toBe('user-1');
  });

  it('records onboarding_completed alongside the final step', async () => {
    let observedValues: unknown[] | undefined;
    queryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/UPDATE users\s+SET preferences/i.test(sql)) {
        observedValues = values;
        return {
          rows: [
            {
              preferences: { onboarding_step: 3, onboarding_completed: true },
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp())
      .patch('/me/preferences')
      .send({ onboarding_step: 3, onboarding_completed: true });

    expect(res.status).toBe(200);
    expect(res.body.preferences.onboarding_completed).toBe(true);
    expect(observedValues?.[0]).toBe(
      JSON.stringify({ onboarding_step: 3, onboarding_completed: true }),
    );
  });

  it('rejects non-object payloads', async () => {
    installQueryStubs([]);
    const res = await request(buildApp())
      .patch('/me/preferences')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(['not-an-object']));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JSON object/i);
    // No DB work should happen when the payload is invalid.
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('rejects payloads larger than the 8KB cap', async () => {
    installQueryStubs([]);
    const huge = 'x'.repeat(9 * 1024);
    const res = await request(buildApp())
      .patch('/me/preferences')
      .send({ blob: huge });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the user row is missing', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/UPDATE users\s+SET preferences/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp())
      .patch('/me/preferences')
      .send({ onboarding_step: 2 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
