import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { actionOk, defineAction, OPENAI_TOOL_NAME } from '../../../platform/actions/core';
import { listActions } from '../../../platform/actions';
import { buildToolCatalog, isVisibleTo } from './tools';
import { fixtureRegistry } from './testing';

describe('generated MCP tool schemas', () => {
  it('match the snapshot (fixture registry + qvo.* helpers)', () => {
    const catalog = buildToolCatalog(fixtureRegistry({ count: 0 }));
    expect(catalog.entries.map((entry) => ({ source: entry.source, action: entry.name, scope: entry.scope, ...entry.schema }))).toMatchSnapshot();
  });

  // Invariants, not a snapshot: other lanes add `mcpScope` to app actions and
  // can't update snapshots in this package.
  it('build from the app registry with valid, unique, OpenAI-safe names', () => {
    const catalog = buildToolCatalog(listActions());
    const names = catalog.entries.map((entry) => entry.schema.name);
    expect(names).toEqual(expect.arrayContaining(['qvo_get_tenant', 'qvo_list_actions', 'qvo_list_templates']));
    expect(new Set(names).size).toBe(names.length);
    for (const entry of catalog.entries) {
      expect(entry.schema.name).toMatch(OPENAI_TOOL_NAME);
      expect(entry.schema.inputSchema.type).toBe('object');
      if (entry.source === 'action') expect(entry.def.permissions.mcpScope).toBe(entry.scope);
    }
    const exposed = listActions().filter((def) => def.permissions.mcpScope).map((def) => def.name);
    expect(catalog.entries.filter((e) => e.source === 'action').map((e) => e.name).sort()).toEqual(exposed.sort());
  });

  it('adds dryRun (default true) and idempotencyKey to write kinds only', () => {
    const catalog = buildToolCatalog(fixtureRegistry({ count: 0 }));
    for (const entry of catalog.entries) {
      const props = (entry.schema.inputSchema.properties ?? {}) as Record<string, { default?: unknown }>;
      const isWrite = entry.source === 'action' && entry.kind !== 'read';
      expect('dryRun' in props).toBe(isWrite);
      if (isWrite) expect(props.dryRun.default).toBe(true);
    }
  });

  it('maps names through PR-01 assignExternalToolNames and back', () => {
    const catalog = buildToolCatalog(fixtureRegistry({ count: 0 }));
    expect(catalog.names.toAction.get('qvo_get_tenant')).toBe('qvo.get_tenant');
    expect(catalog.byExternal.get('core_echo_write')?.name).toBe('core.echo.write');
  });

  it('refuses actions that squat on qvo.* or reserved argument names', () => {
    const squat = defineAction({
      name: 'qvo.provision_business',
      tool: 'business',
      kind: 'write',
      input: z.object({}),
      output: z.object({}),
      permissions: { mcpScope: 'qvo:admin' },
      run: async () => actionOk({}),
    });
    expect(() => buildToolCatalog([squat])).toThrow(/reserved/);

    const reserved = defineAction({
      name: 'business.thing',
      tool: 'business',
      kind: 'write',
      input: z.object({ dryRun: z.boolean() }),
      output: z.object({}),
      permissions: { mcpScope: 'qvo:admin' },
      run: async () => actionOk({}),
    });
    expect(() => buildToolCatalog([reserved])).toThrow(/reserves/);

    const badScope = defineAction({
      name: 'business.other',
      tool: 'business',
      kind: 'read',
      input: z.object({}),
      output: z.object({}),
      permissions: { mcpScope: 'qvo:everything' },
      run: async () => actionOk({}),
    });
    expect(() => buildToolCatalog([badScope])).toThrow(/unknown mcpScope/);

    const smsScoped = defineAction({
      name: 'sms.other_send',
      tool: 'sms',
      kind: 'write',
      input: z.object({}),
      output: z.object({}),
      permissions: { mcpScope: 'sms:send' },
      run: async () => actionOk({}),
    });
    expect(() => buildToolCatalog([smsScoped])).toThrow(/unknown mcpScope "sms:send"/);
  });

  it('exposes the app sms.send to qvo:admin keys only, as a dry-run-by-default write', () => {
    const catalog = buildToolCatalog(listActions());
    const entry = catalog.entries.find((e) => e.name === 'sms.send');
    expect(entry).toMatchObject({ source: 'action', external: 'sms_send', scope: 'qvo:admin', kind: 'write' });
    expect(isVisibleTo(entry!, ['qvo:read'], 'tenant-a')).toBe(false);
    expect(isVisibleTo(entry!, ['qvo:read', 'qvo:admin'], 'tenant-a')).toBe(true);
    const props = entry!.schema.inputSchema.properties as Record<string, { default?: unknown }>;
    expect(props.dryRun.default).toBe(true);
    expect(props).toHaveProperty('idempotencyKey');
  });

  it('requires qvo:admin for write, prepare and commit actions', () => {
    for (const kind of ['write', 'prepare', 'commit'] as const) {
      const readScoped = defineAction({
        name: `business.${kind}_thing`,
        tool: 'business',
        kind,
        input: z.object({}),
        output: z.object({}),
        permissions: { mcpScope: 'qvo:read' },
        run: async () => actionOk({}),
      });
      expect(() => buildToolCatalog([readScoped])).toThrow(/must use mcpScope "qvo:admin"/);
    }

    const read = defineAction({
      name: 'business.read_thing',
      tool: 'business',
      kind: 'read',
      input: z.object({}),
      output: z.object({}),
      permissions: { mcpScope: 'qvo:read' },
      run: async () => actionOk({}),
    });
    const catalog = buildToolCatalog([read]);
    expect(catalog.entries.find((entry) => entry.name === 'business.read_thing')?.scope).toBe('qvo:read');
  });
});
