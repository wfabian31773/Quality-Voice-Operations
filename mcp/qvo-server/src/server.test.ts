import { afterEach, describe, expect, it } from 'vitest';
import { connectInMemory, parseResult, PRINCIPALS, TENANT_A, TENANT_B, type Harness } from './testing';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function call(name: string, args: Record<string, unknown> = {}) {
  if (!harness) throw new Error('no harness');
  return parseResult(await harness.client.callTool({ name, arguments: args }));
}

describe('tool listing', () => {
  it('lists only qvo:read tools for a read key', async () => {
    harness = await connectInMemory(PRINCIPALS.readerA);
    const { tools } = await harness.client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'core_echo_read',
      'qvo_get_tenant',
      'qvo_list_actions',
      'qvo_list_templates',
      'test_notes_list',
    ]);
  });

  it('adds qvo:admin write tools for an admin key and never exposes actions without mcpScope', async () => {
    harness = await connectInMemory(PRINCIPALS.adminA);
    const names = (await harness.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('core_echo_write');
    expect(names).toContain('core_echo_commit');
    expect(names).not.toContain('test_hidden_write');
  });

  it('hides tenant-bound tools from a platform-admin key', async () => {
    harness = await connectInMemory(PRINCIPALS.platformAdmin);
    const names = (await harness.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['qvo_list_actions', 'qvo_list_templates']);
  });
});

describe('qvo.* helpers', () => {
  it('qvo.get_tenant returns name, timezone and enabled tools of the bound tenant', async () => {
    harness = await connectInMemory(PRINCIPALS.readerA);
    const { isError, body } = await call('qvo_get_tenant');
    expect(isError).toBe(false);
    expect(body).toEqual({
      ok: true,
      data: { name: TENANT_A.name, timezone: TENANT_A.timezone, enabledTools: TENANT_A.enabledTools },
    });
  });

  it('qvo.list_templates is an empty stub', async () => {
    harness = await connectInMemory(PRINCIPALS.readerA);
    expect((await call('qvo_list_templates')).body).toEqual({ ok: true, data: [] });
  });

  it('qvo.list_actions lists what this key can call', async () => {
    harness = await connectInMemory(PRINCIPALS.readerA);
    const { body } = await call('qvo_list_actions');
    expect(body.data).toEqual([
      { action: 'core.echo.read', tool: 'core_echo_read', kind: 'read', scope: 'qvo:read', description: expect.any(String) },
      { action: 'test.notes.list', tool: 'test_notes_list', kind: 'read', scope: 'qvo:read', description: expect.any(String) },
    ]);
  });
});

describe('scope enforcement', () => {
  it('refuses a write tool for a key without qvo:admin', async () => {
    harness = await connectInMemory(PRINCIPALS.readerA);
    const { isError, body } = await call('core_echo_write', { message: 'hi', dryRun: false, idempotencyKey: 'k1' });
    expect(isError).toBe(true);
    expect((body.error as { code: string }).code).toBe('FORBIDDEN');
    expect(harness.sideEffect.count).toBe(0);
  });

  it('refuses a tenant-bound tool for a platform-admin key', async () => {
    harness = await connectInMemory(PRINCIPALS.platformAdmin);
    const { isError, body } = await call('qvo_get_tenant');
    expect(isError).toBe(true);
    expect((body.error as { code: string }).code).toBe('FORBIDDEN');
  });

  it('returns NOT_FOUND for an unknown tool', async () => {
    harness = await connectInMemory(PRINCIPALS.adminA);
    const { body } = await call('test_hidden_write', { value: 'x' });
    expect((body.error as { code: string }).code).toBe('NOT_FOUND');
  });
});

describe('tenant isolation', () => {
  it('a call bound to tenant A cannot read tenant B through qvo.get_tenant', async () => {
    harness = await connectInMemory(PRINCIPALS.readerA);
    const { isError, body } = await call('qvo_get_tenant', { tenantId: TENANT_B.id });
    expect(isError).toBe(true);
    expect((body.error as { code: string }).code).toBe('FORBIDDEN');
    expect(JSON.stringify(body)).not.toContain(TENANT_B.name);
  });

  it('a call bound to tenant A cannot steer an action to tenant B', async () => {
    harness = await connectInMemory(PRINCIPALS.readerA);
    const refused = await call('test_notes_list', { tenantId: TENANT_B.id });
    expect((refused.body.error as { code: string }).code).toBe('FORBIDDEN');

    const own = await call('test_notes_list');
    expect(own.body).toEqual({ ok: true, data: { tenantId: TENANT_A.id, notes: ['A: Luis prefers Marco'] } });
  });
});

describe('writes default to dryRun', () => {
  it('a write without dryRun validates, audits and does not run', async () => {
    harness = await connectInMemory(PRINCIPALS.adminA);
    const { isError, body } = await call('core_echo_write', { message: 'hi' });
    expect(isError).toBe(false);
    expect(body.data).toEqual({ dryRun: true, action: 'core.echo.write', kind: 'write', input: { message: 'hi' } });
    expect(harness.sideEffect.count).toBe(0);
    expect(harness.store.idempotency.size).toBe(0);
  });

  it('anything but an explicit false is a dry run', async () => {
    harness = await connectInMemory(PRINCIPALS.adminA);
    for (const dryRun of [true, 'false', 0, null]) {
      const { body } = await call('core_echo_write', { message: 'hi', dryRun, idempotencyKey: 'k' });
      expect((body.data as { dryRun: boolean }).dryRun).toBe(true);
    }
    expect(harness.sideEffect.count).toBe(0);
  });

  it('prepare and commit are writes too', async () => {
    harness = await connectInMemory(PRINCIPALS.adminA);
    const prepared = await call('core_echo_prepare', { message: 'hi' });
    expect((prepared.body.data as { dryRun: boolean }).dryRun).toBe(true);
    expect(harness.store.proposals.size).toBe(0);
  });

  it('dry run still validates input', async () => {
    harness = await connectInMemory(PRINCIPALS.adminA);
    const { body } = await call('core_echo_write', { message: '' });
    expect((body.error as { code: string; field: string }).code).toBe('VALIDATION_FAILED');
  });

  it('dryRun: false runs the write once, needs an idempotency key, and replays on retry', async () => {
    harness = await connectInMemory(PRINCIPALS.adminA);
    const missingKey = await call('core_echo_write', { message: 'hi', dryRun: false });
    expect((missingKey.body.error as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(harness.sideEffect.count).toBe(0);

    const first = await call('core_echo_write', { message: 'hi', dryRun: false, idempotencyKey: 'k1' });
    const retry = await call('core_echo_write', { message: 'hi', dryRun: false, idempotencyKey: 'k1' });
    expect(first.body).toEqual({ ok: true, data: { echoed: 'hi' } });
    expect(retry.body).toEqual(first.body);
    expect(harness.sideEffect.count).toBe(1);
  });
});

describe('audit', () => {
  it('audits every call through the PR-01 audit log with actor type mcp', async () => {
    harness = await connectInMemory(PRINCIPALS.adminA);
    await call('qvo_get_tenant');
    await call('core_echo_read', { message: 'call 555-123-4567' });
    await call('core_echo_write', { message: 'hi' });
    await call('core_echo_write', { message: 'hi', dryRun: false, idempotencyKey: 'k1' });
    await call('qvo_get_tenant', { tenantId: TENANT_B.id });
    await call('nope');

    const audits = harness.store.audits;
    expect(audits.map((a) => [a.action, a.resultCode])).toEqual([
      ['qvo.get_tenant', 'ok'],
      ['core.echo.read', 'ok'],
      ['core.echo.write', 'dry_run'],
      ['core.echo.write', 'ok'],
      ['qvo.get_tenant', 'FORBIDDEN'],
      ['nope', 'NOT_FOUND'],
    ]);
    for (const a of audits) {
      expect(a.tenantId).toBe(TENANT_A.id);
      expect(a.actor).toEqual({ type: 'mcp', id: PRINCIPALS.adminA.keyId });
    }
    expect(JSON.stringify(audits[1].inputRedacted)).not.toContain('555-123-4567');
  });
});
