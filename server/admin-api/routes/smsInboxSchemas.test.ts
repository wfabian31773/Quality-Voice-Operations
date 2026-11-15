import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  type Row = {
    tenantId: string;
    action: string;
    key: string;
    status: string;
    response: unknown;
    updatedAt: Date;
  };
  const rows = new Map<string, Row>();
  const idOf = (tenantId: string, action: string, key: string) => `${tenantId}\0${action}\0${key}`;
  const query = vi.fn();
  return { rows, idOf, query };
});

vi.mock('../../../platform/actions/core/runtime', () => ({
  defaultWithTenantTx: async (_tenantId: string, fn: (tx: { query: typeof h.query }) => Promise<unknown>) =>
    fn({ query: h.query }),
}));

import { releaseSmsInboxReplyIdempotency } from './smsInboxSchemas';

const TENANT = 't1';
const ACTION = 'sms.send';
const KEY = 'sms:inbox:t1:cv1:auth-retry';

const finalFailure = {
  ok: false as const,
  error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Twilio API error: 401 Authenticate', retryable: false },
};

const success = {
  ok: true as const,
  data: { messageId: 'msg-1' },
};

function seed(row: {
  status: string;
  response: unknown;
  updatedAt: Date;
}): void {
  h.rows.set(h.idOf(TENANT, ACTION, KEY), {
    tenantId: TENANT,
    action: ACTION,
    key: KEY,
    ...row,
  });
}

function stored(): { status: string; response: unknown; updatedAt: Date } | undefined {
  const row = h.rows.get(h.idOf(TENANT, ACTION, KEY));
  if (!row) return undefined;
  return { status: row.status, response: row.response, updatedAt: row.updatedAt };
}

function applyDelete(sql: string, values: unknown[]): { rowCount: number } {
  const tenantId = String(values[0]);
  const action = String(values[1]);
  const key = String(values[2]);
  const row = h.rows.get(h.idOf(tenantId, action, key));
  if (!row) return { rowCount: 0 };

  const sqlOneLine = sql.replace(/\s+/g, ' ');
  if (/status\s*=\s*'completed'/i.test(sqlOneLine) && row.status !== 'completed') {
    return { rowCount: 0 };
  }

  const response = row.response as { ok?: unknown; error?: { retryable?: unknown; code?: unknown } } | null;
  if (/response->>'ok'\s*=\s*'false'/i.test(sqlOneLine) && response?.ok !== false) {
    return { rowCount: 0 };
  }
  if (/retryable'\s*=\s*'false'/i.test(sqlOneLine) && response?.error?.retryable !== false) {
    return { rowCount: 0 };
  }
  if (/NOT IN/i.test(sqlOneLine) && /IDEMPOTENCY_KEY_REUSED/.test(sqlOneLine)) {
    const code = response?.error?.code;
    if (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'VALIDATION_FAILED' || code === 'FORBIDDEN') {
      return { rowCount: 0 };
    }
  }
  if (/updated_at\s*=/i.test(sqlOneLine) && values[3] != null) {
    const wanted = values[3];
    const wantedMs = wanted instanceof Date ? wanted.getTime() : Date.parse(String(wanted));
    if (row.updatedAt.getTime() !== wantedMs) return { rowCount: 0 };
  }

  h.rows.delete(h.idOf(tenantId, action, key));
  return { rowCount: 1 };
}

beforeEach(() => {
  h.rows.clear();
  h.query.mockReset();
  h.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (/DELETE FROM action_idempotency/i.test(sql)) {
      const result = applyDelete(sql, values);
      return { rows: [], ...result };
    }
    if (/SELECT/i.test(sql) && /action_idempotency/i.test(sql)) {
      const [tenantId, action, key] = values as string[];
      const row = h.rows.get(h.idOf(tenantId, action, key));
      if (!row) return { rows: [], rowCount: 0 };
      return {
        rows: [{ updated_at: row.updatedAt, status: row.status, response: row.response }],
        rowCount: 1,
      };
    }
    throw new Error(`unexpected SQL in inbox idempotency cleanup test: ${sql}`);
  });
});

describe('releaseSmsInboxReplyIdempotency', () => {
  it('deletes a cached final-rejection failure so a later attempt can run', async () => {
    seed({
      status: 'completed',
      response: finalFailure,
      updatedAt: new Date('2026-11-15T06:00:00.000Z'),
    });

    await releaseSmsInboxReplyIdempotency(TENANT, KEY);

    expect(stored()).toBeUndefined();
  });

  it('does not delete a success record written after the failure on a stale cleanup', async () => {
    seed({
      status: 'completed',
      response: finalFailure,
      updatedAt: new Date('2026-11-15T06:00:00.000Z'),
    });
    seed({
      status: 'completed',
      response: success,
      updatedAt: new Date('2026-11-15T06:00:01.000Z'),
    });

    await releaseSmsInboxReplyIdempotency(TENANT, KEY);

    expect(stored()).toEqual({
      status: 'completed',
      response: success,
      updatedAt: new Date('2026-11-15T06:00:01.000Z'),
    });
  });
});
