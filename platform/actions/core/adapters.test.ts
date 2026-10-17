import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createEchoWriteAction } from './__fixtures__/echo';
import { HTTP_STATUS_BY_ERROR, httpStatusFor, toAgentToolSchema, toHttpHandler, toMcpTool } from './adapters';
import { defineAction } from './defineAction';
import { actionFail, actionOk } from './errors';
import { zodToJsonSchema } from './jsonSchema';
import { createMemoryStore } from './memoryStore';
import { ACTION_ERROR_CODES, type ActionErrorCode, type ActionResult } from './types';

describe('adapters', () => {
  const echo = createEchoWriteAction({ count: 0 });

  it('builds an agent tool schema with JSON schema and agentDescription', () => {
    expect(toAgentToolSchema(echo)).toEqual({
      name: 'core.echo.write',
      description: 'Echo a message as a write. Fixture used only in tests.',
      agentDescription: 'Echo a message as a write. Fixture used only in tests.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', minLength: 1 },
          phone: { type: 'string' },
        },
        required: ['message'],
        additionalProperties: false,
      },
    });
  });

  it('builds an MCP tool with a read-only hint for reads', () => {
    const read = defineAction({
      name: 'business.get_info',
      tool: 'business',
      kind: 'read',
      input: z.object({ topic: z.enum(['hours', 'address']) }),
      output: z.object({ text: z.string() }),
      permissions: { agent: true },
      agentDescription: 'Look up shop info.',
      run: async () => actionOk({ text: 'ok' }),
    });
    expect(toMcpTool(read)).toEqual({
      name: 'business.get_info',
      description: 'Look up shop info.',
      inputSchema: {
        type: 'object',
        properties: { topic: { type: 'string', enum: ['hours', 'address'] } },
        required: ['topic'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    });
    expect(toMcpTool(echo).annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  it('maps HTTP requests to action runs as a pure function', async () => {
    const store = createMemoryStore();
    const handler = toHttpHandler(echo, { store, withTenantTx: store.withTenantTx.bind(store) });
    const ok = await handler({
      body: { message: 'hi' },
      headers: { 'Idempotency-Key': 'http-1' },
      tenantId: 'tenant-a',
      actor: { type: 'user', id: 'u', role: 'owner' },
      tenantTimezone: 'America/Chicago',
      now: new Date('2026-10-17T12:00:00.000Z'),
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, data: { echoed: 'hi' } });

    const denied = await handler({
      body: { message: 'hi' },
      headers: { 'idempotency-key': 'http-2' },
      tenantId: 'tenant-a',
      actor: { type: 'user', id: 'u', role: 'viewer' },
      tenantTimezone: 'America/Chicago',
    });
    expect(denied.status).toBe(403);
    expect(denied.body.ok).toBe(false);

    const missingTenant = await handler({
      body: { message: 'hi' },
      tenantId: '',
      actor: { type: 'user', id: 'u', role: 'owner' },
      tenantTimezone: 'UTC',
    });
    expect(missingTenant.status).toBe(400);

    const arrayHeader = await handler({
      body: { message: 'arr' },
      headers: { 'Idempotency-Key': ['http-3'] },
      tenantId: 'tenant-a',
      actor: { type: 'user', id: 'u', role: 'owner' },
      tenantTimezone: 'UTC',
    });
    expect(arrayHeader.status).toBe(200);

    const noKeyHeader = await handler({
      body: { message: 'arr' },
      headers: { 'X-Other': '1' },
      tenantId: 'tenant-a',
      actor: { type: 'user', id: 'u', role: 'owner' },
      tenantTimezone: 'UTC',
    });
    expect(noKeyHeader.status).toBe(400);

    const boom = defineAction({
      name: 'core.http_boom',
      tool: 'business',
      kind: 'read',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      permissions: { roles: ['owner'] },
      run: async () => {
        throw new Error('secret disk path /var/lib/qvo');
      },
    });
    const boomHandler = toHttpHandler(boom, { store, withTenantTx: store.withTenantTx.bind(store) });
    const crashed = await boomHandler({
      body: {},
      tenantId: 'tenant-a',
      actor: { type: 'user', id: 'u', role: 'owner' },
      tenantTimezone: 'UTC',
    });
    expect(crashed.status).toBe(500);
    expect(crashed.body.ok).toBe(false);
    if (crashed.body.ok) return;
    expect(crashed.body.error.code).toBe('INTERNAL');
    expect(crashed.body.error.message).toBe(crashed.body.error.callerSafeMessage);
    expect(crashed.body.error.message).not.toContain('/var/lib');
    expect(JSON.stringify(crashed.body)).not.toContain('secret disk path');

    const nameless = defineAction({
      name: 'core.plain',
      tool: 'business',
      kind: 'read',
      input: z.object({}),
      output: z.object({}),
      permissions: {},
      run: async () => actionOk({}),
    });
    expect(toAgentToolSchema(nameless).agentDescription).toBe('core.plain');
    expect(toMcpTool(nameless).description).toBe('core.plain');
  });

  it('maps every error code to an HTTP status', () => {
    for (const code of ACTION_ERROR_CODES) {
      const result: ActionResult = actionFail(code, code);
      expect(httpStatusFor(result)).toBe(HTTP_STATUS_BY_ERROR[code as ActionErrorCode]);
    }
    expect(httpStatusFor({ ok: true, data: {} })).toBe(200);
    expect(actionOk({ id: '1' }, { effects: [{ type: 'booking.confirmed' }], readback: 'ok' })).toEqual({
      ok: true,
      data: { id: '1' },
      readback: 'ok',
      effects: [{ type: 'booking.confirmed' }],
    });
    expect(actionFail('CONFLICT', 'taken', { alternatives: [{ start: 'x' }] }).ok).toBe(false);
  });
});

describe('zodToJsonSchema', () => {
  it('covers optional, nullable, arrays, numbers, unions, and literals', () => {
    const schema = z.object({
      count: z.number().int().min(1).max(5),
      flag: z.boolean().optional(),
      note: z.string().nullable(),
      tags: z.array(z.string()),
      kind: z.union([z.literal('a'), z.literal('b')]),
      when: z.date().optional(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 5 },
        flag: { type: 'boolean' },
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        tags: { type: 'array', items: { type: 'string' } },
        kind: { anyOf: [{ type: 'string', const: 'a' }, { type: 'string', const: 'b' }] },
        when: { type: 'string', format: 'date-time' },
      },
      required: ['count', 'note', 'tags', 'kind'],
      additionalProperties: false,
    });
  });

  it('covers remaining zod wrappers used by future tools', () => {
    enum Kind {
      A = 'a',
      B = 'b',
    }
    const schema = z.object({
      email: z.string().email(),
      id: z.string().uuid().default('00000000-0000-4000-8000-000000000000'),
      url: z.string().url(),
      pattern: z.string().regex(/^x/),
      max: z.string().max(10),
      extra: z.record(z.number()),
      pair: z.tuple([z.string(), z.number()]),
      kind: z.nativeEnum(Kind),
      maybe: z.any(),
      unknown: z.unknown(),
      empty: z.void(),
      none: z.null(),
    });
    const json = zodToJsonSchema(schema);
    expect(json.type).toBe('object');
    const properties = json.properties as Record<string, Record<string, unknown>>;
    expect(properties.email).toEqual({ type: 'string', format: 'email' });
    expect(properties.id).toEqual({ type: 'string', format: 'uuid' });
    expect(properties.url).toEqual({ type: 'string', format: 'uri' });
    expect(properties.pair.type).toBe('array');
    expect(properties.kind.enum).toEqual(expect.arrayContaining(['a', 'b']));
    expect(properties.none).toEqual({ type: 'null' });
    const extras = z.object({
      n: z.literal(1),
      b: z.literal(true),
      pipe: z.string().pipe(z.string()),
      ro: z.object({ a: z.string() }).readonly(),
    });
    const extraJson = zodToJsonSchema(extras) as { properties: Record<string, Record<string, unknown>> };
    expect(extraJson.properties.n).toEqual({ type: 'number', const: 1 });
    expect(extraJson.properties.b).toEqual({ type: 'boolean', const: true });
  });
});
