import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { writeAuditLog, extractIp } from './AuditService';
import { createLogger } from '../core/logger';

const logger = createLogger('AUDIT_MUTATION');

/**
 * Default-on Express middleware that records every non-GET tenant-scoped
 * admin-api request to the `audit_logs` table (BL-010 / S-06).
 *
 * Intentional opt-outs (set `req.skipAuditMutation = true` inside the handler):
 *   - `POST /v1/ingest/calls`   — high-volume machine-to-machine ingest with
 *                                  per-event domain audits already in place.
 *   - `POST /v1/ingest/tickets` — same.
 *
 * Add new opt-outs sparingly and document them here so the exclusion list
 * stays reviewable. Everything else (connector connect/disconnect, widget
 * token create/delete, phone-number routing, user invite + role change,
 * encryption rotate, GDPR erase, …) is captured automatically.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|token|apikey|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|client[_-]?secret|private[_-]?key|webhook[_-]?signature|otp|mfa)/i;

const REDACTED = '[REDACTED]';

const MAX_BODY_BYTES = 4_000;

export interface AuditMutationOptions {
  /**
   * Override the resource type. By default the first non-empty path segment
   * is used (e.g. `/widget/tokens/abc` → `widget`).
   */
  resourceType?: string;
  /**
   * Override the action string. By default a `<resource>.<method>` token is
   * derived from the URL (e.g. `POST /widget/tokens` → `widget_tokens.post`).
   */
  action?: string;
  /**
   * Extract the resource id. Defaults to `req.params.id`, falling back to
   * the last URL segment if it looks like an id.
   */
  resourceId?: (req: Request) => string | undefined;
  /**
   * Build the `changes` payload. Defaults to the sanitized request body.
   * Returning `undefined` writes an empty object.
   */
  changes?: (req: Request, res: Response) => Record<string, unknown> | undefined;
  /**
   * When true, also log non-2xx responses (with severity=warning).
   * Defaults to true so failed mutations stay in the audit trail.
   */
  logFailures?: boolean;
}

const DEFAULT_OPTIONS: Required<Pick<AuditMutationOptions, 'logFailures'>> = {
  logFailures: true,
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Set to `true` inside a route handler to opt this request out of the
       * default `auditMutation()` middleware (for example when the handler
       * writes a richer audit entry of its own).
       */
      skipAuditMutation?: boolean;
    }
  }
}

export function sanitizeAuditPayload(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[Truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => sanitizeAuditPayload(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = sanitizeAuditPayload(v, depth + 1);
      }
    }
    return out;
  }
  return undefined;
}

interface RouteShape {
  path?: string;
}

function getRouteTemplate(req: Request): string | undefined {
  const route = (req as unknown as { route?: RouteShape }).route;
  if (!route?.path || typeof route.path !== 'string') return undefined;
  const baseUrl = (req as unknown as { baseUrl?: string }).baseUrl ?? '';
  return `${baseUrl}${route.path}`;
}

function templateSegments(template: string): string[] {
  return template
    .split('?')[0]
    .split('/')
    .filter(seg => seg.length > 0 && !seg.startsWith(':') && seg !== '*');
}

function inferResource(req: Request): string {
  const template = getRouteTemplate(req);
  if (template) {
    const segs = templateSegments(template);
    if (segs.length > 0) return segs[0];
  }
  const segments = (req.path ?? req.url ?? '').split('?')[0].split('/').filter(Boolean);
  return segments[0] ?? 'request';
}

const ID_LIKE = /^([0-9a-f-]{8,}|\d+)$/i;

function inferResourceId(req: Request): string | undefined {
  if (req.params && typeof req.params === 'object') {
    const params = req.params as Record<string, string | undefined>;
    if (params.id) return params.id;
    for (const key of Object.keys(params)) {
      if (key.toLowerCase().endsWith('id') && params[key]) return params[key];
    }
    // No `:id`-style param — surface the first non-empty path param so the
    // audit row still points at *something* tenant operators can search on.
    for (const value of Object.values(params)) {
      if (value) return value;
    }
  }
  const segments = (req.path ?? req.url ?? '').split('?')[0].split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  return last && ID_LIKE.test(last) ? last : undefined;
}

function inferAction(req: Request): string {
  const method = req.method.toLowerCase();
  // Prefer the matched route template (e.g. `/connectors/:id/disconnect`) so
  // that dynamic segments never leak into the action string. This keeps
  // action cardinality bounded by the number of routes, not the number of
  // distinct ids — critical for queryability of audit_logs.
  const template = getRouteTemplate(req);
  if (template) {
    const segs = templateSegments(template);
    if (segs.length > 0) return `${segs.slice(0, 3).join('_')}.${method}`;
  }
  const segments = (req.path ?? req.url ?? '').split('?')[0].split('/').filter(Boolean);
  if (segments.length === 0) return `request.${method}`;
  const meaningful = segments
    .filter(seg => !ID_LIKE.test(seg))
    .slice(0, 3)
    .join('_');
  return `${meaningful || segments[0]}.${method}`;
}

function summarizeBody(body: unknown): Record<string, unknown> | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body !== 'object') return { value: sanitizeAuditPayload(body) as unknown };
  const sanitized = sanitizeAuditPayload(body);
  try {
    const serialized = JSON.stringify(sanitized);
    if (serialized.length > MAX_BODY_BYTES) {
      return { truncated: true, preview: `${serialized.slice(0, MAX_BODY_BYTES)}…` };
    }
  } catch {
    return { unserializable: true };
  }
  return sanitized as Record<string, unknown>;
}

/**
 * Express middleware that writes one `audit_logs` row per non-GET tenant
 * request. Routes can opt out by setting `req.skipAuditMutation = true`
 * inside the handler before the response is sent.
 *
 * The middleware logs after `res.finish` so the route's status code is
 * known. It never throws — failures are logged at warn-level only.
 */
export function auditMutation(options: AuditMutationOptions = {}): RequestHandler {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  return function auditMutationMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const startedAt = Date.now();

    res.on('finish', () => {
      try {
        if (req.skipAuditMutation) return;
        const user = req.user;
        if (!user || !user.tenantId) return;

        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (!ok && !merged.logFailures) return;

        const resourceType = options.resourceType ?? inferResource(req);
        const action = options.action ?? inferAction(req);
        const resourceId = options.resourceId ? options.resourceId(req) : inferResourceId(req);

        const bodySummary = options.changes
          ? options.changes(req, res)
          : summarizeBody(req.body);

        const changes: Record<string, unknown> = {
          method: req.method,
          path: (req.originalUrl ?? req.url ?? '').split('?')[0],
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt,
        };
        if (bodySummary && Object.keys(bodySummary).length > 0) {
          changes.body = bodySummary;
        }
        const queryKeys = Object.keys(req.query ?? {});
        if (queryKeys.length > 0) {
          changes.query = sanitizeAuditPayload(req.query) as Record<string, unknown>;
        }

        void writeAuditLog({
          tenantId: user.tenantId,
          actorUserId: user.userId,
          actorRole: user.role,
          action,
          resourceType,
          resourceId,
          changes,
          severity: ok ? 'info' : 'warning',
          ipAddress: extractIp(req),
          userAgent: req.headers['user-agent'] as string | undefined,
        });
      } catch (err) {
        logger.warn('auditMutation middleware failed to write entry', {
          path: req.path,
          method: req.method,
          error: String(err),
        });
      }
    });

    next();
  };
}
