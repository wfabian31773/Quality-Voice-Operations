import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../platform/actions/core';
import { envKeyResolver, hashKey } from './auth';
import { createHttpHandler, MCP_PATH } from './http';
import { memoryTenantDirectory } from './tenants';
import { fixtureRegistry, TENANT_A, TENANT_B } from './testing';

// Loopback only (127.0.0.1, ephemeral port): exercises the real streamable-HTTP transport.
const KEY = 'qvo_http_test_key';
let server: Server;
let url: string;

beforeAll(async () => {
  const store = createMemoryStore();
  const handler = createHttpHandler({
    registry: fixtureRegistry({ count: 0 }),
    resolveKey: envKeyResolver(
      JSON.stringify([{ id: 'reader-a', sha256: hashKey(KEY), tenantId: TENANT_A.id, scopes: ['qvo:read'] }]),
    ),
    runtime: { store, withTenantTx: store.withTenantTx },
    tenants: memoryTenantDirectory([TENANT_A, TENANT_B]),
  });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${MCP_PATH}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function rpc(body: unknown, key?: string) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

describe('streamable HTTP transport', () => {
  it('refuses a request with no key (401)', async () => {
    const res = await rpc(LIST);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('refuses an unknown key (401)', async () => {
    expect((await rpc(LIST, 'wrong')).status).toBe(401);
  });

  it('lists tools and calls qvo.get_tenant with a valid key', async () => {
    const list = await rpc(LIST, KEY);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map((t) => t.name)).toContain('qvo_get_tenant');

    const call = await rpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'qvo_get_tenant', arguments: {} } },
      KEY,
    );
    const called = (await call.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(called.result.content[0].text)).toMatchObject({ ok: true, data: { name: TENANT_A.name } });
  });
});
