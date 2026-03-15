import * as http from 'http';
import app from './app';
import { attachWebSocket } from './routes/stream';
import { sessionManager } from './services/sessionManager';
import { closePlatformPool } from '../../platform/db';
import { createLogger } from '../../platform/core/logger';
import { logError } from '../../platform/core/observability';
import { createTwilioAdapterFromEnv } from './services/twilioAdapter';
import { setTwilioAdapter } from './routes/twilio';
import { validateEnvironment } from '../../scripts/validate-env';

const logger = createLogger('VOICE_GATEWAY');

const isProd = process.env.APP_ENV === 'production' || process.env.APP_ENV === 'staging';
const envResult = validateEnvironment({ exitOnFailure: isProd });
if (!envResult.passed && !isProd) {
  logger.warn('Environment validation has warnings — some features may be unavailable');
}

const twilioAdapter = createTwilioAdapterFromEnv();
if (twilioAdapter) {
  setTwilioAdapter(twilioAdapter);
  logger.info('Twilio transfer adapter registered');
}

const PORT = parseInt(process.env.VOICE_GATEWAY_PORT ?? '3001', 10);

const server = http.createServer(app);
attachWebSocket(server);

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Voice Gateway listening on port ${PORT}`, {
    port: PORT,
    env: process.env.APP_ENV ?? 'development',
    nodeVersion: process.version,
  });
});

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, starting graceful shutdown`);

  server.close(() => {
    logger.info('HTTP server closed — no new connections');
  });

  await sessionManager.drainAll(30_000);

  await closePlatformPool();
  logger.info('DB pool closed');

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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
  gracefulShutdown('uncaughtException');
});

export { server };
