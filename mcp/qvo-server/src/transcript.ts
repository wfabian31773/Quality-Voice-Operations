import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createMemoryStore } from '../../../platform/actions/core';
import { createQvoMcpServer } from './server';
import { memoryTenantDirectory } from './tenants';
import { fixtureRegistry, PRINCIPALS, TENANT_A, TENANT_B } from './testing';

/**
 * Inspector-style session over the in-memory transport with fixture data
 * (no DB, no network). `transcript.test.ts` keeps `TRANSCRIPT.md` in sync;
 * `npm run transcript` prints the same Markdown.
 */
export async function renderTranscript(): Promise<string> {
  const lines: string[] = [];
  const log = (direction: '→' | '←', message: JSONRPCMessage) => {
    lines.push(`${direction} ${JSON.stringify(message, null, 2)}`);
  };

  const store = createMemoryStore();
  const server = await createQvoMcpServer({
    principal: PRINCIPALS.adminA,
    registry: fixtureRegistry({ count: 0 }),
    runtime: { store, withTenantTx: store.withTenantTx },
    tenants: memoryTenantDirectory([TENANT_A, TENANT_B]),
    now: () => new Date('2026-10-20T15:00:00.000Z'),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const clientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (message, options) => {
    log('→', message);
    return clientSend(message, options);
  };
  await server.connect(serverTransport);
  const serverSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    log('←', message);
    return serverSend(message, options);
  };
  const client = new Client({ name: 'qvo-transcript', version: '0.0.0' });
  await client.connect(clientTransport);
  // Drop the initialize handshake; it carries SDK version strings that drift.
  lines.length = 0;

  const step = async (title: string, fn: () => Promise<unknown>) => {
    lines.push('', `### ${title}`, '', '```text');
    await fn();
    lines.push('```');
  };

  await step('1. tools/list', () => client.listTools());
  await step('2. tools/call qvo_get_tenant', () => client.callTool({ name: 'qvo_get_tenant', arguments: {} }));
  await step('3. tools/call qvo_get_tenant for another tenant (refused)', () =>
    client.callTool({ name: 'qvo_get_tenant', arguments: { tenantId: TENANT_B.id } }),
  );
  await step('4. tools/call core_echo_write without dryRun (dry run by default)', () =>
    client.callTool({ name: 'core_echo_write', arguments: { message: 'hello' } }),
  );

  const audits = store.audits.map(({ tenantId, action, actor, resultCode }) => ({ tenantId, action, actor, resultCode }));
  lines.push('', '### Audit rows written (PR-01 `action_audit_log` store)', '', '```json', JSON.stringify(audits, null, 2), '```');

  await client.close();
  await server.close();

  const header = [
    '# QVO MCP server: inspector transcript',
    '',
    'Recorded over the in-memory MCP transport (real SDK `Client` ↔ QVO `Server`) with fixture data:',
    'no database, no network. `→` is client to server, `←` is server to client. The `initialize`',
    'handshake is omitted.',
    '',
    `Key: \`${PRINCIPALS.adminA.keyId}\` (scopes \`${PRINCIPALS.adminA.scopes.join('`, `')}\`), bound to tenant \`${TENANT_A.id}\`.`,
    'The registry is the PR-01 echo fixtures plus the `qvo.*` helpers, because no app action sets',
    '`permissions.mcpScope` yet.',
    '',
    'Regenerate with `npm run test -- mcp/qvo-server -u` (the file is a vitest file snapshot).',
  ];
  return `${[...header, ...lines].join('\n')}\n`;
}

if (process.argv[1] && /transcript\.[cm]?[jt]s$/.test(process.argv[1])) {
  void renderTranscript().then((text) => process.stdout.write(text));
}
