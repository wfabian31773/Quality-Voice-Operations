/**
 * Render `qvo-worker` entrypoint (QVO_PROCESS_ROLE=worker).
 *
 *   npx tsx server/worker/start.ts
 *
 * Runs the scheduler registry (platform/runtime/schedulers.ts) behind a
 * Postgres advisory-lock leader. SCHEDULERS_ENABLED defaults to `none` for
 * this role, so a fresh deploy is safe in shadow mode. Daily schedulers with
 * a run-once function are never started here; `qvo-nightly` runs them.
 */
import { closePlatformPool, getPrivilegedPool } from '../../platform/db';
import { createLogger } from '../../platform/core/logger';
import { logError } from '../../platform/core/observability';
import { validateEnvironment } from '../../scripts/validate-env';
import { registerCoreTools } from '../../platform/tools/registerCoreTools';
import { registerTemplateTools } from '../../platform/tools/registerTemplateTools';
import { registerToolLibrary } from '../../platform/tools/library';
import { initOperatorNotificationPipeline } from '../../platform/tools/OperatorNotificationPipeline';
import { initToolHealthTracking } from '../../platform/tools/ToolHealthService';
import { selectSchedulers } from '../../platform/runtime/schedulers';
import { LeaderElector, resolveLeaderLockUrl } from '../../platform/runtime/leaderLock';
import { closeWithTimeout } from '../../platform/runtime/boundedClose';
import {
  resolveProcessRole,
  isRenderRuntime,
  scrubReplitFallbacks,
  resolveVoiceGatewayBaseUrl,
} from '../../platform/runtime/processRole';
import { SchedulerWorker } from './worker';

const logger = createLogger('WORKER');

const ROLE = resolveProcessRole(process.env, 'worker');
if (ROLE !== 'worker') {
  logger.error('server/worker/start.ts requires QVO_PROCESS_ROLE=worker (or unset)', { role: ROLE });
  process.exit(1);
}
const removedReplitVars = scrubReplitFallbacks();
if (removedReplitVars.length > 0) {
  logger.warn('Ignoring Replit-only env vars on Render', { names: removedReplitVars });
}

registerCoreTools();
registerTemplateTools();
registerToolLibrary();
initOperatorNotificationPipeline();
initToolHealthTracking();

const isProd = process.env.APP_ENV === 'production' || process.env.APP_ENV === 'staging';
const envResult = validateEnvironment({ exitOnFailure: isProd || isRenderRuntime(), role: ROLE });
if (!envResult.passed && !isProd) {
  logger.warn('Environment validation has warnings — some features may be unavailable');
}

const selection = selectSchedulers(ROLE);
if (selection.unknown.length > 0) {
  logger.error('SCHEDULERS_ENABLED lists unknown scheduler names (ignored)', { names: selection.unknown });
}
logger.info('Schedulers enabled', {
  role: ROLE,
  setting: selection.setting,
  enabled: selection.enabled.map((s) => s.name),
  skipped: selection.skipped,
});

const voiceGatewayBaseUrl = resolveVoiceGatewayBaseUrl() ?? 'http://localhost:3001';
const lockUrl = resolveLeaderLockUrl();

const worker = new SchedulerWorker({
  schedulers: selection.enabled,
  ctx: { voiceGatewayBaseUrl },
  createElector: (hooks) =>
    new LeaderElector({
      connectionString: lockUrl,
      ssl: (process.env.APP_ENV ?? 'development') === 'development' ? undefined : { rejectUnauthorized: false },
      onAcquire: hooks.onAcquire,
      onLose: hooks.onLose,
    }),
  // Scheduler ticks run in the privileged DB scope, so in-flight work shows
  // up on the privileged pool (the same pool until DATABASE_URL_PRIVILEGED is set).
  pool: () => getPrivilegedPool(),
  closePool: async () => {
    await closeWithTimeout('DB pool', closePlatformPool);
  },
});

worker.start().catch((err) => {
  logger.error('Worker failed to start', { error: String(err) });
  process.exit(1);
});

async function shutdown(signal: string): Promise<void> {
  await worker.shutdown(signal);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { error: String(reason) });
  logError(null, 'critical', String(reason), {
    service: 'worker',
    stackTrace: reason instanceof Error ? reason.stack : undefined,
    extra: { type: 'unhandledRejection' },
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: String(err) });
  logError(null, 'critical', err.message, {
    service: 'worker',
    stackTrace: err.stack,
    extra: { type: 'uncaughtException' },
  });
  void shutdown('uncaughtException');
});
