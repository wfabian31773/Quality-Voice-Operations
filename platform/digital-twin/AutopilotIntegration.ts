import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import { runSimulation } from './OperationalSimulator';
import type { SimulationResult } from './OperationalSimulator';

const logger = createLogger('DIGITAL_TWIN_AUTOPILOT');

export interface AutopilotValidationResult {
  recommendationId: string;
  validated: boolean;
  simulationRunId: string;
  resultId: string;
  improvementDetected: boolean;
  metrics: {
    baselineConversionRate: number;
    simulatedConversionRate: number;
    baselineRevenueCents: number;
    simulatedRevenueCents: number;
    riskLevel: string;
  };
  conversationQuality: SimulationResult['conversationQuality'];
  summary: string;
}

export async function validateWithDigitalTwin(
  tenantId: string,
  recommendationId: string,
  modelId: string,
  scenarioId: string,
  parameters?: Record<string, unknown>,
): Promise<AutopilotValidationResult> {
  logger.info('Validating recommendation with digital twin', {
    tenantId, recommendationId, modelId, scenarioId,
  });

  try {
    const { run, result } = await runSimulation(
      tenantId,
      modelId,
      scenarioId,
      `Autopilot validation: ${recommendationId}`,
      parameters,
    );

    const baseline = result.comparisonBaseline;
    const simulated = result.metrics;

    const improvementDetected =
      simulated.projectedBookingRate > baseline.projectedBookingRate ||
      simulated.projectedRevenuePerDayCents > baseline.projectedRevenuePerDayCents;

    let conversationQualityValidated = true;
    if (result.conversationQuality?.comparison) {
      conversationQualityValidated = result.conversationQuality.comparison.overallImprovement >= 0;
    }

    const validated = improvementDetected && simulated.riskLevel !== 'high' && conversationQualityValidated;

    await persistValidationResult(tenantId, result.id, recommendationId, validated, improvementDetected, simulated.riskLevel);

    const validationResult: AutopilotValidationResult = {
      recommendationId,
      validated,
      simulationRunId: run.id,
      resultId: result.id,
      improvementDetected,
      metrics: {
        baselineConversionRate: baseline.projectedBookingRate,
        simulatedConversionRate: simulated.projectedBookingRate,
        baselineRevenueCents: baseline.projectedRevenuePerDayCents,
        simulatedRevenueCents: simulated.projectedRevenuePerDayCents,
        riskLevel: simulated.riskLevel,
      },
      conversationQuality: result.conversationQuality,
      summary: result.summary ?? 'Validation complete.',
    };

    logger.info('Autopilot validation completed', {
      tenantId, recommendationId,
      validated: validationResult.validated,
      improvement: improvementDetected,
      conversationQualityValidated,
    });

    return validationResult;
  } catch (err) {
    logger.error('Autopilot validation failed', {
      tenantId, recommendationId, error: String(err),
    });
    throw err;
  }
}

async function persistValidationResult(
  tenantId: string,
  resultId: string,
  recommendationId: string,
  validated: boolean,
  improvementDetected: boolean,
  riskLevel: string,
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const validationOutcome = {
      validated,
      improvementDetected,
      riskLevel,
      evaluatedAt: new Date().toISOString(),
    };

    await withTenantContext(client, tenantId, async () => {
      await client.query(
        `UPDATE digital_twin_results SET recommendation_id = $1, validation_outcome = $2
         WHERE id = $3 AND tenant_id = $4`,
        [recommendationId, JSON.stringify(validationOutcome), resultId, tenantId],
      );
    });
    logger.info('Persisted validation result', { tenantId, resultId, recommendationId, validated, improvementDetected });
  } finally {
    client.release();
  }
}
