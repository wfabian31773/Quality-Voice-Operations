import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import {
  actionOk,
  createMemoryStore,
  defineAction,
  type AnyActionDefinition,
  type MemoryActionStore,
} from '../../../platform/actions/core';
import {
  createEchoCommitAction,
  createEchoPrepareAction,
  createEchoReadAction,
  createEchoWriteAction,
  type EchoSideEffect,
} from '../../../platform/actions/core/__fixtures__/echo';
import type { McpPrincipal } from './auth';
import { createQvoMcpServer } from './server';
import { memoryTenantDirectory, type TenantSummary } from './tenants';

/** In-memory fixtures shared by the tests and the transcript script. No DB, no network. */
export const TENANT_A: TenantSummary = {
  id: 'tenant-a',
  name: 'Marco’s Barbershop',
  timezone: 'America/Chicago',
  enabledTools: ['scheduling', 'sms', 'tickets'],
};

export const TENANT_B: TenantSummary = {
  id: 'tenant-b',
  name: 'Lily Nails',
  timezone: 'America/Los_Angeles',
  enabledTools: ['scheduling'],
};

export const NOTES_BY_TENANT: Record<string, string[]> = {
  [TENANT_A.id]: ['A: Luis prefers Marco'],
  [TENANT_B.id]: ['B: gel removal add-on'],
};

/** Reads data keyed by `ctx.tenantId`, standing in for an RLS-scoped table. */
export function createNotesReadAction(): AnyActionDefinition {
  return defineAction({
    name: 'test.notes.list',
    tool: 'tickets',
    kind: 'read',
    input: z.object({}),
    output: z.object({ tenantId: z.string(), notes: z.array(z.string()) }),
    permissions: { mcpScope: 'qvo:read' },
    agentDescription: 'List notes for the bound tenant. Fixture used only in tests.',
    async run(ctx) {
      return actionOk({ tenantId: ctx.tenantId, notes: NOTES_BY_TENANT[ctx.tenantId] ?? [] });
    },
  });
}

/** Not exposed over MCP: no `mcpScope`. */
export function createHiddenAction(): AnyActionDefinition {
  return defineAction({
    name: 'test.hidden.write',
    tool: 'business',
    kind: 'write',
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string() }),
    permissions: { roles: ['owner'], agent: true },
    async run(_ctx, input) {
      return actionOk(input);
    },
  });
}

export function fixtureRegistry(sideEffect: EchoSideEffect): AnyActionDefinition[] {
  return [
    createEchoReadAction(),
    createEchoWriteAction(sideEffect),
    createEchoPrepareAction(),
    createEchoCommitAction(sideEffect),
    createNotesReadAction(),
    createHiddenAction(),
  ];
}

export const PRINCIPALS = {
  readerA: { keyId: 'env:reader-a', tenantId: TENANT_A.id, scopes: ['qvo:read'] },
  adminA: { keyId: 'env:admin-a', tenantId: TENANT_A.id, scopes: ['qvo:read', 'qvo:admin'] },
  platformAdmin: { keyId: 'env:platform', tenantId: null, scopes: ['qvo:read', 'qvo:admin'] },
} satisfies Record<string, McpPrincipal>;

export interface Harness {
  client: Client;
  store: MemoryActionStore;
  sideEffect: EchoSideEffect;
  close: () => Promise<void>;
}

export async function connectInMemory(principal: McpPrincipal): Promise<Harness> {
  const store = createMemoryStore();
  const sideEffect: EchoSideEffect = { count: 0 };
  const server = await createQvoMcpServer({
    principal,
    registry: fixtureRegistry(sideEffect),
    runtime: { store, withTenantTx: store.withTenantTx },
    tenants: memoryTenantDirectory([TENANT_A, TENANT_B]),
    now: () => new Date('2026-10-20T15:00:00.000Z'),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'qvo-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    store,
    sideEffect,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Tool results are a single JSON text block holding the ActionResult. */
export function parseResult(result: unknown): { isError: boolean; body: Record<string, unknown> } {
  const r = result as { isError?: boolean; content: Array<{ type: string; text: string }> };
  return { isError: r.isError === true, body: JSON.parse(r.content[0].text) as Record<string, unknown> };
}
