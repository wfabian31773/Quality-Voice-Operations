import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import {
  actionFail,
  actionOk,
  auditActor,
  checkPermission,
  internalError,
  isWriteKind,
  postgresActionStore,
  redactInput,
  runActionDefinition,
  type ActionContext,
  type ActionResult,
  type ActionRuntime,
  type Actor,
  type AnyActionDefinition,
} from '../../../platform/actions/core';
import { publicHttpResult } from '../../../platform/actions/core/adapters';
import { defaultWithTenantTx } from '../../../platform/actions/core/runtime';
import type { McpPrincipal } from './auth';
import { postgresTenantDirectory, type TenantDirectory } from './tenants';
import { buildToolCatalog, isVisibleTo, type CatalogEntry, type ToolCatalog } from './tools';

export const SERVER_NAME = 'qvo';
export const SERVER_VERSION = '0.1.0';

export interface QvoMcpServerOptions {
  principal: McpPrincipal;
  /** Defaults to the app registry (`platform/actions`). */
  registry?: AnyActionDefinition[];
  /** Store + tenant transaction used for actions and the audit log. Defaults to Postgres. */
  runtime?: ActionRuntime;
  tenants?: TenantDirectory;
  /** Stub until PR-19 ships use-case templates. */
  listTemplates?: () => Promise<unknown[]>;
  now?: () => Date;
}

type Args = Record<string, unknown>;

function asArgs(raw: unknown): Args {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Args) : {};
}

function validationFailure(err: ZodError): ActionResult<never> {
  const issue = err.issues[0];
  const field = issue?.path?.length ? issue.path.map(String).join('.') : undefined;
  return actionFail('VALIDATION_FAILED', issue?.message ?? 'Invalid input', { field });
}

function toCallToolResult(result: ActionResult): CallToolResult {
  const body = publicHttpResult(result);
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    isError: !body.ok,
  };
}

async function loadDefaultRegistry(): Promise<AnyActionDefinition[]> {
  const { listActions } = await import('../../../platform/actions');
  return listActions();
}

export async function createQvoMcpServer(options: QvoMcpServerOptions): Promise<Server> {
  const registry = options.registry ?? (await loadDefaultRegistry());
  return createQvoMcpServerFromCatalog(options, buildToolCatalog(registry));
}

export function createQvoMcpServerFromCatalog(options: QvoMcpServerOptions, catalog: ToolCatalog): Server {
  const { principal } = options;
  const runtime = options.runtime ?? {};
  const store = runtime.store ?? postgresActionStore;
  const withTenantTx = runtime.withTenantTx ?? defaultWithTenantTx;
  const tenants = options.tenants ?? postgresTenantDirectory();
  const listTemplates = options.listTemplates ?? (async () => []);
  const now = options.now ?? (() => new Date());
  const actor: Actor = { type: 'mcp', id: principal.keyId, scopes: [...principal.scopes] };
  const visible = catalog.entries.filter((entry) => isVisibleTo(entry, principal.scopes, principal.tenantId));

  /** PR-01 audit log (`action_audit_log`), actor type `mcp`. Best-effort, like runAction. */
  async function audit(action: string, input: unknown, resultCode: string, startedAt: number): Promise<void> {
    // Platform-admin calls have no tenant row to write against (see NEEDS.md).
    if (!principal.tenantId) return;
    const tenantId = principal.tenantId;
    try {
      await withTenantTx(tenantId, (tx) =>
        store.insertAudit(tx, {
          tenantId,
          action,
          actor: auditActor(actor),
          inputRedacted: redactInput(input) ?? {},
          resultCode,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        }),
      );
    } catch {
      // Audit failure must not change the tool result.
    }
  }

  async function refuse(action: string, input: unknown, result: ActionResult, startedAt: number) {
    await audit(action, input, result.ok ? 'ok' : result.error.code, startedAt);
    return toCallToolResult(result);
  }

  async function runHelper(entry: Extract<CatalogEntry, { source: 'helper' }>, args: Args, startedAt: number) {
    const parsed = entry.helper.input.safeParse(args);
    if (!parsed.success) return refuse(entry.name, args, validationFailure(parsed.error), startedAt);

    let result: ActionResult;
    try {
      switch (entry.name) {
        case 'qvo.list_actions':
          result = actionOk(
            visible
              .filter((e): e is Extract<CatalogEntry, { source: 'action' }> => e.source === 'action')
              .map((e) => ({
                action: e.name,
                tool: e.external,
                kind: e.kind,
                scope: e.scope,
                description: e.schema.description,
              })),
          );
          break;
        case 'qvo.get_tenant': {
          const tenant = await tenants.getTenant(principal.tenantId as string);
          result = tenant
            ? actionOk({ name: tenant.name, timezone: tenant.timezone, enabledTools: tenant.enabledTools })
            : actionFail('NOT_FOUND', 'Tenant not found');
          break;
        }
        case 'qvo.list_templates':
          result = actionOk(await listTemplates());
          break;
        default:
          result = actionFail('NOT_FOUND', `Unknown tool: ${entry.name}`);
      }
    } catch (err) {
      result = internalError(err);
    }
    await audit(entry.name, parsed.data, result.ok ? 'ok' : result.error.code, startedAt);
    return toCallToolResult(result);
  }

  async function runActionTool(entry: Extract<CatalogEntry, { source: 'action' }>, args: Args, startedAt: number) {
    const { def } = entry;
    const write = isWriteKind(def.kind);
    let input: Args = args;
    let dryRun = false;
    let idempotencyKey: string | undefined;
    if (write) {
      const { dryRun: rawDryRun, idempotencyKey: rawKey, ...rest } = args;
      input = rest;
      // Anything other than an explicit `false` is a dry run.
      dryRun = rawDryRun !== false;
      if (rawKey !== undefined && (typeof rawKey !== 'string' || rawKey.length === 0 || rawKey.length > 200)) {
        return refuse(def.name, input, actionFail('VALIDATION_FAILED', 'idempotencyKey must be a 1-200 char string', { field: 'idempotencyKey' }), startedAt);
      }
      idempotencyKey = rawKey as string | undefined;
    }

    const tenantId = principal.tenantId as string;
    let tenantTimezone: string;
    try {
      const tenant = await tenants.getTenant(tenantId);
      if (!tenant) return refuse(def.name, input, actionFail('NOT_FOUND', 'Tenant not found'), startedAt);
      tenantTimezone = tenant.timezone;
    } catch (err) {
      return refuse(def.name, input, internalError(err), startedAt);
    }

    const ctx: ActionContext = { tenantId, actor, now: now(), tenantTimezone, idempotencyKey };

    if (dryRun) {
      const parsed = def.input.safeParse(input);
      if (!parsed.success) return refuse(def.name, input, validationFailure(parsed.error), startedAt);
      const denied = checkPermission(def, actor);
      if (denied) return refuse(def.name, parsed.data, denied, startedAt);
      await audit(def.name, parsed.data, 'dry_run', startedAt);
      return toCallToolResult(
        actionOk(
          { dryRun: true, action: def.name, kind: def.kind, input: parsed.data },
          { readback: `Dry run: ${def.name} was validated and not executed. Pass dryRun: false and an idempotencyKey to run it.` },
        ),
      );
    }

    // runActionDefinition validates, checks the mcp scope, enforces idempotency and audits.
    return toCallToolResult(await runActionDefinition(def, ctx, input, runtime));
  }

  async function callTool(external: string, rawArgs: unknown): Promise<CallToolResult> {
    const startedAt = performance.now();
    const args = asArgs(rawArgs);
    const entry = catalog.byExternal.get(external);
    if (!entry) {
      // action_audit_log.action is VARCHAR(128); a longer caller-supplied name would fail the audit insert.
      const action = external.length > 128 ? `${external.slice(0, 125)}...` : external;
      return refuse(action, args, actionFail('NOT_FOUND', `Unknown tool: ${external}`), startedAt);
    }

    if (args.tenantId !== undefined && args.tenantId !== principal.tenantId) {
      return refuse(entry.name, args, actionFail('FORBIDDEN', 'This key is bound to a different tenant', { field: 'tenantId' }), startedAt);
    }
    if (entry.tenantBound && !principal.tenantId) {
      return refuse(entry.name, args, actionFail('FORBIDDEN', 'This tool needs a tenant-bound key'), startedAt);
    }
    if (!principal.scopes.includes(entry.scope)) {
      return refuse(entry.name, args, actionFail('FORBIDDEN', `Missing scope ${entry.scope}`), startedAt);
    }

    return entry.source === 'helper' ? runHelper(entry, args, startedAt) : runActionTool(entry, args, startedAt);
  }

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'QVO shop tools. Every call is bound to the tenant of your API key and audited. Writes default to dryRun: true.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visible.map((entry) => ({ ...entry.schema, inputSchema: entry.schema.inputSchema as Tool['inputSchema'] })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments),
  );
  return server;
}
