import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { authenticate, defaultKeyResolver, McpAuthError, type KeyResolver, type McpPrincipal } from './auth';
import { createQvoMcpServer } from './server';

/** stdio has no headers: the key comes from `QVO_MCP_API_KEY` and is checked once at startup. */
export async function resolveStdioPrincipal(
  env: NodeJS.ProcessEnv = process.env,
  resolve: KeyResolver = defaultKeyResolver(env),
): Promise<McpPrincipal> {
  return authenticate(env.QVO_MCP_API_KEY, resolve);
}

async function main(): Promise<void> {
  let principal: McpPrincipal;
  try {
    principal = await resolveStdioPrincipal();
  } catch (err) {
    const message = err instanceof McpAuthError || err instanceof Error ? err.message : String(err);
    // stdout is the protocol channel; diagnostics go to stderr.
    process.stderr.write(`qvo-mcp: refused to start: ${message}\n`);
    process.exit(1);
  }
  const server = await createQvoMcpServer({ principal });
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `qvo-mcp: stdio ready (key ${principal.keyId}, tenant ${principal.tenantId ?? 'platform-admin'})\n`,
  );
}

if (process.argv[1] && /stdio\.[cm]?[jt]s$/.test(process.argv[1])) {
  void main();
}
