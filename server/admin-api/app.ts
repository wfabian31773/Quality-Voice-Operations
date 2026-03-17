import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { errorHandler } from './middleware/errorHandler';
import healthRoutes from './routes/health';
import authRoutes from './routes/auth';
import tenantRoutes from './routes/tenants';
import agentRoutes from './routes/agents';
import phoneNumberRoutes from './routes/phoneNumbers';
import callRoutes from './routes/calls';
import userRoutes from './routes/users';
import connectorRoutes from './routes/connectors';
import billingRoutes from './routes/billing';
import campaignRoutes from './routes/campaigns';
import observabilityRoutes from './routes/observability';
import analyticsRoutes from './routes/analytics';
import demoRoutes from './routes/demo';
import apiKeyRoutes from './routes/apiKeys';
import publicApiRoutes from './routes/publicApi';
import qualityRoutes from './routes/quality';
import auditLogRoutes from './routes/auditLog';
import platformAdminRoutes from './routes/platformAdmin';
import callsLiveRoutes from './routes/callsLive';
import contactRoutes from './routes/contact';
import knowledgeBaseRoutes from './routes/knowledgeBase';
import knowledgeDocumentsRoutes from './routes/knowledgeDocuments';
import widgetRoutes from './routes/widget';
import marketplaceRoutes from './routes/marketplace';
import demoLiveRoutes from './routes/demoLive';
import toolExecutionRoutes from './routes/toolExecutions';
import operationsRoutes from './routes/operations';
import websiteAgentRoutes from './routes/websiteAgent';
import assistantRoutes from './routes/assistant';
import insightsRoutes from './routes/insights';
import simulationRoutes from './routes/simulations';
import digitalTwinRoutes from './routes/digitalTwin';
import workforceRoutes from './routes/workforce';
import improvementsRoutes from './routes/improvements';
import autopilotRoutes from './routes/autopilot';
import ginRoutes from './routes/gin';
import commandCenterRoutes from './routes/commandCenter';
import evolutionRoutes from './routes/evolution';
import toolHealthRoutes from './routes/toolHealth';
import costOptimizationRoutes from './routes/costOptimization';
import callDebugRoutes from './routes/callDebug';
import complianceRoutes from './routes/compliance';
import caseStudyRoutes from './routes/caseStudies';
import conversionRoutes from './routes/conversion';
import workflowRoutes from './routes/workflows';
import smsInboxRoutes from './routes/smsInbox';
import schedulingRoutes from './routes/scheduling';
import ticketRoutes from './routes/tickets';
import dispatchRoutes from './routes/dispatch';

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());

app.use(
  '/billing/stripe-webhook',
  express.raw({ type: 'application/json' }),
);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.method !== 'GET' || req.path.includes('auth')) {
    console.log(`[REQ] ${req.method} ${req.path} from ${req.ip}`);
  }
  next();
});

app.use('/', healthRoutes);
app.use('/', authRoutes);


app.use('/', tenantRoutes);
app.use('/', agentRoutes);
app.use('/', phoneNumberRoutes);
app.use('/', callsLiveRoutes);
app.use('/', callRoutes);
app.use('/', userRoutes);
app.use('/', connectorRoutes);
app.use('/', billingRoutes);
app.use('/', campaignRoutes);
app.use('/', observabilityRoutes);
app.use('/', analyticsRoutes);
app.use('/', demoRoutes);
app.use('/', demoLiveRoutes);
app.use('/', contactRoutes);
app.use('/', apiKeyRoutes);
app.use('/', qualityRoutes);
app.use('/', auditLogRoutes);
app.use('/', platformAdminRoutes);
app.use('/', knowledgeBaseRoutes);
app.use('/', knowledgeDocumentsRoutes);
app.use('/', publicApiRoutes);
app.use('/', widgetRoutes);
app.use('/', marketplaceRoutes);
app.use('/', toolExecutionRoutes);
app.use('/', operationsRoutes);
app.use('/', websiteAgentRoutes);
app.use('/', assistantRoutes);
app.use('/', insightsRoutes);
app.use('/', simulationRoutes);
app.use('/', digitalTwinRoutes);
app.use('/', workforceRoutes);
app.use('/', improvementsRoutes);
app.use('/', autopilotRoutes);
app.use('/', ginRoutes);
app.use('/', commandCenterRoutes);
app.use('/', evolutionRoutes);
app.use('/', toolHealthRoutes);
app.use('/', costOptimizationRoutes);
app.use('/', callDebugRoutes);
app.use('/', complianceRoutes);
app.use('/', caseStudyRoutes);
app.use('/', conversionRoutes);
app.use('/', workflowRoutes);
app.use('/', smsInboxRoutes);
app.use('/', schedulingRoutes);
app.use('/', ticketRoutes);
app.use('/', dispatchRoutes);

const isProduction = process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production';
const clientDistPath = path.resolve(__dirname, '../../client-app/dist');

if (isProduction && fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));

  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

app.use(errorHandler);

export default app;
