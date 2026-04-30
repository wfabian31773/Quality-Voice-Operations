import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../../core/logger';
import { getCachedTenantEffectiveRate } from '../stripe/effectiveRateCache';

const logger = createLogger('USAGE_RECORDER');

function getHourBucket(now: Date = new Date()): { periodStart: Date; periodEnd: Date } {
  const periodStart = new Date(now);
  periodStart.setUTCMinutes(0, 0, 0);
  const periodEnd = new Date(periodStart.getTime() + 60 * 60 * 1000);
  return { periodStart, periodEnd };
}

export interface CallCostEstimate {
  totalCostCents: number;
  twilioCostCents: number;
  aiCostCents: number;
}

// Read env defaults at call time so a test that mutates them after
// module import is still honoured (mirrors the same approach
// `envDefaultSmsRateCents` uses below).
function envDefaultTwilioRateCents(): number {
  const raw = parseInt(process.env.TWILIO_COST_PER_MINUTE_CENTS ?? '2', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
}

function envDefaultAiRateCents(): number {
  const raw = parseInt(process.env.AI_COST_PER_MINUTE_CENTS ?? '6', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 6;
}

export function estimateCallCost(durationSeconds: number): CallCostEstimate {
  const minutes = Math.ceil(durationSeconds / 60);
  const twilioCostCents = minutes * envDefaultTwilioRateCents();
  const aiCostCents = minutes * envDefaultAiRateCents();
  return {
    totalCostCents: twilioCostCents + aiCostCents,
    twilioCostCents,
    aiCostCents,
  };
}

// Per-call cost using the tenant's live Stripe overage rates for both
// the AI portion AND the Twilio (carrier) portion. High-volume voice
// tenants negotiate their own per-minute Twilio rate which is shipped
// as its own metered Stripe price line — the cached resolver dedupes
// Stripe round-trips, and any failure degrades to the env default so
// call teardown never blocks on Stripe. The aggregate (not the
// per-minute rate) is rounded so sub-cent Stripe pricing matches the
// invoice — same rule as `recordCallUsage` so the rolled-up usage row
// and the per-call drilldown agree to the cent.
export async function estimateCallCostWithLiveRate(
  tenantId: string,
  durationSeconds: number,
): Promise<CallCostEstimate> {
  const minutes = Math.ceil(durationSeconds / 60);
  const [aiRateCentsPerMin, twilioRateCentsPerMin] = minutes > 0
    ? await Promise.all([
        resolveAiRateCentsPerMinute(tenantId),
        resolveTwilioRateCentsPerMinute(tenantId),
      ])
    : [0, 0];
  const aiCostCents = Math.round(aiRateCentsPerMin * minutes);
  const twilioCostCents = Math.round(twilioRateCentsPerMin * minutes);
  return {
    totalCostCents: twilioCostCents + aiCostCents,
    twilioCostCents,
    aiCostCents,
  };
}

// Resolve the per-minute AI rate from the tenant's live Stripe
// subscription as cents-per-minute (may be fractional to preserve
// sub-cent Stripe precision). Falls back to the env default if the
// resolver throws so call teardown never blocks on Stripe.
async function resolveAiRateCentsPerMinute(tenantId: string): Promise<number> {
  try {
    const rate = await getCachedTenantEffectiveRate(tenantId);
    // eslint-disable-next-line local/no-dollars-times-100 -- dollars→cents conversion; sub-cent precision must survive into the aggregate `total_cost_cents` rounding below.
    const centsPerMin = rate.overageRatePerMinute * 100;
    if (Number.isFinite(centsPerMin) && centsPerMin >= 0) return centsPerMin;
  } catch (err) {
    logger.warn('Falling back to env AI rate for usage cost', {
      tenantId,
      error: String(err),
    });
  }
  return envDefaultAiRateCents();
}

// Resolve the per-minute Twilio (carrier) rate from the tenant's live
// Stripe subscription as cents-per-minute (may be fractional to
// preserve sub-cent Stripe precision). High-volume voice tenants
// typically negotiate their own carrier rate, which lives on Stripe
// as a tagged metered price line — see `classifyPrice`'s
// `isTwilioMinutes` branch in `effectiveRate.ts`. Falls back to the
// env default if the resolver throws or the rate is missing — call
// teardown must never block on Stripe just to insert a usage row.
async function resolveTwilioRateCentsPerMinute(tenantId: string): Promise<number> {
  try {
    const rate = await getCachedTenantEffectiveRate(tenantId);
    if (rate.twilioRatePerMinute != null) {
      // eslint-disable-next-line local/no-dollars-times-100 -- dollars→cents conversion; sub-cent precision must survive into the aggregate `total_cost_cents` rounding below.
      const centsPerMin = rate.twilioRatePerMinute * 100;
      if (Number.isFinite(centsPerMin) && centsPerMin >= 0) return centsPerMin;
    }
  } catch (err) {
    logger.warn('Falling back to env Twilio rate for usage cost', {
      tenantId,
      error: String(err),
    });
  }
  return envDefaultTwilioRateCents();
}

function envDefaultSmsRateCents(): number {
  const raw = parseInt(process.env.SMS_COST_PER_MESSAGE_CENTS ?? '1', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
}

// Resolve the per-message SMS rate from the tenant's live Stripe
// subscription as cents-per-message (may be fractional to preserve
// sub-cent Stripe precision). Falls back to the env default if the
// resolver throws or the rate is missing — `recordSmsUsage` must never
// block on Stripe just to insert a usage row.
async function resolveSmsRateCentsPerMessage(tenantId: string): Promise<number> {
  try {
    const rate = await getCachedTenantEffectiveRate(tenantId);
    if (rate.smsRatePerMessage != null) {
      // eslint-disable-next-line local/no-dollars-times-100 -- dollars→cents conversion; sub-cent precision must survive into the aggregate `total_cost_cents` rounding below.
      const centsPerMessage = rate.smsRatePerMessage * 100;
      if (Number.isFinite(centsPerMessage) && centsPerMessage >= 0) {
        return centsPerMessage;
      }
    }
  } catch (err) {
    logger.warn('Falling back to env SMS rate for usage cost', {
      tenantId,
      error: String(err),
    });
  }
  return envDefaultSmsRateCents();
}

export async function recordCallUsage(
  tenantId: string,
  direction: 'inbound' | 'outbound',
  durationSeconds: number,
  aiMinutes?: number,
): Promise<void> {
  const { periodStart, periodEnd } = getHourBucket();
  const metricType = direction === 'inbound' ? 'calls_inbound' : 'calls_outbound';
  const callMinutes = Math.ceil(durationSeconds / 60);
  const estimatedAiMinutes = aiMinutes ?? callMinutes;

  // Resolve both the Twilio (carrier) AND the AI per-minute rates
  // before opening the DB transaction so an uncached Stripe round-trip
  // never holds a Postgres connection open. Both share the same
  // `getCachedTenantEffectiveRate` cache so this is at most one
  // Stripe round-trip per cache TTL — see `effectiveRateCache.ts`.
  const [twilioRateCentsPerMin, aiRateCentsPerMin] = await Promise.all([
    callMinutes > 0
      ? resolveTwilioRateCentsPerMinute(tenantId)
      : Promise.resolve(0),
    estimatedAiMinutes > 0
      ? resolveAiRateCentsPerMinute(tenantId)
      : Promise.resolve(0),
  ]);

  // Round the aggregate (not the per-minute rate) so sub-cent Stripe
  // pricing matches what Stripe will actually invoice — same rule as
  // the AI-minutes row below.
  const callCostCents = Math.round(twilioRateCentsPerMin * callMinutes);

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    await client.query(
      `INSERT INTO usage_metrics (id, tenant_id, metric_type, period_start, period_end, quantity, unit_cost_cents, total_cost_cents)
       VALUES (gen_random_uuid(), $1, $2::usage_metric_type, $3, $4, 1, $5, $5)
       ON CONFLICT (tenant_id, metric_type, period_start)
       DO UPDATE SET
         quantity = usage_metrics.quantity + 1,
         total_cost_cents = COALESCE(usage_metrics.total_cost_cents, 0) + EXCLUDED.total_cost_cents,
         updated_at = NOW()`,
      [tenantId, metricType, periodStart.toISOString(), periodEnd.toISOString(), callCostCents],
    );

    if (estimatedAiMinutes > 0) {
      // Round the aggregate (not the per-minute rate) so sub-cent Stripe
      // pricing matches what Stripe will actually invoice.
      const aiTotalCents = Math.round(aiRateCentsPerMin * estimatedAiMinutes);
      const aiUnitCents = Math.round(aiRateCentsPerMin);
      await client.query(
        `INSERT INTO usage_metrics (id, tenant_id, metric_type, period_start, period_end, quantity, unit_cost_cents, total_cost_cents)
         VALUES (gen_random_uuid(), $1, 'ai_minutes'::usage_metric_type, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, metric_type, period_start)
         DO UPDATE SET
           quantity = usage_metrics.quantity + EXCLUDED.quantity,
           total_cost_cents = COALESCE(usage_metrics.total_cost_cents, 0) + EXCLUDED.total_cost_cents,
           updated_at = NOW()`,
        [tenantId, periodStart.toISOString(), periodEnd.toISOString(),
         estimatedAiMinutes, aiUnitCents, aiTotalCents],
      );
    }

    await client.query('COMMIT');

    logger.info('Call usage recorded', {
      tenantId,
      direction,
      durationSeconds,
      aiMinutes: estimatedAiMinutes,
      aiRateCentsPerMin,
      twilioRateCentsPerMin,
      metricType,
      hourBucket: periodStart.toISOString(),
    });

    import('../../../platform/activation/ActivationService')
      .then(({ recordActivationEvent }) => recordActivationEvent(tenantId, 'tenant_first_call', { direction }))
      .catch(() => {});
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to record call usage', { tenantId, direction, error: String(err) });
  } finally {
    client.release();
  }
}

export async function recordToolExecution(
  tenantId: string,
  count: number = 1,
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { periodStart, periodEnd } = getHourBucket();

    await client.query(
      `INSERT INTO usage_metrics (id, tenant_id, metric_type, period_start, period_end, quantity, unit_cost_cents, total_cost_cents)
       VALUES (gen_random_uuid(), $1, 'tool_executions'::usage_metric_type, $2, $3, $4, 0, 0)
       ON CONFLICT (tenant_id, metric_type, period_start)
       DO UPDATE SET
         quantity = usage_metrics.quantity + EXCLUDED.quantity,
         updated_at = NOW()`,
      [tenantId, periodStart.toISOString(), periodEnd.toISOString(), count],
    );

    await client.query('COMMIT');
    logger.info('Tool execution recorded', { tenantId, count });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to record tool execution', { tenantId, error: String(err) });
  } finally {
    client.release();
  }
}

export async function recordApiRequest(
  tenantId: string,
  count: number = 1,
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { periodStart, periodEnd } = getHourBucket();

    await client.query(
      `INSERT INTO usage_metrics (id, tenant_id, metric_type, period_start, period_end, quantity, unit_cost_cents, total_cost_cents)
       VALUES (gen_random_uuid(), $1, 'api_requests'::usage_metric_type, $2, $3, $4, 0, 0)
       ON CONFLICT (tenant_id, metric_type, period_start)
       DO UPDATE SET
         quantity = usage_metrics.quantity + EXCLUDED.quantity,
         updated_at = NOW()`,
      [tenantId, periodStart.toISOString(), periodEnd.toISOString(), count],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to record API request', { tenantId, error: String(err) });
  } finally {
    client.release();
  }
}

export async function recordSmsUsage(
  tenantId: string,
  count: number = 1,
): Promise<void> {
  const { periodStart, periodEnd } = getHourBucket();

  // Resolve the SMS rate before opening the DB transaction so an uncached
  // Stripe round-trip never holds a Postgres connection open. The cache
  // (`getCachedTenantEffectiveRate`) prevents one Stripe call per SMS for
  // SMS-heavy tenants — see `effectiveRateCache.ts`.
  const smsRateCentsPerMessage = count > 0
    ? await resolveSmsRateCentsPerMessage(tenantId)
    : 0;

  // Round the aggregate (not the per-message rate) so sub-cent Stripe
  // pricing matches what Stripe will actually invoice.
  const totalCostCents = Math.round(smsRateCentsPerMessage * count);
  const unitCostCents = Math.round(smsRateCentsPerMessage);

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    await client.query(
      `INSERT INTO usage_metrics (id, tenant_id, metric_type, period_start, period_end, quantity, unit_cost_cents, total_cost_cents)
       VALUES (gen_random_uuid(), $1, 'sms_sent'::usage_metric_type, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, metric_type, period_start)
       DO UPDATE SET
         quantity = usage_metrics.quantity + EXCLUDED.quantity,
         total_cost_cents = COALESCE(usage_metrics.total_cost_cents, 0) + EXCLUDED.total_cost_cents,
         updated_at = NOW()`,
      [tenantId, periodStart.toISOString(), periodEnd.toISOString(),
       count, unitCostCents, totalCostCents],
    );

    await client.query('COMMIT');

    logger.info('SMS usage recorded', {
      tenantId,
      count,
      smsRateCentsPerMessage,
      hourBucket: periodStart.toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to record SMS usage', { tenantId, error: String(err) });
  } finally {
    client.release();
  }
}
