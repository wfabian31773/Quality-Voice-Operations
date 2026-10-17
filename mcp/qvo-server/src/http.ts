import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AnyActionDefinition } from '../../../platform/actions/core';
import { authenticate, bearerToken, defaultKeyResolver, McpAuthError, type KeyResolver } from './auth';
import { createQvoMcpServerFromCatalog, type QvoMcpServerOptions } from './server';
import { buildToolCatalog } from './tools';

export const MCP_PATH = '/mcp';

export interface HttpHandlerOptions extends Omit<QvoMcpServerOptions, 'principal' | 'registry'> {
  registry: AnyActionDefinition[];
  resolveKey?: KeyResolver;
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    ...(status === 401 ? { 'www-authenticate': 'Bearer realm="qvo-mcp"' } : {}),
  });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }));
}

/**
 * Stateless streamable HTTP: every request carries `Authorization: Bearer <key>`,
 * is authenticated on its own and gets a fresh server bound to that key's tenant.
 */
export function createHttpHandler(options: HttpHandlerOptions) {
  const resolveKey = options.resolveKey ?? defaultKeyResolver();
  const catalog = buildToolCatalog(options.registry);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== MCP_PATH) {
      sendJsonRpcError(res, 404, 'Not found');
      return;
    }
    let principal;
    try {
      principal = await authenticate(bearerToken(req.headers.authorization), resolveKey);
    } catch (err) {
      const status = err instanceof McpAuthError ? err.status : 401;
      sendJsonRpcError(res, status, err instanceof Error ? err.message : 'Unauthorized');
      return;
    }
    if (req.method !== 'POST') {
      // Stateless mode: no standalone SSE stream and no sessions to delete.
      sendJsonRpcError(res, 405, 'Method not allowed');
      return;
    }
    const server = createQvoMcpServerFromCatalog({ ...options, principal }, catalog);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) sendJsonRpcError(res, 500, 'Internal error');
    }
  };
}

async function main(): Promise<void> {
  const { listActions } = await import('../../../platform/actions');
  const port = Number(process.env.QVO_MCP_PORT ?? 3005);
  const host = process.env.QVO_MCP_HOST ?? '127.0.0.1';
  const handler = createHttpHandler({ registry: listActions() });
  createServer((req, res) => void handler(req, res)).listen(port, host, () => {
    process.stderr.write(`qvo-mcp: streamable HTTP on http://${host}:${port}${MCP_PATH}\n`);
  });
}

if (process.argv[1] && /http\.[cm]?[jt]s$/.test(process.argv[1])) {
  void main();
}
