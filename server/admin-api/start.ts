import * as http from 'http';
import app from './app';
import { closePlatformPool } from '../../platform/db';
import { createLogger } from '../../platform/core/logger';
import { startUsageMeteringWorker, stopUsageMeteringWorker } from '../../platform/billing/stripe/usage';
import { startCampaignScheduler, stopCampaignScheduler } from '../../platform/campaigns';
import { startMetricsRollup, stopMetricsRollup, startSystemMetricsWriter, stopSystemMetricsWriter, logError } from '../../platform/core/observability';
import { validateBillingConfig } from '../../platform/billing/stripe/plans';
import { validateEnvironment, validateDatabaseConnection } from '../../scripts/validate-env';
import { registerCoreTools } from '../../platform/tools/registerCoreTools';
import { registerTemplateTools } from '../../platform/tools/registerTemplateTools';
import { startUsageGuardrailsScheduler, stopUsageGuardrailsScheduler } from '../../platform/billing/guardrails/UsageGuardrails';

const logger = createLogger('ADMIN_API');

registerCoreTools();
registerTemplateTools();
const PORT = parseInt(process.env.ADMIN_API_PORT ?? process.env.PORT ?? '3002', 10);

const isProd = process.env.APP_ENV === 'production' || process.env.APP_ENV === 'staging';
const envResult = validateEnvironment({ exitOnFailure: isProd });
if (!envResult.passed && !isProd) {
  logger.warn('Environment validation has warnings — some features may be unavailable');
}

const server = http.createServer(app);

server.listen(PORT, '0.0.0.0', async () => {
  logger.info(`Admin API listening on port ${PORT}`, {
    port: PORT,
    env: process.env.APP_ENV ?? 'development',
    nodeVersion: process.version,
  });

  await validateDatabaseConnection();

  const billingCheck = validateBillingConfig();
  if (!billingCheck.valid) {
    for (const warning of billingCheck.warnings) {
      logger.warn(`[BILLING CONFIG] ${warning}`);
    }
  }

  startUsageMeteringWorker();
  startMetricsRollup();
  startSystemMetricsWriter();

  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  const defaultGatewayUrl = devDomain ? `https://${devDomain}` : 'http://localhost:3001';
  const voiceGatewayBaseUrl = process.env.VOICE_GATEWAY_BASE_URL ?? defaultGatewayUrl;
  const adminApiBaseUrl = process.env.ADMIN_API_BASE_URL ?? `http://localhost:${PORT}`;
  startUsageGuardrailsScheduler();
  startCampaignScheduler({
    outboundCallbackBaseUrl: voiceGatewayBaseUrl,
    statusCallbackUrl: `${voiceGatewayBaseUrl}/twilio/status`,
    pollIntervalMs: 15_000,
  });
  logger.info('Campaign scheduler started', { voiceGatewayBaseUrl, adminApiBaseUrl });
});

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, starting graceful shutdown`);

  server.close(() => {
    logger.info('HTTP server closed');
  });

  stopUsageMeteringWorker();
  stopUsageGuardrailsScheduler();
  stopCampaignScheduler();
  stopMetricsRollup();
  stopSystemMetricsWriter();

  await closePlatformPool();
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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
