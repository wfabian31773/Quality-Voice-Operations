import { createLogger } from '../../core/logger';
import {
  clearCrmCallerIdentity,
  listCrmCallerIdentitiesDueForRevalidation,
  markCrmCallerIdentityValidated,
  type CrmCallerIdentityDueRow,
  type StaleCrmIds,
} from './crmCallerIdentity';
import { listEnabledConnectorConfigs } from './db';
import { validateHubSpotCachedIdentity } from './adapters/hubspot';
import { validateSalesforceCachedIdentity } from './adapters/salesforce';
import { validatePipedriveCachedIdentity } from './adapters/pipedrive';
import { validateZohoCachedIdentity } from './adapters/zoho';
import type { ConnectorConfig } from './types';
import type { TenantId } from '../../core/types';

const logger = createLogger('CRM_CALLER_IDENTITY_REVALIDATION');

/**
 * Sweep cadence: revalidate cached CRM IDs once per hour. Combined with
 * the staleness threshold below this means each cached row gets re-probed
 * at most once every `STALENESS_THRESHOLD_MS` window — even if the sweep
 * itself runs more often, rows touched by a recent dispatch (which calls
 * `markCrmCallerIdentityValidated` via the upsert path's `updated_at`
 * cousin) won't be eligible.
 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;

/**
 * A cached CRM identity row is eligible for re-validation when it hasn't
 * been validated against the upstream CRM in this long. Defaults to 6h:
 * long enough to absorb routine event dispatch (which keeps `updated_at`
 * fresh and acts as an implicit validation), short enough that a deleted
 * upstream record gets evicted within a typical business day.
 */
const STALENESS_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/**
 * Per-cycle batch size cap. The scheduler scans cross-tenant — a too-large
 * batch could blow our latency budget against a single rate-limited CRM
 * API. 50/hour = ~1200/day per provider, which comfortably covers the
 * caller-identity row volume we see in practice.
 */
const DEFAULT_BATCH_LIMIT = 50;

const SUPPORTED_PROVIDERS = ['hubspot', 'salesforce', 'pipedrive', 'zoho'] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

type ValidateFn = (
  tenantId: TenantId,
  config: ConnectorConfig,
  identity: {
    contactId?: string;
    accountId?: string;
    opportunityId?: string;
    extras?: Record<string, string>;
  },
) => Promise<{ stale: StaleCrmIds }>;

const VALIDATORS: Record<SupportedProvider, ValidateFn> = {
  hubspot: validateHubSpotCachedIdentity,
  salesforce: validateSalesforceCachedIdentity,
  pipedrive: validatePipedriveCachedIdentity,
  zoho: validateZohoCachedIdentity,
};

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let cycleInFlight = false;

export interface CrmCallerIdentityRevalidationCycleResult {
  scanned: number;
  validated: number;
  staleScrubbed: number;
  skippedNoConfig: number;
  failed: number;
}

export interface CrmCallerIdentityRevalidationCycleOptions {
  stalenessThresholdMs?: number;
  batchLimit?: number;
}

/**
 * One revalidation pass: list CRM caller identity rows that haven't been
 * validated within `stalenessThresholdMs`, group them by tenant+provider,
 * resolve each tenant's enabled CRM connector configs once, and probe
 * each row against the upstream CRM. Stale IDs are scrubbed from the
 * cache via `clearCrmCallerIdentity`; rows that fully resolve get their
 * `last_validated_at` bumped via `markCrmCallerIdentityValidated`.
 *
 * Network errors / non-stale upstream failures (auth, rate limit) are
 * NOT treated as stale — the next cycle will re-probe. Rows whose
 * provider has no enabled connector for the tenant are counted in
 * `skippedNoConfig` and have their validation timestamp bumped so we
 * don't retry forever (the integration was likely disabled / removed).
 */
export async function runCrmCallerIdentityRevalidationCycle(
  options: CrmCallerIdentityRevalidationCycleOptions = {},
): Promise<CrmCallerIdentityRevalidationCycleResult> {
  const stalenessThresholdMs = options.stalenessThresholdMs ?? STALENESS_THRESHOLD_MS;
  const batchLimit = Math.max(1, options.batchLimit ?? DEFAULT_BATCH_LIMIT);

  const result: CrmCallerIdentityRevalidationCycleResult = {
    scanned: 0,
    validated: 0,
    staleScrubbed: 0,
    skippedNoConfig: 0,
    failed: 0,
  };

  const due = await listCrmCallerIdentitiesDueForRevalidation(
    [...SUPPORTED_PROVIDERS],
    stalenessThresholdMs,
    batchLimit,
  );
  result.scanned = due.length;
  if (due.length === 0) return result;

  // Resolve enabled CRM configs per tenant exactly once per cycle, even
  // when several rows for the same tenant share a provider. The decrypt
  // fan-out inside listEnabledConnectorConfigs is the most expensive
  // step, so we cache the first lookup and reuse it for the rest of the
  // cycle. Failed loads are cached as an error sentinel so the same
  // transient infra error doesn't get re-thrown N times in one cycle —
  // but it DOES still propagate per-row so the row counts as `failed`
  // (not `skippedNoConfig`) and isn't prematurely marked validated.
  type ConfigCacheEntry =
    | { kind: 'ok'; configs: Map<string, ConnectorConfig> }
    | { kind: 'error'; message: string };
  const configCache = new Map<string, ConfigCacheEntry>();
  const loadConfigsForTenant = async (tenantId: string): Promise<Map<string, ConnectorConfig>> => {
    const cached = configCache.get(tenantId);
    if (cached) {
      if (cached.kind === 'error') throw new Error(cached.message);
      return cached.configs;
    }
    try {
      const configs = await listEnabledConnectorConfigs(tenantId as TenantId, ['crm']);
      const map = new Map<string, ConnectorConfig>();
      for (const cfg of configs) {
        if (!map.has(cfg.provider)) map.set(cfg.provider, cfg);
      }
      configCache.set(tenantId, { kind: 'ok', configs: map });
      return map;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Failed to load CRM configs for tenant during revalidation', {
        tenantId, error: message,
      });
      configCache.set(tenantId, { kind: 'error', message });
      throw err;
    }
  };

  for (const row of due) {
    try {
      await processRow(row, loadConfigsForTenant, result);
    } catch (err) {
      result.failed += 1;
      logger.warn('CRM identity revalidation row failed', {
        tenantId: row.tenantId,
        provider: row.provider,
        phone: row.phone,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.scanned > 0) {
    logger.info('CRM caller identity revalidation cycle complete', { ...result });
  }
  return result;
}

async function processRow(
  row: CrmCallerIdentityDueRow,
  loadConfigsForTenant: (tenantId: string) => Promise<Map<string, ConnectorConfig>>,
  result: CrmCallerIdentityRevalidationCycleResult,
): Promise<void> {
  const validator = VALIDATORS[row.provider as SupportedProvider];
  if (!validator) return;

  const configs = await loadConfigsForTenant(row.tenantId);
  const config = configs.get(row.provider);
  if (!config) {
    // Bump timestamp so we don't churn through the same orphaned row every
    // cycle — the integration was disabled / removed and there's no way to
    // probe upstream until it's re-enabled.
    result.skippedNoConfig += 1;
    await markCrmCallerIdentityValidated(row.tenantId as TenantId, row.provider, row.phone);
    return;
  }

  const { stale } = await validator(row.tenantId as TenantId, config, row.identity);
  const staleKeys = Object.keys(stale).filter(
    (k) => typeof (stale as Record<string, unknown>)[k] === 'string'
      && (stale as Record<string, string>)[k].length > 0,
  );

  if (staleKeys.length > 0) {
    await clearCrmCallerIdentity(row.tenantId as TenantId, row.provider, row.phone, stale);
    result.staleScrubbed += 1;
    logger.info('CRM caller identity row scrubbed by revalidation', {
      tenantId: row.tenantId,
      provider: row.provider,
      phone: row.phone,
      staleKeys,
    });
    // Fall through to mark validated as well — the surviving slots (if
    // any) were just probed against upstream, and clearing left either
    // a partially-cleaned row or no row at all (no-op for the latter).
  }

  result.validated += 1;
  await markCrmCallerIdentityValidated(row.tenantId as TenantId, row.provider, row.phone);
}

async function safeRunCycle(): Promise<void> {
  if (cycleInFlight) {
    logger.warn('Skipping CRM caller identity revalidation cycle — previous cycle still running');
    return;
  }
  cycleInFlight = true;
  try {
    await runCrmCallerIdentityRevalidationCycle();
  } catch (err) {
    logger.error('CRM caller identity revalidation cycle threw', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    cycleInFlight = false;
  }
}

export function startCrmCallerIdentityRevalidationScheduler(
  intervalMs: number = CHECK_INTERVAL_MS,
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    void safeRunCycle();
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    void safeRunCycle();
  }, intervalMs);

  logger.info('CRM caller identity revalidation scheduler started', {
    intervalMs,
    stalenessThresholdMs: STALENESS_THRESHOLD_MS,
    batchLimit: DEFAULT_BATCH_LIMIT,
    providers: [...SUPPORTED_PROVIDERS],
  });
}

export function stopCrmCallerIdentityRevalidationScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('CRM caller identity revalidation scheduler stopped');
  }
}

export const __test = {
  SUPPORTED_PROVIDERS,
  STALENESS_THRESHOLD_MS,
  DEFAULT_BATCH_LIMIT,
  CHECK_INTERVAL_MS,
};
