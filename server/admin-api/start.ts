import * as http from 'http';
import app, { voiceGatewayProxy } from './app';
import { closePlatformPool } from '../../platform/db';
import { createLogger } from '../../platform/core/logger';
import { logError } from '../../platform/core/observability';
import { validateBillingConfig } from '../../platform/billing/stripe/plans';
import { validateEnvironment, validateDatabaseConnection } from '../../scripts/validate-env';
import { assertProductionSecrets } from './middleware/security';
import { registerCoreTools } from '../../platform/tools/registerCoreTools';
import { registerTemplateTools } from '../../platform/tools/registerTemplateTools';
import { registerToolLibrary } from '../../platform/tools/library';
import { initOperatorNotificationPipeline } from '../../platform/tools/OperatorNotificationPipeline';
import { initToolHealthTracking } from '../../platform/tools/ToolHealthService';
import { ensureReliabilityTables } from '../../platform/tools/ensureReliabilityTables';
import { selectSchedulers, startSchedulers, stopSchedulers } from '../../platform/runtime/schedulers';
import { resolveProcessRole, resolveApiPort, isRenderRuntime, scrubReplitFallbacks, resolveVoiceGatewayBaseUrl } from '../../platform/runtime/processRole';
import { markDraining, markEnvValidated, markRegistriesLoaded } from '../../platform/runtime/health';
import { getBuildInfo } from '../../platform/runtime/buildInfo';
import { closeWithTimeout } from '../../platform/runtime/boundedClose';

const logger = createLogger('ADMIN_API');

// `all` (default) = Replit: this process also owns every scheduler and the
// `/vg` WebSocket proxy, exactly as before PR-00.
const ROLE = resolveProcessRole();
const removedReplitVars = scrubReplitFallbacks();
if (removedReplitVars.length > 0) {
  logger.warn('Ignoring Replit-only env vars on Render', { names: removedReplitVars });
}

registerCoreTools();
registerTemplateTools();
registerToolLibrary();
initOperatorNotificationPipeline();
initToolHealthTracking();
markRegistriesLoaded();
ensureReliabilityTables().catch((err) => {
  logger.warn('Reliability tables setup deferred', { error: String(err) });
});
const PORT = resolveApiPort(ROLE);

const isProd = process.env.APP_ENV === 'production' || process.env.APP_ENV === 'staging';
const envResult = validateEnvironment({ exitOnFailure: isProd || isRenderRuntime(), role: ROLE });
markEnvValidated(envResult.passed);
if (!envResult.passed && !isProd) {
  logger.warn('Environment validation has warnings — some features may be unavailable');
}

// Belt-and-braces: even when the broader env validator runs, defensively
// re-check the security-critical secrets right before binding the port. If
// anything is missing in production we throw so the process exits with a
// clear error message instead of starting in a half-configured state.
assertProductionSecrets();

const server = http.createServer(app);

// Forward WebSocket upgrade requests on /vg/* to the voice-gateway.
// The HTTP arm of the proxy is registered as Express middleware in
// app.ts; this hook is required for the wss:// <Stream> URL embedded
// in TwiML responses to actually reach the voice-gateway process.
// Replit only (role `all`): on Render, Twilio and the widget connect to the
// voice service directly so an API deploy can never cut a live call.
if (ROLE === 'all') {
  server.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith('/vg/')) {
      (voiceGatewayProxy as unknown as {
        upgrade: (req: http.IncomingMessage, socket: import('net').Socket, head: Buffer) => void;
      }).upgrade(req, socket as import('net').Socket, head);
    }
  });
}

const schedulerSelection = selectSchedulers(ROLE);

server.listen(PORT, '0.0.0.0', async () => {
  logger.info(`Admin API listening on port ${PORT}`, {
    port: PORT,
    role: ROLE,
    env: process.env.APP_ENV ?? 'development',
    nodeVersion: process.version,
    deploy: getBuildInfo().marker,
  });

  await validateDatabaseConnection();

  const billingCheck = validateBillingConfig();
  for (const warning of billingCheck.warnings) {
    logger.warn(`[BILLING CONFIG] ${warning}`);
  }
  if (billingCheck.errors.length > 0) {
    for (const error of billingCheck.errors) {
      logger.error(`[BILLING CONFIG] ${error}`);
    }
    // Task #1321: per-tier metered AI-minutes price ids are now hard
    // requirements once `STRIPE_METER_EVENT_AI_MINUTES` is set. In
    // production we exit immediately rather than silently quoting the
    // catalog overage rate. validate-env.ts also catches the same gap
    // before listen() is even called, so this branch is a defense-in-depth
    // safety net for staging or operator-edge cases where the static gate
    // in validate-env.ts has been bypassed.
    if (isProd) {
      logger.error(
        '[BILLING CONFIG] Hard validation failures present — exiting so the deployment is not booted with a broken billing config',
      );
      process.exit(1);
    }
  }

  const voiceGatewayBaseUrl = resolveVoiceGatewayBaseUrl() ?? 'http://localhost:3001';
  const adminApiBaseUrl = process.env.ADMIN_API_BASE_URL ?? `http://localhost:${PORT}`;
  if (schedulerSelection.unknown.length > 0) {
    logger.error('SCHEDULERS_ENABLED lists unknown scheduler names (ignored)', { names: schedulerSelection.unknown });
  }
  logger.info('Schedulers enabled', {
    role: ROLE,
    setting: schedulerSelection.setting,
    enabled: schedulerSelection.enabled.map((s) => s.name),
    skipped: schedulerSelection.skipped.length,
  });
  startSchedulers(schedulerSelection.enabled, { voiceGatewayBaseUrl });
  if (schedulerSelection.enabled.some((s) => s.name === 'campaigns')) {
    logger.info('Campaign scheduler started', { voiceGatewayBaseUrl, adminApiBaseUrl });
  }
});

let shuttingDown = false;
const SHUTDOWN_HTTP_WAIT_MS = 50_000;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    logger.info(`Received ${signal} while already shutting down — ignoring`);
    return;
  }
  shuttingDown = true;
  logger.info(`Received ${signal}, starting graceful shutdown`);
  markDraining();

  // Role `all` only (Replit): nothing else in this process schedules work.
  stopSchedulers(schedulerSelection.enabled, (name, err) => {
    logger.warn('Scheduler stop failed', { scheduler: name, error: String(err) });
  });

  // Stop accepting connections and wait up to 50 s for in-flight requests
  // (Render maxShutdownDelaySeconds for qvo-api is 60).
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      logger.warn('In-flight requests still open after 50 s — closing them');
      server.closeAllConnections?.();
      resolve();
    }, SHUTDOWN_HTTP_WAIT_MS);
    server.close(() => {
      clearTimeout(timer);
      logger.info('HTTP server closed');
      resolve();
    });
    server.closeIdleConnections?.();
  });

  await closeWithTimeout('DB pool', closePlatformPool);
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { error: String(reason) });
  logError(null, 'critical', String(reason), {
    service: 'admin-api',
    stackTrace: reason instanceof Error ? reason.stack : undefined,
    extra: { type: 'unhandledRejection' },
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: String(err) });
  logError(null, 'critical', err.message, {
    service: 'admin-api',
    stackTrace: err.stack,
    extra: { type: 'uncaughtException' },
  });
  gracefulShutdown('uncaughtException');
});

export { server };
