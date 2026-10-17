# Needs from other lanes (PR-11)

Things this package can't do inside `mcp/qvo-server/**`. Move these to the PR body.

1. **Install the SDK from the root manifest.** This package's dependencies aren't installed by
   anything it controls. `pnpm-workspace.yaml` lists only `client-app`, and the root manifest
   doesn't declare `@modelcontextprotocol/sdk`: in `package-lock.json` the SDK (1.26.0) is only an
   optional transitive dependency of `@openai/agents-core`. After a root `pnpm install` the package
   typecheck fails with TS2307; the npm CI path works only by accident. The platform lane should
   either add `"@modelcontextprotocol/sdk": "^1.26.0"` as a direct root dependency (and refresh
   `package-lock.json` / `pnpm-lock.yaml`), or add `mcp/qvo-server` to `pnpm-workspace.yaml` (and
   npm `workspaces` if used) with the lockfile updates. Until then, if `@openai/agents-core` drops
   or changes that optional dependency, CI and local runs of this package break.
2. **Platform-level audit for platform-admin keys.** `action_audit_log.tenant_id` is required and
   RLS-scoped, so calls made with a platform-admin key (`tenantId: null`) are not audited today.
   Only `qvo.list_actions` and `qvo.list_templates` are reachable with such a key, and both are
   read-only. Before the provisioning tools (PR-28) land, the action core needs a platform audit
   sink (a nullable `tenant_id` or a separate table), owned by the PR-01 / platform lane.
3. **Actions must opt in with `permissions.mcpScope`.** No app action sets it yet, so the live
   server exposes only the `qvo.*` helpers. The scheduling (#101), tickets (#102), SMS (PR-09) and
   later lanes should set `mcpScope: 'qvo:read'` on reads and `'qvo:admin'` on writes. Action
   input schemas must not define `dryRun` or `idempotencyKey`: the MCP adapter reserves them.
4. **Where enabled tools live.** `qvo.get_tenant` reads `tenants.settings.enabledTools` for now.
   PR-19 (use-case templates) should own that list; `qvo.list_templates` returns `[]` until then.
5. **Creating MCP keys.** Tenant API keys (`vai_…`, `/settings/api-keys`) already accept arbitrary
   scope strings, so `qvo:read` / `qvo:admin` keys can be minted without code changes. Keys with
   the legacy default scope `*` are deliberately **not** accepted by the MCP server. A settings UI
   option for the two scopes would help but isn't required.
6. **Optional root script.** A root `npm run mcp:typecheck` alias would be convenient; CI uses
   `npm --prefix mcp/qvo-server run typecheck` instead, so it isn't required.
