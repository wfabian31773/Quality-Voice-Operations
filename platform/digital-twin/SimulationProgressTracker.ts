import { createLogger } from '../core/logger';

const logger = createLogger('SIM_PROGRESS_TRACKER');

export type SimulationPhase =
  | 'queued'
  | 'initializing'
  | 'computing_baseline'
  | 'computing_simulated'
  | 'baseline_conversations'
  | 'variant_conversations'
  | 'finalizing'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface SimulationProgress {
  runId: string;
  tenantId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  phase: SimulationPhase;
  processed: number;
  total: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  cancelRequested: boolean;
  resultRunId?: string;
}

const TTL_MS = 10 * 60 * 1000;

const progress = new Map<string, SimulationProgress>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [runId, entry] of progress) {
    if (entry.finishedAt && now - entry.finishedAt > TTL_MS) {
      progress.delete(runId);
    }
  }
}

export function registerSimulation(
  runId: string,
  tenantId: string,
  total: number,
): SimulationProgress {
  purgeExpired();
  const entry: SimulationProgress = {
    runId,
    tenantId,
    status: 'running',
    phase: 'queued',
    processed: 0,
    total,
    startedAt: Date.now(),
    cancelRequested: false,
  };
  progress.set(runId, entry);
  return entry;
}

export function updateSimulationPhase(
  runId: string,
  phase: SimulationPhase,
  processed: number,
): void {
  const entry = progress.get(runId);
  if (!entry) return;
  entry.phase = phase;
  entry.processed = Math.min(processed, entry.total);
}

export function getSimulationProgress(runId: string): SimulationProgress | undefined {
  return progress.get(runId);
}

export function requestSimulationCancel(runId: string): boolean {
  const entry = progress.get(runId);
  if (!entry || entry.status !== 'running') return false;
  entry.cancelRequested = true;
  logger.info('Simulation cancellation requested', { runId });
  return true;
}

export function isSimulationCancelled(runId: string): boolean {
  return progress.get(runId)?.cancelRequested ?? false;
}

export function markSimulationCompleted(runId: string): void {
  const entry = progress.get(runId);
  if (!entry) return;
  entry.status = 'completed';
  entry.phase = 'completed';
  entry.processed = entry.total;
  entry.finishedAt = Date.now();
}

export function markSimulationCancelled(runId: string): void {
  const entry = progress.get(runId);
  if (!entry) return;
  entry.status = 'cancelled';
  entry.phase = 'cancelled';
  entry.finishedAt = Date.now();
}

export function markSimulationFailed(runId: string, error: string): void {
  const entry = progress.get(runId);
  if (!entry) return;
  entry.status = 'failed';
  entry.phase = 'failed';
  entry.error = error;
  entry.finishedAt = Date.now();
}

export class SimulationCancelledError extends Error {
  constructor(public readonly runId: string) {
    super(`Simulation ${runId} was cancelled`);
    this.name = 'SimulationCancelledError';
  }
}
