import { createHash, timingSafeEqual } from 'node:crypto';

export const MCP_SCOPES = ['qvo:read', 'qvo:admin'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/**
 * Who is calling. Every principal is bound to exactly one tenant, or to
 * platform-admin (`tenantId: null`) for the provisioning tools added later.
 */
export interface McpPrincipal {
  keyId: string;
  tenantId: string | null;
  scopes: McpScope[];
}

export type KeyResolver = (rawKey: string) => Promise<McpPrincipal | null>;

export class McpAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 = 401,
  ) {
    super(message);
    this.name = 'McpAuthError';
  }
}

/**
 * Only explicit `qvo:*` scopes count. A legacy `*` API key does not grant MCP
 * access. `qvo:admin` implies `qvo:read`.
 */
export function normalizeScopes(raw: unknown): McpScope[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set<McpScope>();
  for (const scope of raw) {
    if (scope === 'qvo:read' || scope === 'qvo:admin') set.add(scope);
  }
  if (set.has('qvo:admin')) set.add('qvo:read');
  return MCP_SCOPES.filter((scope) => set.has(scope));
}

export function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

interface EnvKeyEntry {
  id: string;
  sha256: string;
  tenantId: string | null;
  scopes: McpScope[];
}

/**
 * Parses `QVO_MCP_API_KEYS`: a JSON array of
 * `{ "id", "sha256", "tenantId" | "platformAdmin": true, "scopes": [...] }`.
 * Keys are stored hashed; plaintext keys never live in config.
 */
export function parseEnvKeys(json: string | undefined): EnvKeyEntry[] {
  if (!json || json.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('QVO_MCP_API_KEYS is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('QVO_MCP_API_KEYS must be a JSON array');
  const ids = new Set<string>();
  return parsed.map((raw, index) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const where = `QVO_MCP_API_KEYS[${index}]`;
    if (typeof entry.id !== 'string' || entry.id.length === 0) throw new Error(`${where}.id is required`);
    if (ids.has(entry.id)) throw new Error(`${where}.id "${entry.id}" is duplicated`);
    ids.add(entry.id);
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      throw new Error(`${where}.sha256 must be a 64-char hex SHA-256 of the key`);
    }
    const hasTenant = typeof entry.tenantId === 'string' && entry.tenantId.length > 0;
    const platformAdmin = entry.platformAdmin === true;
    if (hasTenant === platformAdmin) {
      throw new Error(`${where} must set exactly one of tenantId or platformAdmin: true`);
    }
    const scopes = normalizeScopes(entry.scopes);
    if (scopes.length === 0) throw new Error(`${where}.scopes must include qvo:read or qvo:admin`);
    return {
      id: entry.id,
      sha256: entry.sha256.toLowerCase(),
      tenantId: hasTenant ? (entry.tenantId as string) : null,
      scopes,
    };
  });
}

export function envKeyResolver(json: string | undefined): KeyResolver {
  const entries = parseEnvKeys(json);
  return async (rawKey) => {
    if (!rawKey) return null;
    const candidate = Buffer.from(hashKey(rawKey), 'hex');
    for (const entry of entries) {
      if (timingSafeEqual(candidate, Buffer.from(entry.sha256, 'hex'))) {
        return { keyId: `env:${entry.id}`, tenantId: entry.tenantId, scopes: entry.scopes };
      }
    }
    return null;
  };
}

/**
 * Reuses the tenant API keys (`vai_…`, `platform/rbac/ApiKeyService`). Only
 * keys created with explicit `qvo:read` / `qvo:admin` scopes are accepted.
 * Imported lazily so tests and env-only setups never touch the database.
 */
export function tenantApiKeyResolver(): KeyResolver {
  return async (rawKey) => {
    if (!rawKey.startsWith('vai_')) return null;
    const { validateApiKey } = await import('../../../platform/rbac/ApiKeyService');
    const result = await validateApiKey(rawKey);
    if (!result) return null;
    const scopes = normalizeScopes(result.scopes);
    if (scopes.length === 0) return null;
    return { keyId: `apikey:${result.keyId}`, tenantId: result.tenantId, scopes };
  };
}

export function chainResolvers(...resolvers: KeyResolver[]): KeyResolver {
  return async (rawKey) => {
    for (const resolve of resolvers) {
      const principal = await resolve(rawKey);
      if (principal) return principal;
    }
    return null;
  };
}

export function defaultKeyResolver(env: NodeJS.ProcessEnv = process.env): KeyResolver {
  return chainResolvers(tenantApiKeyResolver(), envKeyResolver(env.QVO_MCP_API_KEYS));
}

export function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match?.[1];
}

/** Refuses a missing or unknown key. Fail-closed: resolver errors are refusals. */
export async function authenticate(rawKey: string | undefined, resolve: KeyResolver): Promise<McpPrincipal> {
  if (!rawKey) throw new McpAuthError('Missing API key');
  let principal: McpPrincipal | null;
  try {
    principal = await resolve(rawKey);
  } catch {
    throw new McpAuthError('API key could not be verified');
  }
  if (!principal) throw new McpAuthError('Invalid or expired API key');
  if (principal.scopes.length === 0) throw new McpAuthError('API key has no qvo:* scope', 403);
  return principal;
}
