import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import type { OperationalSnapshot } from './DigitalTwinModelService';

const logger = createLogger('FORECASTING');

export interface ForecastModel {
  id: string;
  tenantId: string;
  modelId: string | null;
  forecastType: string;
  horizonDays: number;
  generatedAt: string;
  projections: ForecastProjection[];
  confidenceLevel: number;
  metadata: Record<string, unknown>;
  isSimulation: boolean;
  createdAt: string;
}

export interface ForecastProjection {
  date: string;
  value: number;
  lowerBound: number;
  upperBound: number;
  label?: string;
}

export type ForecastType = 'call_volume' | 'booking_rate' | 'revenue' | 'staffing_needs';

export async function generateForecast(
  tenantId: string,
  modelId: string,
  forecastType: ForecastType,
  horizonDays: number = 30,
  confidenceLevel: number = 0.8,
): Promise<ForecastModel> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const modelRows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM digital_twin_models WHERE id = $1 AND tenant_id = $2`,
        [modelId, tenantId],
      );
      return rows;
    });
    if (modelRows.length === 0) throw new Error('Digital twin model not found');

    const snapshot: OperationalSnapshot = typeof modelRows[0].snapshot_data === 'string'
      ? JSON.parse(modelRows[0].snapshot_data) : modelRows[0].snapshot_data;

    const projections = computeProjections(snapshot, forecastType, horizonDays, confidenceLevel);

    const row = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `INSERT INTO forecast_models (tenant_id, model_id, forecast_type, horizon_days, projections, confidence_level, is_simulation)
         VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING *`,
        [tenantId, modelId, forecastType, horizonDays, JSON.stringify(projections), confidenceLevel],
      );
      return rows[0];
    });

    logger.info('Forecast generated', { tenantId, modelId, forecastType, horizonDays });
    return mapForecastRow(row);
  } finally {
    client.release();
  }
}

export async function getForecasts(
  tenantId: string,
  modelId?: string,
  forecastType?: string,
): Promise<ForecastModel[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const params: unknown[] = [tenantId];
      let where = 'WHERE tenant_id = $1';
      if (modelId) {
        params.push(modelId);
        where += ` AND model_id = $${params.length}`;
      }
      if (forecastType) {
        params.push(forecastType);
        where += ` AND forecast_type = $${params.length}`;
      }
      const { rows } = await client.query(
        `SELECT * FROM forecast_models ${where} ORDER BY generated_at DESC LIMIT 50`,
        params,
      );
      return rows;
    });
    return rows.map(mapForecastRow);
  } finally {
    client.release();
  }
}

export async function getForecast(tenantId: string, forecastId: string): Promise<ForecastModel | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM forecast_models WHERE id = $1 AND tenant_id = $2`,
        [forecastId, tenantId],
      );
      return rows;
    });
    return rows.length > 0 ? mapForecastRow(rows[0]) : null;
  } finally {
    client.release();
  }
}

function computeProjections(
  snapshot: OperationalSnapshot,
  forecastType: ForecastType,
  horizonDays: number,
  confidence: number,
): ForecastProjection[] {
  const projections: ForecastProjection[] = [];
  const today = new Date();
  const margin = 1 - confidence;

  for (let day = 1; day <= horizonDays; day++) {
    const date = new Date(today);
    date.setDate(date.getDate() + day);
    const dateStr = date.toISOString().slice(0, 10);
    const dayOfWeek = date.getDay();

    const seasonalFactor = getSeasonalFactor(snapshot, date.getMonth() + 1);
    const dowFactor = getDayOfWeekFactor(snapshot, dayOfWeek);
    const trendFactor = 1 + (day / horizonDays) * 0.02;

    let value: number;
    let label: string | undefined;

    switch (forecastType) {
      case 'call_volume': {
        const base = snapshot.avgDailyCallVolume || 0;
        value = Math.round(base * seasonalFactor * dowFactor * trendFactor);
        label = 'Projected calls';
        break;
      }
      case 'booking_rate': {
        const base = snapshot.bookingConversionRate || 0;
        value = Math.min(1, base * seasonalFactor * trendFactor);
        label = 'Projected booking rate';
        break;
      }
      case 'revenue': {
        const dailyCalls = (snapshot.avgDailyCallVolume || 0) * seasonalFactor * dowFactor * trendFactor;
        const bookingRate = snapshot.bookingConversionRate || 0;
        value = Math.round(dailyCalls * bookingRate * (snapshot.avgRevenuePerBookingCents || 15000));
        label = 'Projected daily revenue (cents)';
        break;
      }
      case 'staffing_needs': {
        const agentCount = snapshot.agentPerformance?.length || 1;
        const dailyCalls2 = (snapshot.avgDailyCallVolume || 0) * seasonalFactor * dowFactor * trendFactor;
        const callsPerAgent = agentCount > 0
          ? (snapshot.avgDailyCallVolume || 0) / agentCount : (snapshot.avgDailyCallVolume || 1);
        value = Math.ceil(dailyCalls2 / Math.max(callsPerAgent, 1));
        label = 'Projected agents needed';
        break;
      }
      default:
        value = 0;
    }

    const uncertainty = margin * (day / horizonDays);
    const lowerBound = forecastType === 'booking_rate'
      ? Math.max(0, value * (1 - uncertainty))
      : Math.max(0, Math.round(value * (1 - uncertainty)));
    const upperBound = forecastType === 'booking_rate'
      ? Math.min(1, value * (1 + uncertainty))
      : Math.round(value * (1 + uncertainty));

    projections.push({ date: dateStr, value, lowerBound, upperBound, label });
  }

  return projections;
}

function getSeasonalFactor(snapshot: OperationalSnapshot, month: number): number {
  if (!snapshot.seasonalPatterns || snapshot.seasonalPatterns.length === 0) return 1;
  const pattern = snapshot.seasonalPatterns.find(p => p.month === month);
  if (!pattern || !snapshot.avgMonthlyCallVolume || snapshot.avgMonthlyCallVolume === 0) return 1;
  return pattern.avgCallVolume / snapshot.avgMonthlyCallVolume;
}

function getDayOfWeekFactor(snapshot: OperationalSnapshot, dow: number): number {
  if (!snapshot.callVolume?.byDayOfWeek) return 1;
  const dowCount = snapshot.callVolume.byDayOfWeek[String(dow)];
  if (dowCount === undefined) return 1;
  const avgDow = Object.values(snapshot.callVolume.byDayOfWeek).reduce((a, b) => a + b, 0) / 7;
  return avgDow > 0 ? dowCount / avgDow : 1;
}

function mapForecastRow(row: Record<string, unknown>): ForecastModel {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    modelId: (row.model_id as string | null) ?? null,
    forecastType: row.forecast_type as string,
    horizonDays: row.horizon_days as number,
    generatedAt: String(row.generated_at),
    projections: typeof row.projections === 'string' ? JSON.parse(row.projections as string) : (row.projections as ForecastProjection[]),
    confidenceLevel: parseFloat(String(row.confidence_level)),
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata as string) : ((row.metadata ?? {}) as Record<string, unknown>),
    isSimulation: row.is_simulation as boolean,
    createdAt: String(row.created_at),
  };
}
