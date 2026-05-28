import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../../core/logger';
import {
  calculateLlmCostCents,
  calculateSttCostCents,
  calculateTtsCostCents,
  calculateInfraCostCents,
  type ModelTier,
} from './providerRates';

const logger = createLogger('COST_TRACKING');

export interface ConversationCostRecord {
  id: string;
  tenantId: string;
  callSessionId: string;
  sttCostCents: number;
  llmCostCents: number;
  ttsCostCents: number;
  infraCostCents: number;
  totalCostCents: number;
  modelTier: ModelTier;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  cacheHits: number;
  cacheMisses: number;
  promptTokensSaved: number;
  createdAt: Date;
}

export interface RecordCostParams {
  tenantId: string;
  callSessionId: string;
  durationSeconds: number;
  inputTokens: number;
  outputTokens: number;
  modelUsed: string;
  modelTier: ModelTier;
  ttsCharacters?: number;
  cacheHits?: number;
  cacheMisses?: number;
  promptTokensSaved?: number;
  /**
   * Subset of `inputTokens` that OpenAI reported as cached (prompt
   * caching). Billed at the cached rate from providerRates.ts —
   * typically ~80× cheaper than the regular input rate on Realtime
   * SKUs. Optional for backward compat; defaults to 0.
   */
  cachedInputTokens?: number;
  /**
   * Provenance of `inputTokens` / `outputTokens` / `cachedInputTokens`.
   * 'usage_event' = real counts from OpenAI's response.done.usage
   *                  payload — the canonical case.
   * 'estimate'    = legacy char/4 heuristic from costTracker.addUtterance
   *                  — used only when no usage event was seen for the
   *                  duration of the call (e.g. SDK regression, call
   *                  ended before first response.done).
   * Stored on the row so analytics can filter or surface estimate-vs-
   *                  actual drift during rollout.
   */
  captureSource?: 'estimate' | 'usage_event';
}

export async function recordConversationCost(params: RecordCostParams): Promise<ConversationCostRecord | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, params.tenantId, async () => {});

    const cachedInputTokens = Math.max(0, params.cachedInputTokens ?? 0);
    const captureSource = params.captureSource ?? 'estimate';
    const sttCostCents = calculateSttCostCents(params.durationSeconds);
    const llmCostCents = calculateLlmCostCents(
      params.modelUsed,
      params.inputTokens,
      params.outputTokens,
      cachedInputTokens,
    );
    const ttsCostCents = calculateTtsCostCents(params.ttsCharacters ?? 0);
    const infraCostCents = calculateInfraCostCents(params.durationSeconds);
    const totalCostCents = sttCostCents + llmCostCents + ttsCostCents + infraCostCents;

    const { rows } = await client.query(
      `INSERT INTO conversation_costs (
        id, tenant_id, call_session_id,
        stt_cost_cents, llm_cost_cents, tts_cost_cents, infra_cost_cents, total_cost_cents,
        model_tier, model_used, input_tokens, output_tokens,
        cache_hits, cache_misses, prompt_tokens_saved,
        cached_input_tokens, usage_capture_source
      ) VALUES (
        gen_random_uuid(), $1, $2,
        $3, $4, $5, $6, $7,
        $8::model_tier, $9, $10, $11,
        $12, $13, $14,
        $15, $16
      )
      ON CONFLICT (tenant_id, call_session_id) DO UPDATE SET
        stt_cost_cents = conversation_costs.stt_cost_cents + EXCLUDED.stt_cost_cents,
        llm_cost_cents = conversation_costs.llm_cost_cents + EXCLUDED.llm_cost_cents,
        tts_cost_cents = conversation_costs.tts_cost_cents + EXCLUDED.tts_cost_cents,
        infra_cost_cents = conversation_costs.infra_cost_cents + EXCLUDED.infra_cost_cents,
        total_cost_cents = conversation_costs.total_cost_cents + EXCLUDED.total_cost_cents,
        input_tokens = conversation_costs.input_tokens + EXCLUDED.input_tokens,
        output_tokens = conversation_costs.output_tokens + EXCLUDED.output_tokens,
        cache_hits = conversation_costs.cache_hits + EXCLUDED.cache_hits,
        cache_misses = conversation_costs.cache_misses + EXCLUDED.cache_misses,
        prompt_tokens_saved = conversation_costs.prompt_tokens_saved + EXCLUDED.prompt_tokens_saved,
        cached_input_tokens = conversation_costs.cached_input_tokens + EXCLUDED.cached_input_tokens,
        -- Source-of-truth promotion rule: never DOWNGRADE from
        -- usage_event back to estimate. The first UPSERT carrying real
        -- usage_event counts wins and locks in 'usage_event'; any
        -- subsequent UPSERT that arrives with estimates (e.g. a
        -- recordTwilioCallCost placeholder INSERT that defaults to
        -- 'estimate' via the column DEFAULT) leaves the field alone.
        usage_capture_source = CASE
          WHEN EXCLUDED.usage_capture_source = 'usage_event' THEN 'usage_event'
          ELSE conversation_costs.usage_capture_source
        END,
        -- Overwrite tier + model from the real cost write. This matters
        -- when recordTwilioCallCost INSERTed the row first (it can't know
        -- the tier so it falls back to the table DEFAULT 'standard');
        -- without this clause the placeholder would stick and skew tier
        -- distribution analytics. COALESCE on model_used so an UPSERT
        -- from a different code path that doesn't know the model doesn't
        -- accidentally NULL out a real value.
        model_tier = EXCLUDED.model_tier,
        model_used = COALESCE(EXCLUDED.model_used, conversation_costs.model_used),
        updated_at = NOW()
      RETURNING *`,
      [
        params.tenantId, params.callSessionId,
        sttCostCents, llmCostCents, ttsCostCents, infraCostCents, totalCostCents,
        params.modelTier, params.modelUsed, params.inputTokens, params.outputTokens,
        params.cacheHits ?? 0, params.cacheMisses ?? 0, params.promptTokensSaved ?? 0,
        cachedInputTokens, captureSource,
      ],
    );

    const periodStart = new Date();
    periodStart.setMinutes(0, 0, 0);
    await client.query(
      `INSERT INTO usage_metrics (id, tenant_id, metric_type, period_start, period_end, quantity, total_cost_cents, details)
       VALUES (gen_random_uuid(), $1, 'ai_minutes', $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, metric_type, period_start)
       DO UPDATE SET
         quantity = usage_metrics.quantity + EXCLUDED.quantity,
         total_cost_cents = COALESCE(usage_metrics.total_cost_cents, 0) + COALESCE(EXCLUDED.total_cost_cents, 0),
         updated_at = NOW()`,
      [
        params.tenantId,
        periodStart.toISOString(),
        new Date(periodStart.getTime() + 3600000).toISOString(),
        Math.ceil(params.durationSeconds / 60),
        totalCostCents,
        JSON.stringify({
          callSessionId: params.callSessionId,
          modelTier: params.modelTier,
          modelUsed: params.modelUsed,
          inputTokens: params.inputTokens,
          outputTokens: params.outputTokens,
        }),
      ],
    ).catch((umErr) => {
      logger.warn('Failed to record cost in usage_metrics', { error: String(umErr) });
    });

    await client.query('COMMIT');

    logger.info('Conversation cost recorded', {
      tenantId: params.tenantId,
      callSessionId: params.callSessionId,
      totalCostCents,
      modelTier: params.modelTier,
    });

    const row = rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      callSessionId: row.call_session_id,
      sttCostCents: row.stt_cost_cents,
      llmCostCents: row.llm_cost_cents,
      ttsCostCents: row.tts_cost_cents,
      infraCostCents: row.infra_cost_cents,
      totalCostCents: row.total_cost_cents,
      modelTier: row.model_tier,
      modelUsed: row.model_used,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheHits: row.cache_hits,
      cacheMisses: row.cache_misses,
      promptTokensSaved: row.prompt_tokens_saved,
      createdAt: row.created_at,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to record conversation cost', {
      tenantId: params.tenantId,
      callSessionId: params.callSessionId,
      error: String(err),
    });
    return null;
  } finally {
    client.release();
  }
}

export async function getConversationCost(tenantId: string, callSessionId: string): Promise<ConversationCostRecord | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT * FROM conversation_costs WHERE tenant_id = $1 AND call_session_id = $2`,
      [tenantId, callSessionId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      callSessionId: row.call_session_id,
      sttCostCents: row.stt_cost_cents,
      llmCostCents: row.llm_cost_cents,
      ttsCostCents: row.tts_cost_cents,
      infraCostCents: row.infra_cost_cents,
      totalCostCents: row.total_cost_cents,
      modelTier: row.model_tier,
      modelUsed: row.model_used,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheHits: row.cache_hits,
      cacheMisses: row.cache_misses,
      promptTokensSaved: row.prompt_tokens_saved,
      createdAt: row.created_at,
    };
  } finally {
    client.release();
  }
}

export interface RecordTwilioCallCostParams {
  tenantId: string;
  callSessionId: string;
  /**
   * Raw Twilio `Price` field, signed dollar amount as a string
   * (e.g. "-0.00850"). Twilio convention: negative = "Twilio charged
   * you". We take abs() and convert to cents internally.
   */
  twilioPriceRaw: string;
  /** ISO-4217 currency code from Twilio `PriceUnit`. */
  twilioPriceCurrency: string;
  /** Twilio's carrier-billed seconds from `CallDuration`. */
  twilioBilledSeconds: number;
}

/**
 * Persist the actual Twilio carrier cost for a call. Called from the
 * `/twilio/status` webhook when the `completed` callback arrives with
 * a populated `Price` field.
 *
 * Race: this may arrive BEFORE or AFTER `recordConversationCost`. The
 * UPSERT handles both — when this runs first it INSERTs a placeholder
 * row whose model_tier defaults to 'standard' (the table DEFAULT) and
 * whose other cost-component fields are 0; `recordConversationCost`'s
 * ON CONFLICT then accumulates the real OpenAI cost on top AND
 * overwrites model_tier with the real tier. When this runs second,
 * the existing row's Twilio columns are updated in place and nothing
 * else is touched.
 */
export async function recordTwilioCallCost(
  params: RecordTwilioCallCostParams,
): Promise<{ priceCents: number } | null> {
  const dollars = parseFloat(params.twilioPriceRaw);
  if (!Number.isFinite(dollars)) {
    logger.warn('recordTwilioCallCost: unparseable Twilio Price', {
      tenantId: params.tenantId,
      callSessionId: params.callSessionId,
      rawPrice: params.twilioPriceRaw,
    });
    return null;
  }
  // Twilio convention: Price is negative when Twilio charged us. Take
  // the absolute value before converting to cents.
  // eslint-disable-next-line local/no-dollars-times-100 -- Twilio Price is fractional dollars (e.g. 0.00850); sub-cent precision is preserved by the NUMERIC(10,4) column. Same pattern as platform/billing/usage/UsageRecorder.ts.
  const priceCents = Math.abs(dollars) * 100;
  const currency = (params.twilioPriceCurrency || 'USD').toUpperCase().slice(0, 3);
  const billedSeconds = Math.max(0, Math.floor(params.twilioBilledSeconds || 0));

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, params.tenantId, async () => {});

    await client.query(
      `INSERT INTO conversation_costs (
        id, tenant_id, call_session_id,
        twilio_price_cents, twilio_price_currency, twilio_billed_seconds
      ) VALUES (
        gen_random_uuid(), $1, $2,
        $3, $4, $5
      )
      ON CONFLICT (tenant_id, call_session_id) DO UPDATE SET
        twilio_price_cents = EXCLUDED.twilio_price_cents,
        twilio_price_currency = COALESCE(EXCLUDED.twilio_price_currency, conversation_costs.twilio_price_currency),
        twilio_billed_seconds = EXCLUDED.twilio_billed_seconds,
        updated_at = NOW()`,
      [params.tenantId, params.callSessionId, priceCents, currency, billedSeconds],
    );

    await client.query('COMMIT');

    logger.info('Twilio call cost recorded', {
      tenantId: params.tenantId,
      callSessionId: params.callSessionId,
      priceCents,
      currency,
      billedSeconds,
    });

    return { priceCents };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to record Twilio call cost', {
      tenantId: params.tenantId,
      callSessionId: params.callSessionId,
      error: String(err),
    });
    return null;
  } finally {
    client.release();
  }
}

export async function getConversationCostRunningTotal(tenantId: string, callSessionId: string): Promise<number> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT COALESCE(total_cost_cents, 0) as total FROM conversation_costs WHERE tenant_id = $1 AND call_session_id = $2`,
      [tenantId, callSessionId],
    );
    return rows.length > 0 ? parseInt(rows[0].total, 10) : 0;
  } finally {
    client.release();
  }
}
