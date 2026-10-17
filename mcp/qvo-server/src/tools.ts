import { z, type ZodTypeAny } from 'zod';
import {
  assignExternalToolNames,
  isWriteKind,
  toMcpTool,
  zodToJsonSchema,
  type ActionKind,
  type AnyActionDefinition,
  type ExternalToolNames,
  type McpToolSchema,
} from '../../../platform/actions/core';
import type { McpScope } from './auth';

/** Write arguments the MCP adapter owns. They never reach the action input. */
export const WRITE_META_PROPERTIES = {
  dryRun: {
    type: 'boolean',
    default: true,
    description: 'Defaults to true: validate and audit only. Pass false to actually run the write.',
  },
  idempotencyKey: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    description: 'Required when dryRun is false. Same key + same input replays the stored result.',
  },
} as const;

export const ADMIN_HELPER_PREFIX = 'qvo.';

/** Hand-written `qvo.*` helper. Everything else is generated from the action registry. */
export interface AdminHelper {
  name: string;
  description: string;
  scope: McpScope;
  /** True when the helper reads tenant data and needs a tenant-bound key. */
  tenantBound: boolean;
  input: ZodTypeAny;
}

export type CatalogEntry =
  | { source: 'helper'; name: string; external: string; scope: McpScope; tenantBound: boolean; helper: AdminHelper; schema: McpToolSchema }
  | { source: 'action'; name: string; external: string; scope: McpScope; tenantBound: true; kind: ActionKind; def: AnyActionDefinition; schema: McpToolSchema };

export interface ToolCatalog {
  entries: CatalogEntry[];
  names: ExternalToolNames;
  byExternal: Map<string, CatalogEntry>;
}

export const ADMIN_HELPERS: AdminHelper[] = [
  {
    name: 'qvo.list_actions',
    description: 'List the QVO actions this key can call over MCP, with kind and required scope.',
    scope: 'qvo:read',
    tenantBound: false,
    input: z.object({}),
  },
  {
    name: 'qvo.get_tenant',
    description: "Get the bound tenant's name, timezone and enabled tools.",
    scope: 'qvo:read',
    tenantBound: true,
    input: z.object({
      tenantId: z.string().min(1).optional(),
    }),
  },
  {
    name: 'qvo.list_templates',
    description: 'List use-case templates (barbershop, nail salon, …). Returns [] until templates ship.',
    scope: 'qvo:read',
    tenantBound: false,
    input: z.object({}),
  },
];

function isMcpScope(scope: string | undefined): scope is McpScope {
  return scope === 'qvo:read' || scope === 'qvo:admin';
}

function writeSchema(base: Record<string, unknown>, actionName: string): Record<string, unknown> {
  const properties = { ...((base.properties as Record<string, unknown> | undefined) ?? {}) };
  for (const key of Object.keys(WRITE_META_PROPERTIES)) {
    if (key in properties) {
      throw new Error(`Action ${actionName} input already defines "${key}", which the MCP adapter reserves`);
    }
  }
  return { ...base, properties: { ...properties, ...WRITE_META_PROPERTIES } };
}

function helperSchema(helper: AdminHelper, external: string): McpToolSchema {
  return {
    name: external,
    description: helper.description,
    inputSchema: zodToJsonSchema(helper.input),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
}

function actionSchema(def: AnyActionDefinition, external: string): McpToolSchema {
  const base = toMcpTool(def);
  const inputSchema = isWriteKind(def.kind) ? writeSchema(base.inputSchema, def.name) : base.inputSchema;
  return { ...base, name: external, inputSchema };
}

/**
 * Builds the full MCP tool list. Only actions whose definition sets
 * `permissions.mcpScope` are exposed. Names go through PR-01's
 * `assignExternalToolNames` so `qvo.get_tenant` becomes `qvo_get_tenant`.
 */
export function buildToolCatalog(
  registry: AnyActionDefinition[],
  helpers: AdminHelper[] = ADMIN_HELPERS,
): ToolCatalog {
  const exposed = registry.filter((def) => def.permissions.mcpScope !== undefined);
  for (const def of exposed) {
    if (def.name.startsWith(ADMIN_HELPER_PREFIX)) {
      throw new Error(`Action ${def.name} uses the reserved ${ADMIN_HELPER_PREFIX}* prefix`);
    }
    if (!isMcpScope(def.permissions.mcpScope)) {
      throw new Error(`Action ${def.name} has unknown mcpScope "${def.permissions.mcpScope}"`);
    }
    if (isWriteKind(def.kind) && def.permissions.mcpScope !== 'qvo:admin') {
      throw new Error(`Action ${def.name} is a ${def.kind} action and must use mcpScope "qvo:admin"`);
    }
  }
  const allNames = [...helpers.map((helper) => helper.name), ...exposed.map((def) => def.name)];
  if (new Set(allNames).size !== allNames.length) throw new Error('Duplicate MCP tool name in registry');
  const names = assignExternalToolNames(allNames);
  const external = (name: string) => names.toExternal.get(name) as string;

  const entries: CatalogEntry[] = [
    ...helpers.map(
      (helper): CatalogEntry => ({
        source: 'helper',
        name: helper.name,
        external: external(helper.name),
        scope: helper.scope,
        tenantBound: helper.tenantBound,
        helper,
        schema: helperSchema(helper, external(helper.name)),
      }),
    ),
    ...exposed.map(
      (def): CatalogEntry => ({
        source: 'action',
        name: def.name,
        external: external(def.name),
        scope: def.permissions.mcpScope as McpScope,
        tenantBound: true,
        kind: def.kind,
        def,
        schema: actionSchema(def, external(def.name)),
      }),
    ),
  ].sort((a, b) => a.external.localeCompare(b.external));

  return { entries, names, byExternal: new Map(entries.map((entry) => [entry.external, entry])) };
}

/** What a principal may see: right scope, and a tenant if the tool needs one. */
export function isVisibleTo(entry: CatalogEntry, scopes: McpScope[], tenantId: string | null): boolean {
  if (!scopes.includes(entry.scope)) return false;
  if (entry.tenantBound && !tenantId) return false;
  return true;
}
