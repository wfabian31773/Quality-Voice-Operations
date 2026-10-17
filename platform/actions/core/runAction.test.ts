import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createEchoCommitAction,
  createEchoPrepareAction,
  createEchoReadAction,
  createEchoWriteAction,
} from './__fixtures__/echo';
import { defineAction } from './defineAction';
import { actionFail, actionOk } from './errors';
import { createMemoryStore } from './memoryStore';
import { consumeProposal, createProposal } from './proposals';
import { runAction, runActionDefinition } from './runAction';
import type { ActionContext, ActionResult, Actor, AnyActionDefinition } from './types';

const NOW = new Date('2026-10-17T15:00:00.000Z');

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    tenantId: 'tenant-a',
    actor: { type: 'user', id: 'user-1', role: 'owner' },
    now: NOW,
    tenantTimezone: 'America/New_York',
    callId: 'call-1',
    ...overrides,
  };
}

function runtime(actions: AnyActionDefinition[]) {
  const store = createMemoryStore();
  return {
    store,
    deps: {
      store,
      registry: actions,
      withTenantTx: store.withTenantTx.bind(store),
    },
  };
}

function expectFail(result: ActionResult, code: string, field?: string) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  expect(result.error.callerSafeMessage.length).toBeGreaterThan(0);
  expect(result.error.callerSafeMessage).not.toMatch(/at \//);
  if (field) expect(result.error.field).toBe(field);
}

describe('runAction', () => {
  it('maps zod failures to VALIDATION_FAILED with field', async () => {
    const { deps } = runtime([createEchoWriteAction({ count: 0 })]);
    const result = await runAction('core.echo.write', ctx({ idempotencyKey: 'k1' }), { phone: '+15550142' }, deps);
    expectFail(result, 'VALIDATION_FAILED', 'message');
  });

  it('denies a user whose role is not listed', async () => {
    const { deps } = runtime([createEchoWriteAction({ count: 0 })]);
    const result = await runAction(
      'core.echo.write',
      ctx({ actor: { type: 'user', id: 'u', role: 'viewer' }, idempotencyKey: 'k1' }),
      { message: 'hi' },
      deps,
    );
    expectFail(result, 'FORBIDDEN');
  });

  it('denies an agent when the action is not agent-enabled', async () => {
    const def = defineAction({
      name: 'core.owner_only',
      tool: 'business',
      kind: 'read',
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
      permissions: { roles: ['owner'] },
      run: async (_c, input) => actionOk(input),
    });
    const { deps } = runtime([def]);
    const result = await runAction(
      'core.owner_only',
      ctx({ actor: { type: 'agent', id: 'agent-1' } }),
      { id: 'x' },
      deps,
    );
    expectFail(result, 'FORBIDDEN');
  });

  it('denies MCP callers missing the required scope', async () => {
    const { deps } = runtime([createEchoWriteAction({ count: 0 })]);
    const result = await runAction(
      'core.echo.write',
      ctx({
        actor: { type: 'mcp', id: 'bot', scopes: ['qvo:read'] },
        idempotencyKey: 'k1',
      }),
      { message: 'hi' },
      deps,
    );
    expectFail(result, 'FORBIDDEN');
  });

  it('allows system actors and MCP callers with the scope', async () => {
    const { deps } = runtime([createEchoWriteAction({ count: 0 })]);
    const system = await runAction(
      'core.echo.write',
      ctx({ actor: { type: 'system', id: 'job' }, idempotencyKey: 'sys' }),
      { message: 'sys' },
      deps,
    );
    expect(system).toEqual({ ok: true, data: { echoed: 'sys' } });

    const mcp = await runAction(
      'core.echo.write',
      ctx({ actor: { type: 'mcp', id: 'bot', scopes: ['qvo:admin'] }, idempotencyKey: 'mcp' }),
      { message: 'mcp' },
      deps,
    );
    expect(mcp).toEqual({ ok: true, data: { echoed: 'mcp' } });
  });

  it('allows agents when the agent flag is set', async () => {
    const { deps } = runtime([createEchoReadAction()]);
    const result = await runAction(
      'core.echo.read',
      ctx({ actor: { type: 'agent', id: 'agent-1' } }),
      { message: 'hello' },
      deps,
    );
    expect(result).toEqual({ ok: true, data: { echoed: 'hello' } });
  });

  it('does not require an idempotency key on reads', async () => {
    const { deps } = runtime([createEchoReadAction()]);
    const result = await runAction('core.echo.read', ctx(), { message: 'hello' }, deps);
    expect(result.ok).toBe(true);
  });

  it('requires an idempotency key on writes', async () => {
    const { deps } = runtime([createEchoWriteAction({ count: 0 })]);
    const result = await runAction('core.echo.write', ctx(), { message: 'hello' }, deps);
    expectFail(result, 'VALIDATION_FAILED', 'idempotencyKey');
  });

  it('replays an identical write with no second side effect', async () => {
    const side = { count: 0 };
    const { deps } = runtime([createEchoWriteAction(side)]);
    const input = { message: 'booked', phone: '+15555550142' };
    const first = await runAction('core.echo.write', ctx({ idempotencyKey: 'same' }), input, deps);
    const second = await runAction('core.echo.write', ctx({ idempotencyKey: 'same' }), input, deps);
    expect(first).toEqual({ ok: true, data: { echoed: 'booked' } });
    expect(second).toEqual(first);
    expect(side.count).toBe(1);
  });

  it('rejects a reused key with a different payload', async () => {
    const side = { count: 0 };
    const { deps } = runtime([createEchoWriteAction(side)]);
    await runAction('core.echo.write', ctx({ idempotencyKey: 'same' }), { message: 'one' }, deps);
    const result = await runAction('core.echo.write', ctx({ idempotencyKey: 'same' }), { message: 'two' }, deps);
    expectFail(result, 'IDEMPOTENCY_KEY_REUSED');
    expect(side.count).toBe(1);
  });

  it('rejects a reused key when only a Date field changed', async () => {
    const def = defineAction({
      name: 'core.when.write',
      tool: 'business',
      kind: 'write',
      input: z.object({ when: z.date() }),
      output: z.object({ when: z.date() }),
      permissions: { roles: ['owner'] },
      run: async (_c, input) => actionOk(input),
    });
    const { deps } = runtime([def]);
    const first = await runAction(
      'core.when.write',
      ctx({ idempotencyKey: 'when-1' }),
      { when: new Date('2026-10-17T09:00:00.000Z') },
      deps,
    );
    expect(first.ok).toBe(true);
    const reused = await runAction(
      'core.when.write',
      ctx({ idempotencyKey: 'when-1' }),
      { when: new Date('2026-10-17T21:00:00.000Z') },
      deps,
    );
    expectFail(reused, 'IDEMPOTENCY_KEY_REUSED');
  });

  it('treats an expired idempotency row as a new request', async () => {
    const side = { count: 0 };
    const { deps } = runtime([createEchoWriteAction(side)]);
    await runAction('core.echo.write', ctx({ idempotencyKey: 'ttl' }), { message: 'old' }, deps);
    const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    const result = await runAction(
      'core.echo.write',
      ctx({ idempotencyKey: 'ttl', now: later }),
      { message: 'new' },
      deps,
    );
    expect(result).toEqual({ ok: true, data: { echoed: 'new' } });
    expect(side.count).toBe(2);
  });

  it('uses the confirmation token as the commit idempotency key', async () => {
    const side = { count: 0 };
    const actions = [createEchoPrepareAction(), createEchoCommitAction(side)];
    const { deps } = runtime(actions);
    const prepared = await runAction(
      'core.echo.prepare',
      ctx({ idempotencyKey: 'prep-1' }),
      { message: 'hello' },
      deps,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const data = prepared.data as { confirmationToken: string; payloadHash: string };
    const token = data.confirmationToken;
    const hash = data.payloadHash;
    const first = await runAction('core.echo.commit', ctx(), { confirmationToken: token, payloadHash: hash }, deps);
    const second = await runAction('core.echo.commit', ctx(), { confirmationToken: token, payloadHash: hash }, deps);
    expect(first).toEqual({ ok: true, data: { echoed: 'hello' } });
    expect(second).toEqual(first);
    expect(side.count).toBe(1);
  });

  it('returns NOT_FOUND for an unknown action and still audits', async () => {
    const { store, deps } = runtime([]);
    const result = await runAction('nope.missing', ctx(), {}, deps);
    expectFail(result, 'NOT_FOUND');
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]?.resultCode).toBe('NOT_FOUND');
  });

  it('rolls back a throw after a write and does not persist an INTERNAL replay', async () => {
    const side = { count: 0 };
    const def = defineAction({
      name: 'core.write_then_throw',
      tool: 'business',
      kind: 'write',
      input: z.object({ message: z.string() }),
      output: z.object({ echoed: z.string() }),
      permissions: { roles: ['owner'] },
      run: async () => {
        side.count += 1;
        throw new Error('constraint after write');
      },
    });
    const { store, deps } = runtime([def]);
    const first = await runAction(
      'core.write_then_throw',
      ctx({ idempotencyKey: 'throw-1' }),
      { message: 'x' },
      deps,
    );
    expectFail(first, 'INTERNAL');
    const records = [...store.idempotency.values()];
    expect(records.every((row) => row.status !== 'completed')).toBe(true);
    const second = await runAction(
      'core.write_then_throw',
      ctx({ idempotencyKey: 'throw-1' }),
      { message: 'x' },
      deps,
    );
    expectFail(second, 'INTERNAL');
    expect(side.count).toBe(2);
  });

  it('maps thrown errors to INTERNAL without leaking a stack', async () => {
    const def = defineAction({
      name: 'core.boom',
      tool: 'business',
      kind: 'read',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      permissions: { roles: ['owner'] },
      run: async () => {
        throw new Error('secret disk path /var/lib/qvo');
      },
    });
    const { deps } = runtime([def]);
    const result = await runAction('core.boom', ctx(), {}, deps);
    expectFail(result, 'INTERNAL');
    if (result.ok) return;
    expect(result.error.callerSafeMessage).not.toContain('/var/lib');
  });

  it('maps output schema mismatches to INTERNAL', async () => {
    const def = defineAction({
      name: 'core.bad_output',
      tool: 'business',
      kind: 'read',
      input: z.object({}),
      output: z.object({ echoed: z.string() }),
      permissions: { roles: ['owner'] },
      run: async () => actionOk({ echoed: 12 as unknown as string }),
    });
    const { deps } = runtime([def]);
    const result = await runAction('core.bad_output', ctx(), {}, deps);
    expectFail(result, 'INTERNAL');
  });

  it('rolls back a write when output validation fails and does not complete idempotency', async () => {
    let staging = 0;
    const def = defineAction({
      name: 'core.bad_write_output',
      tool: 'business',
      kind: 'write',
      input: z.object({ message: z.string() }),
      output: z.object({ echoed: z.string() }),
      permissions: { roles: ['owner'] },
      run: async () => {
        staging += 1;
        return actionOk({ echoed: 12 as unknown as string });
      },
    });
    const store = createMemoryStore();
    const result = await runAction(
      'core.bad_write_output',
      ctx({ idempotencyKey: 'bad-out' }),
      { message: 'x' },
      {
        store,
        registry: [def],
        withTenantTx: async (_tenantId, fn) => {
          const snapshot = staging;
          try {
            const value = await fn({ query: async () => ({ rows: [], rowCount: 0 }) });
            return value;
          } catch (err) {
            staging = snapshot;
            throw err;
          }
        },
      },
    );
    expectFail(result, 'INTERNAL');
    expect(staging).toBe(0);
    expect([...store.idempotency.values()].every((row) => row.status !== 'completed')).toBe(true);
  });

  it('does not finalize idempotency for retryable failures so a retry re-runs', async () => {
    const side = { count: 0 };
    const def = defineAction({
      name: 'core.rate_limited',
      tool: 'business',
      kind: 'write',
      input: z.object({ message: z.string() }),
      output: z.object({ echoed: z.string() }),
      permissions: { roles: ['owner'] },
      run: async (_c, input) => {
        side.count += 1;
        if (side.count === 1) return actionFail('RATE_LIMITED', 'slow down');
        return actionOk({ echoed: input.message });
      },
    });
    const { store, deps } = runtime([def]);
    const first = await runAction(
      'core.rate_limited',
      ctx({ idempotencyKey: 'retry-1' }),
      { message: 'hi' },
      deps,
    );
    expectFail(first, 'RATE_LIMITED');
    expect([...store.idempotency.values()]).toHaveLength(0);
    const second = await runAction(
      'core.rate_limited',
      ctx({ idempotencyKey: 'retry-1' }),
      { message: 'hi' },
      deps,
    );
    expect(second).toEqual({ ok: true, data: { echoed: 'hi' } });
    expect(side.count).toBe(2);
  });

  it('returns VALIDATION_FAILED even when the audit transaction cannot start', async () => {
    const result = await runAction(
      'core.echo.write',
      ctx({ idempotencyKey: 'no-begin' }),
      { phone: '+15550142' },
      {
        store: createMemoryStore(),
        registry: [createEchoWriteAction({ count: 0 })],
        withTenantTx: async () => {
          throw new Error('cannot BEGIN');
        },
      },
    );
    expectFail(result, 'VALIDATION_FAILED', 'message');
  });

  it('denies users when the allowed role list is empty', async () => {
    const def = defineAction({
      name: 'core.nobody',
      tool: 'business',
      kind: 'read',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      permissions: { roles: [] },
      run: async () => actionOk({ ok: true }),
    });
    const { deps } = runtime([def]);
    const result = await runAction('core.nobody', ctx(), {}, deps);
    expectFail(result, 'FORBIDDEN');
  });

  it('allows any authenticated user when roles are unrestricted', async () => {
    const def = defineAction({
      name: 'core.any_user',
      tool: 'business',
      kind: 'read',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      permissions: { agent: true },
      run: async () => actionOk({ ok: true }),
    });
    const { deps } = runtime([def]);
    const result = await runAction(
      'core.any_user',
      ctx({ actor: { type: 'user', id: 'u' } }),
      {},
      deps,
    );
    expect(result).toEqual({ ok: true, data: { ok: true } });
  });

  it('rejects an unknown actor type', async () => {
    const { deps } = runtime([createEchoReadAction()]);
    const result = await runAction(
      'core.echo.read',
      ctx({ actor: { type: 'ghost' as Actor['type'], id: 'x' } }),
      { message: 'hi' },
      deps,
    );
    expectFail(result, 'FORBIDDEN');
  });

  it('denies a user with no role when roles are required', async () => {
    const { deps } = runtime([createEchoReadAction()]);
    const result = await runAction(
      'core.echo.read',
      ctx({ actor: { type: 'user', id: 'u' } }),
      { message: 'hi' },
      deps,
    );
    expectFail(result, 'FORBIDDEN');
  });
});

describe('two-phase proposals', () => {
  it('is single-use and rejects expired, wrong-call, and changed-payload tokens', async () => {
    const store = createMemoryStore();
    const deps = { store, withTenantTx: store.withTenantTx.bind(store) };
    const prepare = createEchoPrepareAction();
    const commit = createEchoCommitAction({ count: 0 });

    const prepared = await runActionDefinition(
      prepare,
      ctx({ idempotencyKey: 'p1' }),
      { message: 'hold this', phone: '+15555550142' },
      deps,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const token = prepared.data.confirmationToken;
    const hash = prepared.data.payloadHash;

    const consumed = await store.withTenantTx('tenant-a', (tx) =>
      consumeProposal(
        tx,
        ctx(),
        {
          confirmationToken: token,
          action: 'core.echo.prepare',
          payloadHash: hash,
          callId: 'call-1',
        },
        store,
      ),
    );
    expect('ok' in consumed ? consumed : consumed.id).toBe(token);

    const reuse = await runActionDefinition(
      commit,
      ctx({ idempotencyKey: token }),
      { confirmationToken: token, payloadHash: hash },
      deps,
    );
    expectFail(reuse, 'CONFIRMATION_INVALID');

    const second = await runActionDefinition(
      prepare,
      ctx({ idempotencyKey: 'p2' }),
      { message: 'again' },
      deps,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const expired = await runActionDefinition(
      commit,
      ctx({ now: new Date(NOW.getTime() + 6 * 60 * 1000) }),
      { confirmationToken: second.data.confirmationToken, payloadHash: second.data.payloadHash },
      deps,
    );
    expectFail(expired, 'CONFIRMATION_INVALID');

    const third = await runActionDefinition(
      prepare,
      ctx({ idempotencyKey: 'p3' }),
      { message: 'call-bound' },
      deps,
    );
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    const wrongCall = await runActionDefinition(
      commit,
      ctx({ callId: 'other-call' }),
      { confirmationToken: third.data.confirmationToken, payloadHash: third.data.payloadHash },
      deps,
    );
    expectFail(wrongCall, 'CONFIRMATION_INVALID');

    const fourth = await runActionDefinition(
      prepare,
      ctx({ idempotencyKey: 'p4' }),
      { message: 'payload' },
      deps,
    );
    expect(fourth.ok).toBe(true);
    if (!fourth.ok) return;
    const changed = await runActionDefinition(
      commit,
      ctx(),
      { confirmationToken: fourth.data.confirmationToken, payloadHash: 'a'.repeat(64) },
      deps,
    );
    expectFail(changed, 'CONFIRMATION_INVALID');
  });

  it('createProposal returns a token, readback, and 5 minute expiry', async () => {
    const store = createMemoryStore();
    const created = await store.withTenantTx('tenant-a', (tx) =>
      createProposal(
        tx,
        ctx(),
        {
          action: 'core.echo.prepare',
          payload: { message: 'hi' },
          readback: 'I will echo hi',
        },
        store,
      ),
    );
    expect(created.confirmationToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(created.readback).toBe('I will echo hi');
    expect(created.expiresAt.getTime() - NOW.getTime()).toBe(5 * 60 * 1000);
  });
});

describe('audit', () => {
  it('returns VALIDATION_FAILED when the body is missing even if audit insert throws', async () => {
    const store = createMemoryStore();
    store.insertAudit = async () => {
      throw new Error('null value in column "input_redacted"');
    };
    const result = await runAction(
      'core.echo.write',
      ctx({ idempotencyKey: 'missing-body' }),
      undefined,
      {
        store,
        registry: [createEchoWriteAction({ count: 0 })],
        withTenantTx: store.withTenantTx.bind(store),
      },
    );
    expectFail(result, 'VALIDATION_FAILED');
  });

  it('keeps a successful write when audit insert would abort the transaction', async () => {
    const side = { count: 0 };
    const store = createMemoryStore();
    let aborted = false;
    const tx = {
      query: async (sql: string) => {
        if (sql.startsWith('SAVEPOINT')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('ROLLBACK TO')) {
          aborted = false;
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith('RELEASE')) return { rows: [], rowCount: 0 };
        if (aborted) throw new Error('current transaction is aborted');
        if (sql.includes('INSERT INTO action_audit_log')) {
          aborted = true;
          throw new Error('value too long for type character varying(128)');
        }
        return { rows: [], rowCount: 1 };
      },
    };
    store.insertAudit = async (client) => {
      await client.query('INSERT INTO action_audit_log');
    };
    const result = await runAction(
      'core.echo.write',
      ctx({ idempotencyKey: 'audit-tx', callId: 'c'.repeat(200) }),
      { message: 'kept' },
      {
        store,
        registry: [createEchoWriteAction(side)],
        withTenantTx: async (_tenantId, fn) => {
          const value = await fn(tx);
          if (aborted) throw new Error('COMMIT failed: transaction aborted');
          return value;
        },
      },
    );
    expect(result).toEqual({ ok: true, data: { echoed: 'kept' } });
    expect(side.count).toBe(1);
    expect(aborted).toBe(false);
  });

  it('truncates oversized callId before audit insert', async () => {
    const { store, deps } = runtime([createEchoWriteAction({ count: 0 })]);
    await runAction(
      'core.echo.write',
      ctx({ idempotencyKey: 'long-call', callId: 'c'.repeat(200) }),
      { message: 'hi' },
      deps,
    );
    expect(store.audits[0]?.callId).toHaveLength(128);
  });

  it('writes a redacted row per run including phones masked to last 4', async () => {
    const side = { count: 0 };
    const { store, deps } = runtime([createEchoWriteAction(side)]);
    await runAction(
      'core.echo.write',
      ctx({ idempotencyKey: 'audit-1' }),
      { message: 'hi', phone: '+15555550142' },
      deps,
    );
    expect(store.audits).toHaveLength(1);
    const row = store.audits[0];
    expect(row?.action).toBe('core.echo.write');
    expect(row?.resultCode).toBe('ok');
    expect(row?.callId).toBe('call-1');
    expect(row?.actor).toEqual({ type: 'user', id: 'user-1', role: 'owner' });
    expect(row?.inputRedacted).toEqual({ message: 'hi', phone: '***0142' });
    expect(row?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(row?.inputRedacted)).not.toContain('5555550142');
  });
});

describe('runtime edge cases', () => {
  it('maps a failed tenant transaction to INTERNAL and survives a failed audit write', async () => {
    const def = createEchoReadAction();
    let calls = 0;
    const result = await runActionDefinition(
      def,
      ctx(),
      { message: 'x' },
      {
        store: createMemoryStore(),
        withTenantTx: async () => {
          calls += 1;
          throw new Error('db down');
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL');
    expect(calls).toBeGreaterThan(1);
  });

  it('reclaims an in-progress memory idempotency row with the same hash', async () => {
    const store = createMemoryStore();
    const input = {
      tenantId: 'tenant-a',
      action: 'core.echo.write',
      key: 'k-in-progress',
      requestHash: 'a'.repeat(64),
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    };
    await store.withTenantTx('tenant-a', (tx) => store.beginIdempotency(tx, input));
    const second = await store.withTenantTx('tenant-a', (tx) => store.beginIdempotency(tx, input));
    expect(second).toEqual({ kind: 'new' });
    await store.withTenantTx('tenant-a', (tx) =>
      store.completeIdempotency(tx, {
        tenantId: input.tenantId,
        action: input.action,
        key: input.key,
        response: { ok: true, data: { echoed: 'x' } },
        now: NOW,
      }),
    );
    await store.withTenantTx('tenant-a', async (tx) => {
      expect(await store.inspectProposal(tx, ctx(), 'missing')).toBeNull();
      expect(await store.inspectProposal(tx, ctx({ tenantId: 'other' }), 'missing')).toBeNull();
      await store.completeIdempotency(tx, {
        tenantId: 'nope',
        action: 'none',
        key: 'none',
        response: { ok: true, data: {} },
        now: NOW,
      });
    });
  });

  it('inspects a consumed proposal when consume is called with only a payload', async () => {
    const store = createMemoryStore();
    const created = await store.withTenantTx('tenant-a', (tx) =>
      createProposal(
        tx,
        ctx(),
        { action: 'core.echo.prepare', payload: { message: 'hi' }, readback: 'hi' },
        store,
      ),
    );
    await store.withTenantTx('tenant-a', (tx) =>
      consumeProposal(
        tx,
        ctx(),
        { confirmationToken: created.confirmationToken, action: 'core.echo.prepare', payload: { message: 'hi' } },
        store,
      ),
    );
    const again = await store.withTenantTx('tenant-a', (tx) =>
      consumeProposal(
        tx,
        ctx(),
        { confirmationToken: created.confirmationToken, action: 'core.echo.prepare', payload: { message: 'hi' } },
        store,
      ),
    );
    expect(again).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_INVALID' } });
  });
});

