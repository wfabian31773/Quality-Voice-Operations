/**
 * Process roles (PR-00, Render migration).
 *
 * The same repo runs in two places:
 *   - Replit: `.replit` starts the admin API and the voice gateway side by
 *     side with no QVO_PROCESS_ROLE set. That is role `all` and must keep
 *     today's behavior (admin API owns every scheduler, `/vg` proxies HTTP
 *     and WebSocket traffic to the voice gateway on 127.0.0.1).
 *   - Render: one role per service (`api`, `voice`, `worker`, `cron`), see
 *     render.yaml and docs/deploy/render.md.
 */

export const PROCESS_ROLES = ['all', 'api', 'voice', 'worker', 'cron'] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

type Env = Record<string, string | undefined>;

export function isProcessRole(value: string): value is ProcessRole {
  return (PROCESS_ROLES as readonly string[]).includes(value);
}

/**
 * Resolve QVO_PROCESS_ROLE. Unset/blank → `fallback` (default `all`, which is
 * the Replit behavior). An unknown value throws so a typo in the Render
 * dashboard fails the boot instead of silently running as `all`.
 */
export function resolveProcessRole(env: Env = process.env, fallback: ProcessRole = 'all'): ProcessRole {
  const raw = env.QVO_PROCESS_ROLE?.trim().toLowerCase();
  if (!raw) return fallback;
  if (!isProcessRole(raw)) {
    throw new Error(
      `QVO_PROCESS_ROLE must be one of ${PROCESS_ROLES.join(', ')} (got an unknown value)`,
    );
  }
  return raw;
}

/** Render sets RENDER=true in every service's runtime and build environment. */
export function isRenderRuntime(env: Env = process.env): boolean {
  return env.RENDER === 'true';
}

function parsePort(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Voice gateway listen port. On Render (role `voice`) the platform injects
 * PORT; everywhere else keep `VOICE_GATEWAY_PORT ?? 3001` so Replit's
 * admin-api proxy target stays where it is.
 */
export function resolveVoicePort(role: ProcessRole, env: Env = process.env): number {
  if (role === 'voice') {
    return parsePort(env.PORT) ?? parsePort(env.VOICE_GATEWAY_PORT) ?? 3001;
  }
  return parsePort(env.VOICE_GATEWAY_PORT) ?? 3001;
}

/**
 * Admin API listen port. Role `api` binds Render's PORT; otherwise the
 * existing `ADMIN_API_PORT ?? PORT ?? 3002` order is unchanged.
 */
export function resolveApiPort(role: ProcessRole, env: Env = process.env): number {
  if (role === 'api') {
    return parsePort(env.PORT) ?? parsePort(env.ADMIN_API_PORT) ?? 3002;
  }
  return parsePort(env.ADMIN_API_PORT) ?? parsePort(env.PORT) ?? 3002;
}

export const REPLIT_ONLY_ENV_NAMES = ['REPLIT_DEV_DOMAIN', 'REPL_ID'] as const;

/**
 * On Render, never fall back to Replit-only hostnames or seeds. About twenty
 * call sites read `REPLIT_DEV_DOMAIN` / `REPL_ID` as a fallback; removing
 * them from the environment up front is the one place that guarantees none
 * of those fallbacks can fire. Returns the names that were removed.
 */
export function scrubReplitFallbacks(env: Env = process.env): string[] {
  if (!isRenderRuntime(env)) return [];
  const removed: string[] = [];
  for (const name of REPLIT_ONLY_ENV_NAMES) {
    if (env[name] !== undefined) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Public base URL Twilio should call for app-configured webhooks
 * (phone-number provisioning, campaign callbacks). `VOICE_GATEWAY_BASE_URL`
 * wins; the Replit dev-domain fallback is only used off Render. Returns null
 * when neither is available so callers can refuse instead of producing
 * `https://undefined/twilio/voice`.
 */
export function resolveVoiceGatewayBaseUrl(env: Env = process.env): string | null {
  const explicit = env.VOICE_GATEWAY_BASE_URL?.trim();
  if (explicit) return stripTrailingSlash(explicit);
  if (isRenderRuntime(env)) return null;
  const devDomain = env.REPLIT_DEV_DOMAIN?.trim();
  return devDomain ? `https://${devDomain}` : null;
}

/** `VOICE_PUBLIC_BASE_URL` (direct voice hosting on Render), normalized. */
export function resolveVoicePublicBaseUrl(env: Env = process.env): string | null {
  const raw = env.VOICE_PUBLIC_BASE_URL?.trim();
  return raw ? stripTrailingSlash(raw) : null;
}

/**
 * Admin API `/vg` HTTP proxy target. On Render the voice gateway is its own
 * service reached over the private network (`VOICE_GATEWAY_INTERNAL_HOSTPORT`
 * from render.yaml `fromService ... property: hostport`); on Replit it is the
 * sibling process on 127.0.0.1.
 */
export function resolveVoiceGatewayProxyTarget(env: Env = process.env): string {
  const internal = env.VOICE_GATEWAY_INTERNAL_HOSTPORT?.trim();
  if (internal) return `http://${internal}`;
  return `http://127.0.0.1:${parsePort(env.VOICE_GATEWAY_PORT) ?? 3001}`;
}
