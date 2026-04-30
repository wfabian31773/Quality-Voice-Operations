/**
 * Daily background worker that deactivates Stripe billing-portal
 * configurations we minted for the discount-headline badge but no
 * active customer is using anymore. See
 * `./stripe/portalConfigCleanup.ts` for the matching rules and the
 * "deactivate, don't delete" rationale.
 *
 * The scheduler keeps a small in-memory snapshot of the most recent
 * cycle (mirroring `StripePriceVerificationScheduler`) so the Platform
 * Admin console can show "the cleanup ran today" / "N configurations
 * deactivated" without persisting another audit table. A manual run
 * endpoint is exposed alongside the snapshot for ad-hoc invocation.
 */

import { createLogger } from '../core/logger';
import {
  runDiscountPortalConfigCleanup,
  type PortalConfigCleanupResult,
} from './stripe/portalConfigCleanup';

const logger = createLogger('PORTAL_CONFIG_CLEANUP_SCHED');

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 minutes after boot
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function parseIntervalEnv(): number {
  const raw = process.env.PORTAL_CONFIG_CLEANUP_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS || parsed > MAX_INTERVAL_MS) {
    logger.warn('Ignoring invalid PORTAL_CONFIG_CLEANUP_INTERVAL_MS — falling back to default', {
      raw,
      default: DEFAULT_INTERVAL_MS,
    });
    return DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

export interface PortalConfigCleanupSnapshot {
  ranAt: string;
  source: 'scheduled' | 'manual';
  status: 'success' | 'failure';
  result: PortalConfigCleanupResult | null;
  errorMessage: string | null;
}

let latestSnapshot: PortalConfigCleanupSnapshot | null = null;

export function getLatestPortalConfigCleanupSnapshot(): PortalConfigCleanupSnapshot | null {
  return latestSnapshot;
}

export function __resetPortalConfigCleanupSnapshotForTests(): void {
  latestSnapshot = null;
}

export interface RunPortalConfigCleanupOptions {
  source?: 'scheduled' | 'manual';
}

export async function runPortalConfigCleanupCycle(
  options: RunPortalConfigCleanupOptions = {},
): Promise<PortalConfigCleanupSnapshot> {
  const source = options.source ?? 'scheduled';
  const ranAt = new Date().toISOString();
  try {
    const result = await runDiscountPortalConfigCleanup();
    const snapshot: PortalConfigCleanupSnapshot = {
      ranAt,
      source,
      status: 'success',
      result,
      errorMessage: null,
    };
    latestSnapshot = snapshot;
    return snapshot;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('Discount portal configuration cleanup cycle failed', {
      source,
      error: errorMessage,
    });
    const snapshot: PortalConfigCleanupSnapshot = {
      ranAt,
      source,
      status: 'failure',
      result: null,
      errorMessage,
    };
    latestSnapshot = snapshot;
    return snapshot;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startPortalConfigCleanupScheduler(
  intervalMs: number = parseIntervalEnv(),
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runPortalConfigCleanupCycle().catch((err) => {
      logger.error('Initial portal-config cleanup cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runPortalConfigCleanupCycle().catch((err) => {
      logger.error('Portal-config cleanup cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);

  logger.info('Portal-config cleanup scheduler started', { intervalMs });
}

export function stopPortalConfigCleanupScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Portal-config cleanup scheduler stopped');
  }
}

export const PORTAL_CONFIG_CLEANUP_DEFAULTS = {
  intervalMs: DEFAULT_INTERVAL_MS,
  initialDelayMs: INITIAL_DELAY_MS,
} as const;
