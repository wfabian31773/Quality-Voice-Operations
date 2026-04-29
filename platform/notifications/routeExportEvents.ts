import { EventEmitter } from 'node:events';
import { createLogger } from '../core/logger';

const logger = createLogger('ROUTE_EXPORT_EVENTS');

/**
 * Lightweight, in-process pub/sub for `processRouteExportJob` status
 * transitions.
 *
 * The dispatcher's "Recent exports" panel originally polled
 * `GET /dispatch/route-exports` every 5s while any row was still being
 * built. That works fine for one dispatcher clicking "export" once, but
 * during a busy quarter-end audit (multiple dispatchers each watching
 * their own export) the polling fan-out adds up — at 5s per dispatcher
 * × N tabs × M tenants the read pressure on `dispatch_route_export_jobs`
 * is mostly wasted polling. Pushing each transition (`pending → running`,
 * `running → ready`, `* → failed`) over a tenant-scoped SSE channel
 * lets the UI react instantly and lets us back off the poll storm to
 * "only when SSE is unavailable".
 *
 * Scope is intentionally per-process: the worker that writes the row
 * status is the same process that hosts the SSE connection (single
 * Express deployment), so a plain Node `EventEmitter` is enough — no
 * Redis, no cross-process bus. If we ever shard the worker out, this
 * module is the single seam to swap for a network broker.
 */

export type RouteExportStatus = 'pending' | 'running' | 'ready' | 'failed';

export interface RouteExportStatusChangedPayload {
  /**
   * The export-job id whose status just changed. The client uses this
   * to locate the row in the "Recent exports" panel and patch it in
   * place rather than re-fetching the entire list.
   */
  exportJobId: string;
  /**
   * The new status the row was just transitioned to. Stays a narrow
   * union so the client switch-on is exhaustive.
   */
  status: RouteExportStatus;
  /**
   * Server timestamp (ISO 8601) the transition was emitted at. Used by
   * the client only for ordering / diagnostics — the authoritative
   * transition time still lives on the `dispatch_route_export_jobs`
   * row.
   */
  emittedAt: string;
  /**
   * Optional human-readable error message attached to a `failed`
   * transition. Mirrors `dispatch_route_export_jobs.error_message`,
   * truncated to 1000 chars by the writer.
   */
  errorMessage?: string | null;
}

export type RouteExportStatusListener = (
  payload: RouteExportStatusChangedPayload,
) => void;

// One emitter per process. Tenants are namespaced as a per-event suffix
// so a listener for `tenant-A` never sees `tenant-B`'s transitions even
// though they share the underlying emitter — Node's EventEmitter dispatch
// is keyed on the exact event name string.
const emitter = new EventEmitter();

// Be generous: a busy admin console can legitimately have many SSE
// connections open across tabs, plus the (small) per-tenant dispatcher
// fanout. The default of 10 listeners trips Node's "possible memory leak"
// warning long before we'd actually be leaking — bump to a comfortable
// ceiling so legitimate usage stays quiet in the logs.
emitter.setMaxListeners(0);

const STATUS_CHANGED_EVENT_PREFIX = 'route_export.status_changed:';

function eventKey(tenantId: string): string {
  return `${STATUS_CHANGED_EVENT_PREFIX}${tenantId}`;
}

/**
 * Fire-and-forget broadcast of a route-export status transition. Errors
 * thrown by individual listeners are caught + logged so a misbehaving
 * subscriber can never break the worker that's calling us inside its
 * own try/catch.
 */
export function emitRouteExportStatusChanged(
  tenantId: string,
  payload: Omit<RouteExportStatusChangedPayload, 'emittedAt'> & {
    emittedAt?: string;
  },
): void {
  if (!tenantId) return;
  const enriched: RouteExportStatusChangedPayload = {
    exportJobId: payload.exportJobId,
    status: payload.status,
    errorMessage: payload.errorMessage ?? null,
    emittedAt: payload.emittedAt ?? new Date().toISOString(),
  };
  try {
    emitter.emit(eventKey(tenantId), enriched);
  } catch (err) {
    // EventEmitter#emit re-throws synchronous listener errors. Swallow
    // them so a bad subscriber can't blow up the worker.
    logger.warn('emitRouteExportStatusChanged listener threw', {
      tenantId,
      exportJobId: enriched.exportJobId,
      status: enriched.status,
      error: String(err),
    });
  }
}

/**
 * Subscribe to status transitions for a single tenant. Returns an
 * unsubscribe function the caller MUST invoke on disconnect to avoid a
 * slow listener leak.
 */
export function subscribeRouteExportEvents(
  tenantId: string,
  listener: RouteExportStatusListener,
): () => void {
  const key = eventKey(tenantId);
  const wrapped: RouteExportStatusListener = (payload) => {
    try {
      listener(payload);
    } catch (err) {
      logger.warn('subscribeRouteExportEvents listener threw', {
        tenantId,
        exportJobId: payload.exportJobId,
        status: payload.status,
        error: String(err),
      });
    }
  };
  emitter.on(key, wrapped);
  return () => {
    emitter.off(key, wrapped);
  };
}

/**
 * Test-only: drop every subscriber so a unit test that registers a
 * listener doesn't leak across `it()` cases.
 */
export function __resetRouteExportEventsForTesting(): void {
  emitter.removeAllListeners();
}
