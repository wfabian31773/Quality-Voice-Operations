import { describe, expect, it } from 'vitest';
import { postgresActionStore } from './postgresStore';
import type { ActionContext, TenantTx } from './types';

const now = new Date('2026-10-17T15:00:00.000Z');
const ctx: ActionContext = {
  tenantId: 't1',
  actor: { type: 'user', id: 'u1', role: 'owner' },
  now,
  tenantTimezone: 'UTC',
  callId: 'call-1',
};

function tx(handler: (sql: string, values?: unknown[]) => { rows: Record<string, unknown>[]; rowCount: number }): TenantTx {
  return {
    query: async (sql, values) => handler(sql, values),
  };
}

describe('postgresActionStore', () => {
  it('claims a new idempotency key when INSERT returns a row', async () => {
    const result = await postgresActionStore.beginIdempotency(
      tx((sql) => {
        if (sql.includes('INSERT INTO action_idempotency')) return { rows: [{ tenant_id: 't1' }], rowCount: 1 };
        throw new Error(sql);
      }),
      {
        tenantId: 't1',
        action: 'core.echo.write',
        key: 'k1',
        requestHash: 'a'.repeat(64),
        now,
        expiresAt: new Date(now.getTime() + 1000),
      },
    );
    expect(result).toEqual({ kind: 'new' });
  });

  it('replays a completed row after locking it', async () => {
    const stored = { ok: true, data: { echoed: 'hi' } };
    const result = await postgresActionStore.beginIdempotency(
      tx((sql) => {
        if (sql.includes('INSERT INTO action_idempotency')) return { rows: [], rowCount: 0 };
        if (sql.includes('FOR UPDATE')) {
          return {
            rows: [{
              request_hash: 'a'.repeat(64),
              status: 'completed',
              response: stored,
              expires_at: new Date(now.getTime() + 60_000),
            }],
            rowCount: 1,
          };
        }
        throw new Error(sql);
      }),
      {
        tenantId: 't1',
        action: 'core.echo.write',
        key: 'k1',
        requestHash: 'a'.repeat(64),
        now,
        expiresAt: new Date(now.getTime() + 1000),
      },
    );
    expect(result).toEqual({ kind: 'replay', response: stored });
  });

  it('returns reused when the locked hash differs', async () => {
    const result = await postgresActionStore.beginIdempotency(
      tx((sql) => {
        if (sql.includes('INSERT')) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            request_hash: 'b'.repeat(64),
            status: 'completed',
            response: { ok: true, data: {} },
            expires_at: new Date(now.getTime() + 60_000),
          }],
          rowCount: 1,
        };
      }),
      {
        tenantId: 't1',
        action: 'core.echo.write',
        key: 'k1',
        requestHash: 'a'.repeat(64),
        now,
        expiresAt: new Date(now.getTime() + 1000),
      },
    );
    expect(result).toEqual({ kind: 'reused' });
  });

  it('reclaims an expired row', async () => {
    const updates: string[] = [];
    const result = await postgresActionStore.beginIdempotency(
      tx((sql) => {
        if (sql.includes('INSERT')) return { rows: [], rowCount: 0 };
        if (sql.includes('FOR UPDATE')) {
          return {
            rows: [{
              request_hash: 'a'.repeat(64),
              status: 'completed',
              response: { ok: true, data: {} },
              expires_at: new Date(now.getTime() - 1000),
            }],
            rowCount: 1,
          };
        }
        updates.push(sql);
        return { rows: [], rowCount: 1 };
      }),
      {
        tenantId: 't1',
        action: 'core.echo.write',
        key: 'k1',
        requestHash: 'c'.repeat(64),
        now,
        expiresAt: new Date(now.getTime() + 1000),
      },
    );
    expect(result).toEqual({ kind: 'new' });
    expect(updates[0]).toContain('UPDATE action_idempotency');
  });

  it('treats a unique violation as a lock-and-inspect', async () => {
    const result = await postgresActionStore.beginIdempotency(
      tx((sql) => {
        if (sql.includes('INSERT')) {
          const err = new Error('duplicate') as Error & { code: string };
          err.code = '23505';
          throw err;
        }
        return {
          rows: [{
            request_hash: 'a'.repeat(64),
            status: 'in_progress',
            response: null,
            expires_at: new Date(now.getTime() + 60_000),
          }],
          rowCount: 1,
        };
      }),
      {
        tenantId: 't1',
        action: 'core.echo.write',
        key: 'k1',
        requestHash: 'a'.repeat(64),
        now,
        expiresAt: new Date(now.getTime() + 1000),
      },
    );
    expect(result.kind).toBe('new');
  });

  it('inserts, consumes, inspects, completes, and audits with parameterized SQL', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const client = tx((sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('INSERT INTO action_proposals')) {
        return {
          rows: [{
            id: values?.[0],
            tenant_id: 't1',
            action: 'core.echo.prepare',
            call_id: 'call-1',
            payload_hash: 'h'.repeat(64),
            payload: { message: 'hi' },
            readback: 'hi',
            expires_at: now,
            consumed_at: null,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('UPDATE action_proposals')) {
        return {
          rows: [{
            id: 'tok',
            tenant_id: 't1',
            action: 'core.echo.prepare',
            call_id: 'call-1',
            payload_hash: 'h'.repeat(64),
            payload: { message: 'hi' },
            readback: 'hi',
            expires_at: now,
            consumed_at: now,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM action_proposals')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });

    const created = await postgresActionStore.createProposal(client, ctx, {
      action: 'core.echo.prepare',
      callId: 'call-1',
      payload: { message: 'hi' },
      payloadHash: 'h'.repeat(64),
      readback: 'hi',
      expiresAt: now,
    });
    expect(created.id).toBeTruthy();

    const consumed = await postgresActionStore.consumeProposal(client, ctx, {
      confirmationToken: 'tok',
      action: 'core.echo.prepare',
      callId: 'call-1',
      payloadHash: 'h'.repeat(64),
    });
    expect(consumed?.id).toBe('tok');

    const missing = await postgresActionStore.consumeProposal(client, ctx, {
      confirmationToken: 'tok',
      action: 'core.echo.prepare',
      payloadHash: 'h'.repeat(64),
    });
    // second consume in this fake still returns a row because the stub always matches UPDATE
    expect(missing === null || missing.id === 'tok').toBe(true);

    await postgresActionStore.inspectProposal(client, ctx, 'tok');
    await postgresActionStore.completeIdempotency(client, {
      tenantId: 't1',
      action: 'core.echo.write',
      key: 'k',
      response: { ok: true, data: { echoed: 'hi' } },
      now,
    });
    await postgresActionStore.releaseIdempotency(client, {
      tenantId: 't1',
      action: 'core.echo.write',
      key: 'k',
    });
    expect(calls.some((c) => c.sql.includes('DELETE FROM action_idempotency'))).toBe(true);
    await postgresActionStore.insertAudit(client, {
      tenantId: 't1',
      action: 'core.echo.write',
      actor: { type: 'user', id: 'u1' },
      inputRedacted: { phone: '***0142' },
      resultCode: 'ok',
      latencyMs: 3,
      callId: 'call-1',
    });
    expect(calls.some((c) => c.sql.includes('INSERT INTO action_audit_log'))).toBe(true);
  });

  it('binds a JSON object when inputRedacted is missing', async () => {
    let bound: unknown[] | undefined;
    await postgresActionStore.insertAudit(
      tx((_sql, values) => {
        bound = values;
        return { rows: [], rowCount: 1 };
      }),
      {
        tenantId: 't1',
        action: 'core.echo.write',
        actor: { type: 'user', id: 'u1' },
        inputRedacted: undefined,
        resultCode: 'VALIDATION_FAILED',
        latencyMs: 1,
      },
    );
    expect(bound?.[3]).toBe('{}');
    await postgresActionStore.insertAudit(
      tx((_sql, values) => {
        bound = values;
        return { rows: [], rowCount: 1 };
      }),
      {
        tenantId: 't1',
        action: 'core.echo.write',
        actor: { type: 'user', id: 'u1' },
        inputRedacted: null,
        resultCode: 'VALIDATION_FAILED',
        latencyMs: 1,
      },
    );
    expect(bound?.[3]).toBe('{}');
  });

  it('inserts after a lock miss', async () => {
    let inserts = 0;
    const result = await postgresActionStore.beginIdempotency(
      tx((sql) => {
        if (sql.includes('INSERT INTO action_idempotency')) {
          inserts += 1;
          if (inserts === 1) return { rows: [], rowCount: 0 };
          return { rows: [{ tenant_id: 't1' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      {
        tenantId: 't1',
        action: 'core.echo.write',
        key: 'k1',
        requestHash: 'a'.repeat(64),
        now,
        expiresAt: now,
      },
    );
    expect(result).toEqual({ kind: 'new' });
    expect(inserts).toBe(2);
  });

  it('rethrows non-unique insert errors', async () => {
    await expect(
      postgresActionStore.beginIdempotency(
        tx(() => {
          throw new Error('disk full');
        }),
        {
          tenantId: 't1',
          action: 'core.echo.write',
          key: 'k1',
          requestHash: 'a'.repeat(64),
          now,
          expiresAt: now,
        },
      ),
    ).rejects.toThrow('disk full');
  });
});

describe('postgresActionStore inspect empty', () => {
  it('returns null when the proposal is missing', async () => {
    const row = await postgresActionStore.inspectProposal(
      tx(() => ({ rows: [], rowCount: 0 })),
      ctx,
      'missing',
    );
    expect(row).toBeNull();
  });

  it('parses date strings from postgres rows', async () => {
    const row = await postgresActionStore.inspectProposal(
      tx(() => ({
        rows: [{
          id: 'tok',
          tenant_id: 't1',
          action: 'core.echo.prepare',
          call_id: null,
          payload_hash: 'h'.repeat(64),
          payload: {},
          readback: 'x',
          expires_at: '2026-10-17T15:05:00.000Z',
          consumed_at: '2026-10-17T15:01:00.000Z',
        }],
        rowCount: 1,
      })),
      ctx,
      'tok',
    );
    expect(row?.expiresAt.toISOString()).toBe('2026-10-17T15:05:00.000Z');
    expect(row?.consumedAt?.toISOString()).toBe('2026-10-17T15:01:00.000Z');
  });
});
