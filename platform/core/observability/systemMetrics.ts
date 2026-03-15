import { randomUUID } from 'crypto';
import os from 'os';
import { getPlatformPool, withPrivilegedClient } from '../../db';
import { createLogger } from '../logger';

export interface SystemMetricsSnapshot {
  activeSessions: number;
  activeDbConnections: number;
  dbPoolTotal: number;
  dbPoolIdle: number;
  dbPoolWaiting: number;
  memoryUsageMb: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  uptimeSeconds: number;
}

const logger = createLogger('SYSTEM_METRICS');

export async function getSystemMetrics(): Promise<SystemMetricsSnapshot> {
  const pool = getPlatformPool();
  const mem = process.memoryUsage();

  const activeSessions = await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS count FROM call_sessions WHERE lifecycle_state NOT IN ('CALL_COMPLETED', 'CALL_FAILED')`,
    );
    return (rows[0]?.count as number) ?? 0;
  });

  return {
    activeSessions,
    activeDbConnections: pool.totalCount - pool.idleCount,
    dbPoolTotal: pool.totalCount,
    dbPoolIdle: pool.idleCount,
    dbPoolWaiting: pool.waitingCount,
    memoryUsageMb: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    uptimeSeconds: Math.round(process.uptime()),
  };
}

async function writeSystemMetricsSnapshot(): Promise<void> {
  try {
    const snapshot = await getSystemMetrics();
    const hostname = os.hostname();
    const pool = getPlatformPool();

    const metrics: Array<[string, number, Record<string, unknown>]> = [
      ['active_sessions', snapshot.activeSessions, {}],
      ['db_pool_active', snapshot.activeDbConnections, { total: snapshot.dbPoolTotal, idle: snapshot.dbPoolIdle }],
      ['memory_rss_mb', snapshot.memoryUsageMb.rss, {}],
      ['memory_heap_used_mb', snapshot.memoryUsageMb.heapUsed, { heapTotal: snapshot.memoryUsageMb.heapTotal }],
      ['uptime_seconds', snapshot.uptimeSeconds, {}],
    ];

    for (const [name, value, tags] of metrics) {
      await pool.query(
        `INSERT INTO system_metrics (id, host, metric_name, metric_value, tags)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), hostname, name, value, JSON.stringify(tags)],
      );
    }

    logger.info('System metrics snapshot written', { metricsCount: metrics.length });
  } catch (err) {
    logger.error('Failed to write system metrics snapshot', { error: String(err) });
  }
}

let systemMetricsTimer: ReturnType<typeof setInterval> | null = null;

export function startSystemMetricsWriter(intervalMs = 60_000): void {
  if (systemMetricsTimer) return;
  logger.info('Starting system metrics writer', { intervalMs });
  systemMetricsTimer = setInterval(() => {
    writeSystemMetricsSnapshot().catch((err) => {
      logger.error('System metrics tick error', { error: String(err) });
    });
  }, intervalMs);
  writeSystemMetricsSnapshot().catch((err) => {
    logger.error('Initial system metrics write error', { error: String(err) });
  });
}

export function stopSystemMetricsWriter(): void {
  if (systemMetricsTimer) {
    clearInterval(systemMetricsTimer);
    systemMetricsTimer = null;
    logger.info('System metrics writer stopped');
  }
}
