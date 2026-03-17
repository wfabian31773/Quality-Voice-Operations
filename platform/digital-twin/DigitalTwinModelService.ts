import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('DIGITAL_TWIN_MODEL');

export interface DigitalTwinModel {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  status: string;
  snapshotData: OperationalSnapshot;
  dataRangeStart: string | null;
  dataRangeEnd: string | null;
  metadata: Record<string, unknown>;
  isSimulation: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OperationalSnapshot {
  callVolume: HourlyDistribution;
  bookingConversionRate: number;
  avgCallDurationSeconds: number;
  agentPerformance: AgentPerformanceSnapshot[];
  seasonalPatterns: SeasonalPattern[];
  peakHours: number[];
  avgDailyCallVolume: number;
  avgWeeklyCallVolume: number;
  avgMonthlyCallVolume: number;
  inboundOutboundRatio: number;
  escalationRate: number;
  avgRevenuePerBookingCents: number;
  topIntents: IntentDistribution[];
}

export interface HourlyDistribution {
  byHour: Record<string, number>;
  byDayOfWeek: Record<string, number>;
}

export interface AgentPerformanceSnapshot {
  agentId: string;
  agentName: string;
  callsHandled: number;
  avgDurationSeconds: number;
  bookingRate: number;
  avgQualityScore: number;
}

export interface SeasonalPattern {
  month: number;
  avgCallVolume: number;
  avgBookingRate: number;
}

export interface IntentDistribution {
  intent: string;
  count: number;
  percentage: number;
}

export async function createDigitalTwinModel(
  tenantId: string,
  name: string,
  dataRangeStart: Date,
  dataRangeEnd: Date,
): Promise<DigitalTwinModel> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const snapshot = await buildOperationalSnapshot(client, tenantId, dataRangeStart, dataRangeEnd);

    const row = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `INSERT INTO digital_twin_models (tenant_id, name, status, snapshot_data, data_range_start, data_range_end, is_simulation)
         VALUES ($1, $2, 'ready', $3, $4, $5, true)
         RETURNING *`,
        [tenantId, name, JSON.stringify(snapshot), dataRangeStart, dataRangeEnd],
      );
      return rows[0];
    });

    logger.info('Digital twin model created', { tenantId, modelId: row.id });
    return mapModelRow(row);
  } finally {
    client.release();
  }
}

export async function getDigitalTwinModel(tenantId: string, modelId: string): Promise<DigitalTwinModel | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM digital_twin_models WHERE id = $1 AND tenant_id = $2`,
        [modelId, tenantId],
      );
      return rows;
    });
    return rows.length > 0 ? mapModelRow(rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function listDigitalTwinModels(tenantId: string): Promise<DigitalTwinModel[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM digital_twin_models WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [tenantId],
      );
      return rows;
    });
    return rows.map(mapModelRow);
  } finally {
    client.release();
  }
}

export async function deleteDigitalTwinModel(tenantId: string, modelId: string): Promise<boolean> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const result = await withTenantContext(client, tenantId, async () => {
      const { rowCount } = await client.query(
        `DELETE FROM digital_twin_models WHERE id = $1 AND tenant_id = $2`,
        [modelId, tenantId],
      );
      return rowCount;
    });
    return (result ?? 0) > 0;
  } finally {
    client.release();
  }
}

async function buildOperationalSnapshot(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  tenantId: string,
  from: Date,
  to: Date,
): Promise<OperationalSnapshot> {
  const { rows: callSummary } = await client.query(
    `SELECT
       COUNT(*)::int AS total_calls,
       COUNT(*) FILTER (WHERE direction = 'inbound')::int AS inbound_calls,
       COUNT(*) FILTER (WHERE direction = 'outbound')::int AS outbound_calls,
       COALESCE(AVG(duration_seconds), 0) AS avg_duration,
       COUNT(*) FILTER (WHERE lifecycle_state = 'ESCALATED')::int AS escalated_calls
     FROM call_sessions
     WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
    [tenantId, from, to],
  );

  const s = callSummary[0];
  const totalCalls = (s?.total_calls as number) ?? 0;
  const inboundCalls = (s?.inbound_calls as number) ?? 0;
  const outboundCalls = (s?.outbound_calls as number) ?? 0;
  const escalatedCalls = (s?.escalated_calls as number) ?? 0;
  const avgDuration = parseFloat(String(s?.avg_duration ?? 0));

  const { rows: hourlyRows } = await client.query(
    `SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS cnt
     FROM call_sessions WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
     GROUP BY EXTRACT(HOUR FROM created_at) ORDER BY hour`,
    [tenantId, from, to],
  );

  const byHour: Record<string, number> = {};
  for (const r of hourlyRows) {
    byHour[String(r.hour)] = (r.cnt as number) ?? 0;
  }

  const { rows: dowRows } = await client.query(
    `SELECT EXTRACT(DOW FROM created_at)::int AS dow, COUNT(*)::int AS cnt
     FROM call_sessions WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
     GROUP BY EXTRACT(DOW FROM created_at) ORDER BY dow`,
    [tenantId, from, to],
  );

  const byDayOfWeek: Record<string, number> = {};
  for (const r of dowRows) {
    byDayOfWeek[String(r.dow)] = (r.cnt as number) ?? 0;
  }

  const { rows: bookingRows } = await client.query(
    `SELECT COUNT(*)::int AS booked
     FROM call_sessions
     WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
       AND context->>'callOutcome' IS NOT NULL
       AND (context->'callOutcome'->>'disposition') = 'resolved'`,
    [tenantId, from, to],
  );
  const bookedCount = (bookingRows[0]?.booked as number) ?? 0;
  const bookingConversionRate = totalCalls > 0 ? bookedCount / totalCalls : 0;

  const { rows: agentRows } = await client.query(
    `SELECT a.id AS agent_id, a.name AS agent_name,
       COUNT(cs.id)::int AS calls_handled,
       COALESCE(AVG(cs.duration_seconds), 0) AS avg_dur,
       COUNT(cs.id) FILTER (WHERE cs.context->>'callOutcome' IS NOT NULL AND (cs.context->'callOutcome'->>'disposition') = 'resolved')::int AS booked
     FROM agents a
     LEFT JOIN call_sessions cs ON cs.agent_id = a.id AND cs.created_at >= $2 AND cs.created_at < $3
     WHERE a.tenant_id = $1
     GROUP BY a.id, a.name`,
    [tenantId, from, to],
  );

  const agentPerformance: AgentPerformanceSnapshot[] = agentRows.map((r: Record<string, unknown>) => {
    const handled = (r.calls_handled as number) ?? 0;
    const booked = (r.booked as number) ?? 0;
    return {
      agentId: r.agent_id as string,
      agentName: r.agent_name as string,
      callsHandled: handled,
      avgDurationSeconds: parseFloat(String(r.avg_dur ?? 0)),
      bookingRate: handled > 0 ? booked / handled : 0,
      avgQualityScore: 0,
    };
  });

  const { rows: monthlyRows } = await client.query(
    `SELECT EXTRACT(MONTH FROM created_at)::int AS month,
       COUNT(*)::int AS call_count,
       COUNT(*) FILTER (WHERE context->>'callOutcome' IS NOT NULL AND (context->'callOutcome'->>'disposition') = 'resolved')::int AS booked
     FROM call_sessions
     WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
     GROUP BY EXTRACT(MONTH FROM created_at)
     ORDER BY month`,
    [tenantId, from, to],
  );

  const seasonalPatterns: SeasonalPattern[] = monthlyRows.map((r: Record<string, unknown>) => ({
    month: r.month as number,
    avgCallVolume: (r.call_count as number) ?? 0,
    avgBookingRate: (r.call_count as number) > 0 ? ((r.booked as number) ?? 0) / (r.call_count as number) : 0,
  }));

  const peakHours = Object.entries(byHour)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([h]) => parseInt(h));

  const daysDiff = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)));
  const weeksDiff = Math.max(1, daysDiff / 7);
  const monthsDiff = Math.max(1, daysDiff / 30);

  return {
    callVolume: { byHour, byDayOfWeek },
    bookingConversionRate,
    avgCallDurationSeconds: avgDuration,
    agentPerformance,
    seasonalPatterns,
    peakHours,
    avgDailyCallVolume: Math.round(totalCalls / daysDiff),
    avgWeeklyCallVolume: Math.round(totalCalls / weeksDiff),
    avgMonthlyCallVolume: Math.round(totalCalls / monthsDiff),
    inboundOutboundRatio: outboundCalls > 0 ? inboundCalls / outboundCalls : inboundCalls > 0 ? Infinity : 0,
    escalationRate: totalCalls > 0 ? escalatedCalls / totalCalls : 0,
    avgRevenuePerBookingCents: 15000,
    topIntents: [],
  };
}

function mapModelRow(row: Record<string, unknown>): DigitalTwinModel {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    version: row.version as number,
    status: row.status as string,
    snapshotData: typeof row.snapshot_data === 'string' ? JSON.parse(row.snapshot_data as string) : (row.snapshot_data as OperationalSnapshot),
    dataRangeStart: row.data_range_start ? String(row.data_range_start) : null,
    dataRangeEnd: row.data_range_end ? String(row.data_range_end) : null,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata as string) : ((row.metadata ?? {}) as Record<string, unknown>),
    isSimulation: row.is_simulation as boolean,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
