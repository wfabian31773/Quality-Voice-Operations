import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';
import { redactPHI } from '../core/phi/redact';

const logger = createLogger('GIN_INSIGHT_ENGINE');

export interface GlobalPattern {
  id: string;
  patternType: string;
  title: string;
  description: string;
  industryVertical: string | null;
  confidenceScore: number;
  sampleSize: number;
  impactEstimate: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface GlobalPromptPattern {
  id: string;
  promptCategory: string;
  industryVertical: string | null;
  patternDescription: string;
  examplePrompt: string | null;
  effectivenessScore: number;
  sampleSize: number;
  conversionRateAvg: number | null;
  avgCallDurationSeconds: number | null;
  isActive: boolean;
  createdAt: string;
}

const PATTERN_DETECTION_PROMPT = `You are a platform intelligence analyst for a multi-tenant voice AI platform. Analyze the aggregated, anonymized operational data below (from multiple tenants) and detect high-performing patterns.

For each pattern, provide:
1. A clear pattern title
2. Detailed description of the pattern
3. Pattern type: one of (call_flow, scheduling, objection_handling, lead_qualification, booking_optimization, follow_up_timing, prompt_structure)
4. Confidence score (0.0-1.0) based on sample size and consistency
5. Impact estimate (human-readable)
6. Industry vertical if applicable (hvac, medical, dental, property_management, home_services, legal, general)

Return ONLY valid JSON:
{
  "patterns": [
    {
      "pattern_type": "<type>",
      "title": "<title>",
      "description": "<description>",
      "industry_vertical": "<vertical or null>",
      "confidence_score": <0.0-1.0>,
      "impact_estimate": "<human-readable impact>"
    }
  ],
  "prompt_patterns": [
    {
      "prompt_category": "<category>",
      "industry_vertical": "<vertical or null>",
      "pattern_description": "<what makes this prompt pattern effective>",
      "example_prompt": "<anonymized example prompt structure>",
      "effectiveness_score": <0.0-1.0>
    }
  ]
}`;

export async function runGlobalPatternDetection(aggregationRunId?: string): Promise<{ patternsDetected: number; promptPatternsDetected: number }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — skipping global pattern detection');
    return { patternsDetected: 0, promptPatternsDetected: 0 };
  }

  const pool = getPlatformPool();

  try {
    const { rows: benchmarks } = await pool.query(
      `SELECT industry_vertical, metric_name, metric_value, sample_size, percentile_25, percentile_50, percentile_75
       FROM industry_benchmarks
       WHERE period_end >= (CURRENT_DATE - INTERVAL '60 days')
       ORDER BY industry_vertical, metric_name`,
    );

    const { rows: workflowMetrics } = await pool.query(
      `SELECT industry_vertical, workflow_type, metric_name, metric_value, sample_size, metadata
       FROM workflow_performance_metrics
       WHERE period_end >= (CURRENT_DATE - INTERVAL '60 days')
       ORDER BY industry_vertical, workflow_type`,
    );

    if (benchmarks.length === 0 && workflowMetrics.length === 0) {
      logger.info('No aggregated data available for pattern detection');
      return { patternsDetected: 0, promptPatternsDetected: 0 };
    }

    const dataContext = JSON.stringify({
      benchmarks: benchmarks.map(b => ({
        industry: b.industry_vertical,
        metric: b.metric_name,
        avg: parseFloat(String(b.metric_value)),
        sampleSize: b.sample_size,
        p25: b.percentile_25 ? parseFloat(String(b.percentile_25)) : null,
        p50: b.percentile_50 ? parseFloat(String(b.percentile_50)) : null,
        p75: b.percentile_75 ? parseFloat(String(b.percentile_75)) : null,
      })),
      workflowMetrics: workflowMetrics.map(w => {
        const meta = (typeof w.metadata === 'object' && w.metadata) ? w.metadata as Record<string, unknown> : {};
        return {
          industry: w.industry_vertical,
          workflowType: w.workflow_type,
          metric: w.metric_name,
          value: parseFloat(String(w.metric_value)),
          sampleSize: w.sample_size,
          commonQuestions: (meta.commonQuestions as string[]) || [],
          promptPatterns: (meta.promptPatterns as string[]) || [],
          workflowSequences: (meta.workflowSequences as string[]) || [],
        };
      }),
    });

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: PATTERN_DETECTION_PROMPT },
          { role: 'user', content: `Analyze this aggregated platform data and detect patterns:\n\n${redactPHI(dataContext)}` },
        ],
        temperature: 0.3,
        max_tokens: 3000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.error('OpenAI API error during global pattern detection', { status: response.status });
      return { patternsDetected: 0, promptPatternsDetected: 0 };
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      logger.error('Empty response from OpenAI global pattern detection');
      return { patternsDetected: 0, promptPatternsDetected: 0 };
    }

    let parsed: { patterns?: Array<Record<string, unknown>>; prompt_patterns?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(content);
    } catch {
      logger.error('Failed to parse global pattern detection JSON');
      return { patternsDetected: 0, promptPatternsDetected: 0 };
    }

    let patternsDetected = 0;
    const patterns = parsed.patterns || [];
    for (const p of patterns.slice(0, 20)) {
      await pool.query(
        `INSERT INTO global_insight_patterns (pattern_type, title, description, industry_vertical, confidence_score, sample_size, impact_estimate, aggregation_run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          String(p.pattern_type || 'general'),
          String(p.title || 'Pattern'),
          String(p.description || ''),
          p.industry_vertical || null,
          typeof p.confidence_score === 'number' ? Math.min(1, Math.max(0, p.confidence_score)) : 0.5,
          typeof p.sample_size === 'number' ? p.sample_size : 0,
          p.impact_estimate ? String(p.impact_estimate) : null,
          aggregationRunId || null,
        ],
      );
      patternsDetected++;
    }

    let promptPatternsDetected = 0;
    const promptPatterns = parsed.prompt_patterns || [];
    for (const pp of promptPatterns.slice(0, 20)) {
      await pool.query(
        `INSERT INTO global_prompt_patterns (prompt_category, industry_vertical, pattern_description, example_prompt, effectiveness_score, aggregation_run_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          String(pp.prompt_category || 'general'),
          pp.industry_vertical || null,
          String(pp.pattern_description || ''),
          pp.example_prompt ? String(pp.example_prompt) : null,
          typeof pp.effectiveness_score === 'number' ? Math.min(1, Math.max(0, pp.effectiveness_score)) : 0.5,
          aggregationRunId || null,
        ],
      );
      promptPatternsDetected++;
    }

    if (aggregationRunId) {
      await pool.query(
        `UPDATE gin_aggregation_runs SET patterns_detected = $2 WHERE id = $1`,
        [aggregationRunId, patternsDetected + promptPatternsDetected],
      );
    }

    logger.info('Global pattern detection completed', { patternsDetected, promptPatternsDetected });
    return { patternsDetected, promptPatternsDetected };
  } catch (err) {
    logger.error('Global pattern detection failed', { error: String(err) });
    return { patternsDetected: 0, promptPatternsDetected: 0 };
  }
}

export async function getGlobalPatterns(options: {
  patternType?: string;
  industry?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ patterns: GlobalPattern[]; total: number }> {
  const pool = getPlatformPool();
  const conditions = ['is_active = TRUE'];
  const params: unknown[] = [];
  let idx = 1;

  if (options.patternType) {
    conditions.push(`pattern_type = $${idx}`);
    params.push(options.patternType);
    idx++;
  }
  if (options.industry) {
    conditions.push(`(industry_vertical = $${idx} OR industry_vertical IS NULL)`);
    params.push(options.industry);
    idx++;
  }

  const where = conditions.join(' AND ');
  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM global_insight_patterns WHERE ${where}`,
    params,
  );

  const { rows } = await pool.query(
    `SELECT * FROM global_insight_patterns WHERE ${where} ORDER BY confidence_score DESC, created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset],
  );

  return {
    patterns: rows.map(mapPatternRow),
    total: countRows[0]?.total ?? 0,
  };
}

export async function getGlobalPromptPatterns(options: {
  category?: string;
  industry?: string;
  limit?: number;
} = {}): Promise<GlobalPromptPattern[]> {
  const pool = getPlatformPool();
  const conditions = ['is_active = TRUE'];
  const params: unknown[] = [];
  let idx = 1;

  if (options.category) {
    conditions.push(`prompt_category = $${idx}`);
    params.push(options.category);
    idx++;
  }
  if (options.industry) {
    conditions.push(`(industry_vertical = $${idx} OR industry_vertical IS NULL)`);
    params.push(options.industry);
    idx++;
  }

  const where = conditions.join(' AND ');
  const limit = Math.min(options.limit ?? 50, 100);

  const { rows } = await pool.query(
    `SELECT * FROM global_prompt_patterns WHERE ${where} ORDER BY effectiveness_score DESC, created_at DESC LIMIT $${idx}`,
    [...params, limit],
  );

  return rows.map(mapPromptPatternRow);
}

function mapPatternRow(row: Record<string, unknown>): GlobalPattern {
  return {
    id: row.id as string,
    patternType: row.pattern_type as string,
    title: row.title as string,
    description: row.description as string,
    industryVertical: (row.industry_vertical as string) || null,
    confidenceScore: parseFloat(String(row.confidence_score ?? 0)),
    sampleSize: (row.sample_size as number) ?? 0,
    impactEstimate: (row.impact_estimate as string) || null,
    isActive: row.is_active as boolean,
    createdAt: String(row.created_at),
  };
}

function mapPromptPatternRow(row: Record<string, unknown>): GlobalPromptPattern {
  return {
    id: row.id as string,
    promptCategory: row.prompt_category as string,
    industryVertical: (row.industry_vertical as string) || null,
    patternDescription: row.pattern_description as string,
    examplePrompt: (row.example_prompt as string) || null,
    effectivenessScore: parseFloat(String(row.effectiveness_score ?? 0)),
    sampleSize: (row.sample_size as number) ?? 0,
    conversionRateAvg: row.conversion_rate_avg ? parseFloat(String(row.conversion_rate_avg)) : null,
    avgCallDurationSeconds: row.avg_call_duration_seconds ? parseFloat(String(row.avg_call_duration_seconds)) : null,
    isActive: row.is_active as boolean,
    createdAt: String(row.created_at),
  };
}
