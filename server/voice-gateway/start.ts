import * as http from 'http';
import app from './app';
import { attachWebSocket } from './routes/stream';
import { sessionManager } from './services/sessionManager';
import { closePlatformPool } from '../../platform/db';
import { createLogger } from '../../platform/core/logger';
import { logError } from '../../platform/core/observability';
import { createTwilioAdapterFromEnv } from './services/twilioAdapter';
import { setTwilioAdapter } from './routes/twilio';
import { startStreamCanary, stopStreamCanary } from './services/streamCanary';
import { validateEnvironment } from '../../scripts/validate-env';
import { registerCoreTools } from '../../platform/tools/registerCoreTools';
import { registerTemplateTools } from '../../platform/tools/registerTemplateTools';
import { registerToolLibrary } from '../../platform/tools/library';
import { registerRetrieveKnowledgeTool } from '../../platform/tools/knowledge/retrieveKnowledgeTool';
import { initOperatorNotificationPipeline } from '../../platform/tools/OperatorNotificationPipeline';
import { initToolHealthTracking } from '../../platform/tools/ToolHealthService';
import { ensureReliabilityTables } from '../../platform/tools/ensureReliabilityTables';
import { resolveProcessRole, resolveVoicePort, isRenderRuntime, scrubReplitFallbacks } from '../../platform/runtime/processRole';
import { markEnvValidated, markRegistriesLoaded } from '../../platform/runtime/health';
import { getBuildInfo } from '../../platform/runtime/buildInfo';
import { closeWithTimeout } from '../../platform/runtime/boundedClose';
import { createVoiceShutdown } from './shutdown';

const logger = createLogger('VOICE_GATEWAY');

// `all` (default) = Replit: same process layout as before PR-00.
const ROLE = resolveProcessRole();
const removedReplitVars = scrubReplitFallbacks();
if (removedReplitVars.length > 0) {
  logger.warn('Ignoring Replit-only env vars on Render', { names: removedReplitVars });
}

registerCoreTools();
registerTemplateTools();
registerToolLibrary();
registerRetrieveKnowledgeTool();
initOperatorNotificationPipeline();
initToolHealthTracking();
markRegistriesLoaded();
ensureReliabilityTables().catch((err) => {
  logger.warn('Reliability tables setup deferred', { error: String(err) });
});

const isProd = process.env.APP_ENV === 'production' || process.env.APP_ENV === 'staging';
const envResult = validateEnvironment({ exitOnFailure: isProd || isRenderRuntime(), role: ROLE });
markEnvValidated(envResult.passed);
if (!envResult.passed && !isProd) {
  logger.warn('Environment validation has warnings — some features may be unavailable');
}

const twilioAdapter = createTwilioAdapterFromEnv();
if (twilioAdapter) {
  setTwilioAdapter(twilioAdapter);
  logger.info('Twilio transfer adapter registered');
}

const PORT = resolveVoicePort(ROLE);

const server = http.createServer(app);
attachWebSocket(server);

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Voice Gateway listening on port ${PORT}`, {
    port: PORT,
    role: ROLE,
    env: process.env.APP_ENV ?? 'development',
    nodeVersion: process.version,
    deploy: getBuildInfo().marker,
  });
  // Start the synthetic realtime-stream canary (no-op unless
  // STREAM_CANARY_ENABLED). Listens locally, so start it after the server is
  // up so the first tick can reach the gateway.
  startStreamCanary();
});

const { drainAndExit, fastShutdown } = createVoiceShutdown({
  server,
  sessions: sessionManager,
  closePool: async () => {
    await closeWithTimeout('DB pool', closePlatformPool);
  },
  stopCanary: stopStreamCanary,
  exit: (code) => process.exit(code),
});

process.on('SIGTERM', () => void drainAndExit('SIGTERM'));
process.on('SIGINT', () => void drainAndExit('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { error: String(reason) });
  logError(null, 'critical', String(reason), {
    service: 'voice-gateway',
    stackTrace: reason instanceof Error ? reason.stack : undefined,
    extra: { type: 'unhandledRejection' },
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: String(err) });
  logError(null, 'critical', err.message, {
    service: 'voice-gateway',
    stackTrace: err.stack,
    extra: { type: 'uncaughtException' },
  });
  void fastShutdown('uncaughtException');
});

export { server };
