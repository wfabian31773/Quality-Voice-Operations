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
}

export async function recordConversationCost(params: RecordCostParams): Promise<ConversationCostRecord | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, params.tenantId, async () => {});

    const sttCostCents = calculateSttCostCents(params.durationSeconds);
    const llmCostCents = calculateLlmCostCents(params.modelUsed, params.inputTokens, params.outputTokens);
    const ttsCostCents = calculateTtsCostCents(params.ttsCharacters ?? 0);
    const infraCostCents = calculateInfraCostCents(params.durationSeconds);
    const totalCostCents = sttCostCents + llmCostCents + ttsCostCents + infraCostCents;

    const { rows } = await client.query(
      `INSERT INTO conversation_costs (
        id, tenant_id, call_session_id,
        stt_cost_cents, llm_cost_cents, tts_cost_cents, infra_cost_cents, total_cost_cents,
        model_tier, model_used, input_tokens, output_tokens,
        cache_hits, cache_misses, prompt_tokens_saved
      ) VALUES (
        gen_random_uuid(), $1, $2,
        $3, $4, $5, $6, $7,
        $8::model_tier, $9, $10, $11,
        $12, $13, $14
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
        updated_at = NOW()
      RETURNING *`,
      [
        params.tenantId, params.callSessionId,
        sttCostCents, llmCostCents, ttsCostCents, infraCostCents, totalCostCents,
        params.modelTier, params.modelUsed, params.inputTokens, params.outputTokens,
        params.cacheHits ?? 0, params.cacheMisses ?? 0, params.promptTokensSaved ?? 0,
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
