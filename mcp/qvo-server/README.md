# QVO MCP server (`mcp/qvo-server`)

The sanctioned API for Wayne's bots (Grok Bot, tinkabot, Codez, …) to work with a QVO shop without
driving the browser. This is the PR-11 scaffold: transports, auth, tenant binding, dry-run writes
and audit. The read tools come in PR-23 and the ops/provisioning tools in PR-28.

Spec: [`docs/shop/tools-spec.md`](../../docs/shop/tools-spec.md) §0 (one action layer, three
callers) and §7 (MCP surface for templates).

## How it works

- **Tools are generated from the action registry** (`platform/actions`) through PR-01's
  `toMcpTool()`. Only actions whose definition sets `permissions.mcpScope` are exposed. Tool names
  go through `assignExternalToolNames`, so `scheduling.book.prepare` becomes
  `scheduling_book_prepare` and `qvo.get_tenant` becomes `qvo_get_tenant`.
- **Hand-written tools exist only as `qvo.*` admin helpers** (`src/tools.ts`). Registry actions may
  not use the `qvo.` prefix.
- **Auth:** an API key with scope `qvo:read` and/or `qvo:admin` (`qvo:admin` implies `qvo:read`).
  A key is bound to one tenant, or to platform-admin for the provisioning tools added later. A key
  only sees the tools its scopes allow, and a call is refused when the scope is missing.
- **Tenant binding:** every call runs with the key's tenant. The `tenantId` is never taken from tool
  arguments; passing a different `tenantId` is refused with `FORBIDDEN`. Tenant reads go through
  `withTenantClient`, so RLS (`qvo_app`) also pins the row.
- **Writes default to `dryRun: true`.** Every `write` / `prepare` / `commit` tool gets two extra
  arguments: `dryRun` (default `true`) and `idempotencyKey`. A dry run validates the input, checks
  the scope, writes an audit row (`result_code = dry_run`) and changes nothing. Only an explicit
  `dryRun: false` runs the action, and then `idempotencyKey` is required (commits fall back to
  their `confirmationToken`), exactly as `runAction` enforces for every caller.
- **Audit:** every call is written to the PR-01 `action_audit_log` with actor
  `{ type: 'mcp', id: <key id> }`, including refusals, unknown tools and dry runs. Inputs are
  redacted with `redactInput` (phone numbers masked to the last 4 digits).
- **Results:** each tool returns one text block containing the `ActionResult` JSON
  (`{ ok, data, readback? }` or `{ ok: false, error: { code, message, callerSafeMessage, … } }`),
  with `isError: true` on failure. `INTERNAL` errors never include exception details.

## Tools

| Tool | Source | Scope | Tenant key needed | Notes |
|---|---|---|---|---|
| `qvo_list_actions` (`qvo.list_actions`) | helper | `qvo:read` | no | Actions this key can call: action, tool name, kind, scope |
| `qvo_get_tenant` (`qvo.get_tenant`) | helper | `qvo:read` | yes | `{ name, timezone, enabledTools }` of the bound tenant |
| `qvo_list_templates` (`qvo.list_templates`) | helper | `qvo:read` | no | Stub returning `[]` until PR-19 |
| any action with `permissions.mcpScope` | generated | the action's `mcpScope` | yes | Writes take `dryRun` (default `true`) and `idempotencyKey` |

No app action sets `mcpScope` yet, so today the live server lists only the three helpers. See
[`TRANSCRIPT.md`](TRANSCRIPT.md) for a session against the PR-01 fixture actions.

## API keys

The server accepts two kinds of key, checked in this order:

1. **Tenant API keys** (`vai_…`), the existing mechanism in `platform/rbac/ApiKeyService.ts`.
   Create one in Settings → API keys (`POST /settings/api-keys`) with scopes `["qvo:read"]` or
   `["qvo:read", "qvo:admin"]`. Keys with the legacy `*` scope are **not** accepted here.
2. **Env-configured keys** (`QVO_MCP_API_KEYS`), for platform-admin keys and local use. It's a JSON
   array; keys are stored as SHA-256 hashes, never in plaintext:

   ```json
   [
     { "id": "grok-bot-marco", "sha256": "<sha256 of the key>", "tenantId": "<tenant uuid>", "scopes": ["qvo:read"] },
     { "id": "tinkabot-ops", "sha256": "<sha256 of the key>", "platformAdmin": true, "scopes": ["qvo:admin"] }
   ]
   ```

   Hash a key with `node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" '<key>'`.
   Malformed config fails at startup instead of running open.

## Run locally

Both transports use the app database (same env as the Admin API: `DATABASE_URL` in development,
`PLATFORM_DB_POOL_URL` + `DATABASE_URL_PRIVILEGED` elsewhere) for tenant reads, API-key lookups and
the audit log. Run from the repo root; the package uses the root `node_modules`.

**stdio** (one key per process, checked at startup):

```bash
QVO_MCP_API_KEY=vai_... npx tsx mcp/qvo-server/src/stdio.ts
```

**Streamable HTTP** (stateless; every request carries `Authorization: Bearer <key>`):

```bash
QVO_MCP_PORT=3005 npx tsx mcp/qvo-server/src/http.ts
# → http://127.0.0.1:3005/mcp   (QVO_MCP_HOST to change the bind address)
```

**MCP Inspector:**

```bash
npx @modelcontextprotocol/inspector -e QVO_MCP_API_KEY=vai_... -- npx tsx mcp/qvo-server/src/stdio.ts
```

## Connect a client

**Claude Code** (stdio, project `.mcp.json` or `claude mcp add`):

```json
{
  "mcpServers": {
    "qvo": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/repo/mcp/qvo-server/src/stdio.ts"],
      "env": { "QVO_MCP_API_KEY": "vai_...", "DATABASE_URL": "postgres://..." }
    }
  }
}
```

Or over HTTP:

```bash
claude mcp add --transport http qvo http://127.0.0.1:3005/mcp --header "Authorization: Bearer vai_..."
```

**Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "qvo": {
      "url": "http://127.0.0.1:3005/mcp",
      "headers": { "Authorization": "Bearer vai_..." }
    }
  }
}
```

Use the stdio form from the Claude Code snippet if you'd rather not run the HTTP server.

## Develop

```bash
npm run test -- mcp/qvo-server             # in-memory client ↔ server tests, no DB, no network
npm --prefix mcp/qvo-server run typecheck  # tsc with the root TypeScript
npm run test -- mcp/qvo-server -u          # refresh the schema snapshot and TRANSCRIPT.md
```

This package has no lockfile or `node_modules` of its own. `@modelcontextprotocol/sdk` and `zod`
resolve from the root install; keep to SDK APIs available in 1.26.0 (the version CI installs).
CI: `.github/workflows/mcp-server.yml`.

No deployment config yet: hosting is decided later.

| File | What |
|---|---|
| `src/server.ts` | `createQvoMcpServer`: tool listing, call dispatch, tenant binding, dry run, audit |
| `src/tools.ts` | Catalog generated from the registry + `qvo.*` helpers |
| `src/auth.ts` | Scopes, key resolvers (tenant API keys, env list), `authenticate` |
| `src/tenants.ts` | Tenant directory (Postgres via `withTenantClient`, in-memory for tests) |
| `src/stdio.ts`, `src/http.ts` | Transports |
| `src/testing.ts` | In-memory fixtures shared by the tests and the transcript |
