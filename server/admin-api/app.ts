import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { errorHandler } from './middleware/errorHandler';
import { auditMutation } from '../../platform/audit/auditMutation';
import { createLogger } from '../../platform/core/logger';
import { corsOptions, securityHeaders } from './middleware/security';
import { attachSpaFallback, isProductionBoot } from './spaFallback';
import healthRoutes from './routes/health';
import authRoutes from './routes/auth';
import tenantRoutes from './routes/tenants';
import agentRoutes from './routes/agents';
import phoneNumberRoutes from './routes/phoneNumbers';
import trustedCallerRoutes from './routes/trustedCallers';
import callRoutes from './routes/calls';
import userRoutes from './routes/users';
import connectorRoutes from './routes/connectors';
import connectorOAuthRoutes from './routes/connectorOAuth';
import billingRoutes from './routes/billing';
import campaignRoutes from './routes/campaigns';
import observabilityRoutes from './routes/observability';
import analyticsRoutes from './routes/analytics';
import demoRoutes from './routes/demo';
import apiKeyRoutes from './routes/apiKeys';
import publicApiRoutes from './routes/publicApi';
import mobileApiRoutes from './routes/mobileApi';
import qualityRoutes from './routes/quality';
import csatRoutes from './routes/csat';
import auditLogRoutes from './routes/auditLog';
import platformAdminRoutes from './routes/platformAdmin';
import platformIntegrationsStatusRoutes from './routes/platformIntegrationsStatus';
import platformConnectorHealthRoutes from './routes/platformConnectorHealth';
import platformPushHealthRoutes from './routes/platformPushHealth';
import platformBillingHealthRoutes from './routes/platformBillingHealth';
import platformCallEventsRetentionRoutes from './routes/platformCallEventsRetention';
import platformPortalConfigCleanupRoutes from './routes/platformPortalConfigCleanup';
import callsLiveRoutes from './routes/callsLive';
import contactRoutes from './routes/contact';
import knowledgeBaseRoutes from './routes/knowledgeBase';
import knowledgeDocumentsRoutes from './routes/knowledgeDocuments';
import widgetRoutes from './routes/widget';
import marketplaceRoutes from './routes/marketplace';
import demoLiveRoutes from './routes/demoLive';
import toolExecutionRoutes from './routes/toolExecutions';
import operationsRoutes from './routes/operations';
import improvementsRoutes from './routes/improvements';
import toolHealthRoutes from './routes/toolHealth';
import costOptimizationRoutes from './routes/costOptimization';
import callDebugRoutes from './routes/callDebug';
import complianceRoutes from './routes/compliance';
import platformComplianceRoutes from './routes/platformCompliance';
import caseStudyRoutes from './routes/caseStudies';
import conversionRoutes from './routes/conversion';
import workflowRoutes from './routes/workflows';
import smsInboxRoutes from './routes/smsInbox';
import schedulingRoutes from './routes/scheduling';
import ticketRoutes from './routes/tickets';
import dispatchRoutes from './routes/dispatch';
import ingestRoutes from './routes/ingest';
import legalComplianceRoutes from './routes/legalCompliance';
import supportRoutes from './routes/support';
import productionEssentialsRoutes from './routes/productionEssentials';
import voicePreviewRoutes from './routes/voicePreview';
import marketingSearchAnalyticsRoutes from './routes/marketingSearchAnalytics';

const app = express();
const reqLogger = createLogger('REQ');

app.use(cors(corsOptions()));
app.use(cookieParser());

app.use(
  '/billing/stripe-webhook',
  express.raw({ type: 'application/json' }),
);

app.use(
  '/book-demo/calendar-webhook',
  express.raw({ type: 'application/json' }),
);

app.use(
  '/book-demo/calcom-native-webhook',
  express.raw({ type: 'application/json' }),
);

app.use(
  '/book-demo/calendly-webhook',
  express.raw({ type: 'application/json' }),
);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(securityHeaders());
app.use((req, _res, next) => {
  if (req.method !== 'GET' || req.path.includes('auth')) {
    reqLogger.info(`${req.method} ${req.path}`, {
      method: req.method,
      path: req.path,
      ip: req.ip,
    });
  }
  next();
});

app.use(auditMutation());

// Mount the entire voice-gateway HTTP app under /vg so Twilio webhooks
// (/vg/twilio/voice, /vg/twilio/sms, /vg/twilio/status, etc.) and the
// voice-gateway health/metrics/admin endpoints all share port 5000 with
// the Admin API in production. WebSocket upgrades for /vg/twilio/stream
// and /vg/widget/stream are wired up in start.ts via attachWebSocket().
import voiceGatewayApp from '../voice-gateway/app';
app.use('/vg', voiceGatewayApp);

app.use('/', healthRoutes);
app.use('/', authRoutes);


app.use('/', tenantRoutes);
app.use('/', agentRoutes);
app.use('/', phoneNumberRoutes);
app.use('/', trustedCallerRoutes);
app.use('/', callsLiveRoutes);
app.use('/', callRoutes);
app.use('/', userRoutes);
app.use('/', connectorRoutes);
app.use('/', connectorOAuthRoutes);
app.use('/', billingRoutes);
app.use('/', campaignRoutes);
app.use('/', observabilityRoutes);
app.use('/', analyticsRoutes);
app.use('/', demoRoutes);
app.use('/', demoLiveRoutes);
app.use('/', contactRoutes);
app.use('/', apiKeyRoutes);
app.use('/', qualityRoutes);
app.use('/', csatRoutes);
app.use('/', auditLogRoutes);
app.use('/', platformAdminRoutes);
app.use('/', platformIntegrationsStatusRoutes);
app.use('/', platformConnectorHealthRoutes);
app.use('/', platformPushHealthRoutes);
app.use('/', platformBillingHealthRoutes);
app.use('/', platformCallEventsRetentionRoutes);
app.use('/', platformPortalConfigCleanupRoutes);
app.use('/', knowledgeBaseRoutes);
app.use('/', knowledgeDocumentsRoutes);
app.use('/', publicApiRoutes);
app.use('/', mobileApiRoutes);
app.use('/', widgetRoutes);
app.use('/', marketplaceRoutes);
app.use('/', toolExecutionRoutes);
app.use('/', operationsRoutes);
app.use('/', improvementsRoutes);
app.use('/', toolHealthRoutes);
app.use('/', costOptimizationRoutes);
app.use('/', callDebugRoutes);
app.use('/', complianceRoutes);
app.use('/', platformComplianceRoutes);
app.use('/', caseStudyRoutes);
app.use('/', conversionRoutes);
app.use('/', workflowRoutes);
app.use('/', smsInboxRoutes);
app.use('/', schedulingRoutes);
app.use('/', ticketRoutes);
app.use('/', dispatchRoutes);
app.use('/', ingestRoutes);
app.use('/', legalComplianceRoutes);
app.use('/', supportRoutes);
app.use('/', productionEssentialsRoutes);
app.use('/', voicePreviewRoutes);
app.use('/', marketingSearchAnalyticsRoutes);

// Client UI (client-app/src/lib/api.ts BASE = "/api") prefixes every
// request with /api, but the routers above are mounted at /. Mirror
// the same handlers under /api so the SPA can reach them. /health and
// the voice-gateway under /vg keep their root paths so external probes
// (Twilio webhooks, uptime monitors) keep working unchanged.
app.use('/api', authRoutes);
app.use('/api', tenantRoutes);
app.use('/api', agentRoutes);
app.use('/api', phoneNumberRoutes);
app.use('/api', trustedCallerRoutes);
app.use('/api', callsLiveRoutes);
app.use('/api', callRoutes);
app.use('/api', userRoutes);
app.use('/api', connectorRoutes);
app.use('/api', connectorOAuthRoutes);
app.use('/api', billingRoutes);
app.use('/api', campaignRoutes);
app.use('/api', observabilityRoutes);
app.use('/api', analyticsRoutes);
app.use('/api', demoRoutes);
app.use('/api', demoLiveRoutes);
app.use('/api', contactRoutes);
app.use('/api', apiKeyRoutes);
app.use('/api', qualityRoutes);
app.use('/api', csatRoutes);
app.use('/api', auditLogRoutes);
app.use('/api', platformAdminRoutes);
app.use('/api', platformIntegrationsStatusRoutes);
app.use('/api', platformConnectorHealthRoutes);
app.use('/api', platformPushHealthRoutes);
app.use('/api', platformBillingHealthRoutes);
app.use('/api', platformCallEventsRetentionRoutes);
app.use('/api', platformPortalConfigCleanupRoutes);
app.use('/api', knowledgeBaseRoutes);
app.use('/api', knowledgeDocumentsRoutes);
app.use('/api', publicApiRoutes);
app.use('/api', mobileApiRoutes);
app.use('/api', widgetRoutes);
app.use('/api', marketplaceRoutes);
app.use('/api', toolExecutionRoutes);
app.use('/api', operationsRoutes);
app.use('/api', improvementsRoutes);
app.use('/api', toolHealthRoutes);
app.use('/api', costOptimizationRoutes);
app.use('/api', callDebugRoutes);
app.use('/api', complianceRoutes);
app.use('/api', platformComplianceRoutes);
app.use('/api', caseStudyRoutes);
app.use('/api', conversionRoutes);
app.use('/api', workflowRoutes);
app.use('/api', smsInboxRoutes);
app.use('/api', schedulingRoutes);
app.use('/api', ticketRoutes);
app.use('/api', dispatchRoutes);
app.use('/api', ingestRoutes);
app.use('/api', legalComplianceRoutes);
app.use('/api', supportRoutes);
app.use('/api', productionEssentialsRoutes);
app.use('/api', voicePreviewRoutes);
app.use('/api', marketingSearchAnalyticsRoutes);

const clientDistPath = path.resolve(__dirname, '../../client-app/dist');

if (isProductionBoot()) {
  attachSpaFallback(app, clientDistPath);
}

app.use(errorHandler);

export default app;
