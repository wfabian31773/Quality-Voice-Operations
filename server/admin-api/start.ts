import * as http from 'http';
import app from './app';
import { closePlatformPool } from '../../platform/db';
import { createLogger } from '../../platform/core/logger';
import { startUsageMeteringWorker, stopUsageMeteringWorker } from '../../platform/billing/stripe/usage';
import {
  startCampaignScheduler,
  stopCampaignScheduler,
  startFederalDncSyncScheduler,
  stopFederalDncSyncScheduler,
} from '../../platform/campaigns';
import { startMetricsRollup, stopMetricsRollup, startSystemMetricsWriter, stopSystemMetricsWriter, logError } from '../../platform/core/observability';
import { validateBillingConfig } from '../../platform/billing/stripe/plans';
import { validateEnvironment, validateDatabaseConnection } from '../../scripts/validate-env';
import { assertProductionSecrets } from './middleware/security';
import { registerCoreTools } from '../../platform/tools/registerCoreTools';
import { registerTemplateTools } from '../../platform/tools/registerTemplateTools';
import { startUsageGuardrailsScheduler, stopUsageGuardrailsScheduler } from '../../platform/billing/guardrails/UsageGuardrails';
import { startInsightsScheduler, stopInsightsScheduler, startCallViewDigestScheduler, stopCallViewDigestScheduler, startCsatExpirationScheduler, stopCsatExpirationScheduler } from '../../platform/analytics';
import { startWorkforceScheduler, stopWorkforceScheduler } from '../../platform/workforce/WorkforceScheduler';
import { startGinScheduler, stopGinScheduler } from '../../platform/gin';
import { initOperatorNotificationPipeline } from '../../platform/tools/OperatorNotificationPipeline';
import { initToolHealthTracking } from '../../platform/tools/ToolHealthService';
import { ensureReliabilityTables } from '../../platform/tools/ensureReliabilityTables';
import { startMilestoneScheduler, stopMilestoneScheduler } from '../../platform/analytics/MilestoneScheduler';
import { startDocsFeedbackAlertScheduler, stopDocsFeedbackAlertScheduler } from '../../platform/help/DocsFeedbackAlertScheduler';
import { startDocsFeedbackReplyDigestScheduler, stopDocsFeedbackReplyDigestScheduler } from '../../platform/help/DocsFeedbackReplyDigestScheduler';
import { startDocsFeedbackReplyRetryScheduler, stopDocsFeedbackReplyRetryScheduler } from '../../platform/help/DocsFeedbackReplyRetryScheduler';
import { startSupportReplyRetryScheduler, stopSupportReplyRetryScheduler } from '../../platform/help/SupportReplyRetryScheduler';
import { startRetryAttemptsCleanupScheduler, stopRetryAttemptsCleanupScheduler } from '../../platform/help/RetryAttemptsCleanupScheduler';
import { startConnectorAuthAlertScheduler, stopConnectorAuthAlertScheduler } from '../../platform/integrations/connectors/ConnectorAuthAlertScheduler';
import { startConnectorStaleAlertScheduler, stopConnectorStaleAlertScheduler } from '../../platform/integrations/connectors/ConnectorStaleAlertScheduler';
import { startVerifiedCallerHealthScheduler, stopVerifiedCallerHealthScheduler, startTrustHubStatusScheduler, stopTrustHubStatusScheduler } from '../../platform/telephony/VerifiedCallerHealthScheduler';
import { startVerifiedCallerSyncScheduler, stopVerifiedCallerSyncScheduler } from '../../platform/telephony/VerifiedCallerSyncScheduler';
import {
  startConnectorOutboxDrainScheduler,
  stopConnectorOutboxDrainScheduler,
  startOutboxArchiveSweepScheduler,
  stopOutboxArchiveSweepScheduler,
} from '../../platform/integrations/connectors/ConnectorOutboxDrainScheduler';
import { startSchedulingDriftAlertScheduler, stopSchedulingDriftAlertScheduler } from '../../platform/integrations/connectors/SchedulingDriftAlertScheduler';
import { startOAuthTokenRefreshScheduler, stopOAuthTokenRefreshScheduler, startCrmCallerIdentityRevalidationScheduler, stopCrmCallerIdentityRevalidationScheduler, startCrmStaleCacheRetentionScheduler, stopCrmStaleCacheRetentionScheduler } from '../../platform/integrations/connectors';
import { startCallEventsRetentionScheduler, stopCallEventsRetentionScheduler } from '../../platform/billing/CallEventsRetentionScheduler';
import { startTenantIsolationScheduler, stopTenantIsolationScheduler } from '../../platform/security/TenantIsolationScheduler';
import { startEncryptionReminderScheduler, stopEncryptionReminderScheduler } from '../../platform/security/EncryptionReminderScheduler';
import { startRouteExportArchiveCleanupScheduler, stopRouteExportArchiveCleanupScheduler } from '../../platform/dispatch/RouteExportArchiveCleanupScheduler';

const logger = createLogger('ADMIN_API');

registerCoreTools();
registerTemplateTools();
initOperatorNotificationPipeline();
initToolHealthTracking();
ensureReliabilityTables().catch((err) => {
  logger.warn('Reliability tables setup deferred', { error: String(err) });
});
const PORT = parseInt(process.env.ADMIN_API_PORT ?? process.env.PORT ?? '3002', 10);

const isProd = process.env.APP_ENV === 'production' || process.env.APP_ENV === 'staging';
const envResult = validateEnvironment({ exitOnFailure: isProd });
if (!envResult.passed && !isProd) {
  logger.warn('Environment validation has warnings — some features may be unavailable');
}

// Belt-and-braces: even when the broader env validator runs, defensively
// re-check the security-critical secrets right before binding the port. If
// anything is missing in production we throw so the process exits with a
// clear error message instead of starting in a half-configured state.
assertProductionSecrets();

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
  startInsightsScheduler();
  startCallViewDigestScheduler();
  startCsatExpirationScheduler();
  startWorkforceScheduler();
  startGinScheduler();
  startMilestoneScheduler();
  startDocsFeedbackAlertScheduler();
  startDocsFeedbackReplyDigestScheduler();
  startDocsFeedbackReplyRetryScheduler();
  startSupportReplyRetryScheduler();
  startRetryAttemptsCleanupScheduler();
  startConnectorAuthAlertScheduler();
  startConnectorStaleAlertScheduler();
  startVerifiedCallerHealthScheduler();
  startVerifiedCallerSyncScheduler();
  startTrustHubStatusScheduler();
  startConnectorOutboxDrainScheduler();
  startOutboxArchiveSweepScheduler();
  startSchedulingDriftAlertScheduler();
  startOAuthTokenRefreshScheduler();
  startCrmCallerIdentityRevalidationScheduler();
  startCrmStaleCacheRetentionScheduler();
  startCallEventsRetentionScheduler();
  startTenantIsolationScheduler();
  startEncryptionReminderScheduler();
  startRouteExportArchiveCleanupScheduler();
  startFederalDncSyncScheduler();
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
  stopInsightsScheduler();
  stopCallViewDigestScheduler();
  stopCsatExpirationScheduler();
  stopWorkforceScheduler();
  stopGinScheduler();
  stopMilestoneScheduler();
  stopDocsFeedbackAlertScheduler();
  stopDocsFeedbackReplyDigestScheduler();
  stopDocsFeedbackReplyRetryScheduler();
  stopSupportReplyRetryScheduler();
  stopRetryAttemptsCleanupScheduler();
  stopConnectorAuthAlertScheduler();
  stopConnectorStaleAlertScheduler();
  stopVerifiedCallerHealthScheduler();
  stopVerifiedCallerSyncScheduler();
  stopTrustHubStatusScheduler();
  stopConnectorOutboxDrainScheduler();
  stopOutboxArchiveSweepScheduler();
  stopSchedulingDriftAlertScheduler();
  stopOAuthTokenRefreshScheduler();
  stopCrmCallerIdentityRevalidationScheduler();
  stopCrmStaleCacheRetentionScheduler();
  stopCallEventsRetentionScheduler();
  stopTenantIsolationScheduler();
  stopEncryptionReminderScheduler();
  stopRouteExportArchiveCleanupScheduler();
  stopFederalDncSyncScheduler();
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
