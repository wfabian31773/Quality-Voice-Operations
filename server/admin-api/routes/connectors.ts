import { Router } from 'express';
import {
  listConnectorConfigs,
  upsertConnector,
  deleteConnector,
  getConnectorById,
  getConnectorConfig,
  connectorService,
} from '../../../platform/integrations/connectors';
import type { ConnectorType, StandardEventType } from '../../../platform/integrations/connectors';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';
import { fetchSalesforceTaskPicklists } from '../../../platform/integrations/connectors/adapters/salesforce';
import { fetchHubSpotDealPipelines } from '../../../platform/integrations/connectors/adapters/hubspot';
import { fetchPipedrivePipelinesAndStages } from '../../../platform/integrations/connectors/adapters/pipedrive';

const router = Router();
const logger = createLogger('ADMIN_CONNECTORS');

const VALID_CONNECTOR_TYPES = new Set<ConnectorType>([
  'ticketing', 'sms', 'crm', 'scheduling', 'ehr', 'email', 'webhook', 'custom', 'accounting',
]);

function paginate(req: { query: Record<string, unknown> }): { limit: number; offset: number } {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  return { limit, offset: (page - 1) * limit };
}

router.get('/connectors', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  try {
    const allConnectors = await listConnectorConfigs(tenantId);
    const total = allConnectors.length;
    const connectors = allConnectors.slice(offset, offset + limit);
    return res.json({ connectors, total, limit, offset });
  } catch (err) {
    logger.error('Failed to list connectors', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list connectors' });
  }
});

router.post('/connectors', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const {
    connectorType,
    provider,
    name,
    credentials,
    credentialsToDelete,
    isEnabled = true,
  } = req.body as {
    connectorType?: string;
    provider?: string;
    name?: string;
    credentials?: Record<string, string>;
    credentialsToDelete?: string[];
    isEnabled?: boolean;
  };

  if (!connectorType || !provider || !name || !credentials) {
    return res.status(400).json({ error: 'connectorType, provider, name, credentials are required' });
  }
  if (!VALID_CONNECTOR_TYPES.has(connectorType as ConnectorType)) {
    return res.status(400).json({
      error: `Invalid connectorType. Allowed: ${[...VALID_CONNECTOR_TYPES].join(', ')}`,
    });
  }
  const sanitizedCredentialsToDelete = Array.isArray(credentialsToDelete)
    ? credentialsToDelete.filter((k): k is string => typeof k === 'string' && k.length > 0)
    : undefined;

  try {
    const integrationId = await upsertConnector(tenantId, {
      connectorType: connectorType as ConnectorType,
      provider,
      name,
      credentials,
      credentialsToDelete: sanitizedCredentialsToDelete,
      isEnabled,
    });
    logger.info('Connector upserted', { tenantId, connectorType, provider, integrationId });
    writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'connector.created',
      resourceType: 'connector',
      resourceId: integrationId,
      changes: { connectorType, provider, name },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    import('../../../platform/activation/ActivationService')
      .then(({ recordActivationEvent }) => recordActivationEvent(tenantId, 'tenant_tools_connected', { connectorType, provider }))
      .catch(() => {});
    return res.status(201).json({ integrationId });
  } catch (err) {
    logger.error('Failed to upsert connector', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to upsert connector' });
  }
});

router.patch('/connectors/:integrationId', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { integrationId } = req.params;
  const { credentials, credentialsToDelete, isEnabled, name } = req.body as {
    credentials?: Record<string, string>;
    credentialsToDelete?: string[];
    isEnabled?: boolean;
    name?: string;
  };

  try {
    const existing = await getConnectorById(tenantId, integrationId);
    if (!existing) {
      return res.status(404).json({ error: 'Connector not found' });
    }

    const sanitizedCredentialsToDelete = Array.isArray(credentialsToDelete)
      ? credentialsToDelete.filter((k): k is string => typeof k === 'string' && k.length > 0)
      : undefined;

    await upsertConnector(tenantId, {
      connectorType: existing.connectorType,
      provider: existing.provider,
      name: name ?? existing.name,
      credentials: credentials ?? {},
      credentialsToDelete: sanitizedCredentialsToDelete,
      isEnabled: isEnabled ?? existing.isEnabled,
    });

    return res.json({ updated: true });
  } catch (err) {
    logger.error('Failed to update connector', { tenantId, integrationId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update connector' });
  }
});

router.get('/connectors/:integrationId/settings', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { integrationId } = req.params;
  try {
    const meta = await getConnectorById(tenantId, integrationId);
    if (!meta) {
      return res.status(404).json({ error: 'Connector not found' });
    }
    const fullConfig = await getConnectorConfig(tenantId, meta.connectorType, meta.provider);
    const credentials = fullConfig?.credentials ?? {};
    const settings: Record<string, unknown> = {};
    if (meta.provider === 'salesforce' || meta.provider === 'hubspot' || meta.provider === 'pipedrive') {
      const raw = credentials.disposition_map;
      let dispositionMap: unknown = null;
      let dispositionMapError: string | null = null;
      if (raw && raw.trim()) {
        try {
          dispositionMap = JSON.parse(raw);
        } catch (err) {
          dispositionMapError = err instanceof Error ? err.message : String(err);
        }
      }
      settings.dispositionMap = dispositionMap;
      settings.dispositionMapError = dispositionMapError;

      const leadStatusRaw = credentials.lead_status_map;
      let leadStatusMap: unknown = null;
      let leadStatusMapError: string | null = null;
      if (leadStatusRaw && leadStatusRaw.trim()) {
        try {
          leadStatusMap = JSON.parse(leadStatusRaw);
        } catch (err) {
          leadStatusMapError = err instanceof Error ? err.message : String(err);
        }
      }
      settings.leadStatusMap = leadStatusMap;
      settings.leadStatusMapError = leadStatusMapError;
    }
    if (meta.provider === 'hubspot') {
      const appointmentPipelineId = credentials.appointment_pipeline_id ?? null;
      const appointmentStageId = credentials.appointment_stage_id ?? null;
      settings.appointmentPipelineId = appointmentPipelineId;
      settings.appointmentStageId = appointmentStageId;
      if (fullConfig && (appointmentPipelineId || appointmentStageId)) {
        try {
          const pipelines = await fetchHubSpotDealPipelines(tenantId, fullConfig);
          const pipeline = appointmentPipelineId
            ? pipelines.find((p) => p.id === appointmentPipelineId) ?? null
            : null;
          const stage = pipeline && appointmentStageId
            ? pipeline.stages.find((s) => s.id === appointmentStageId) ?? null
            : null;
          settings.appointmentPipelineLabel = pipeline?.label ?? null;
          settings.appointmentStageLabel = stage?.label ?? null;
          settings.pipelineLookupError = null;
        } catch (err) {
          settings.appointmentPipelineLabel = null;
          settings.appointmentStageLabel = null;
          settings.pipelineLookupError = err instanceof Error ? err.message : String(err);
        }
      } else {
        settings.appointmentPipelineLabel = null;
        settings.appointmentStageLabel = null;
        settings.pipelineLookupError = null;
      }
    }
    if (meta.provider === 'pipedrive') {
      const appointmentStageId = credentials.appointment_stage_id ?? null;
      const defaultPipelineId = credentials.default_pipeline_id ?? null;
      const defaultStageId = credentials.default_stage_id ?? null;
      settings.appointmentStageId = appointmentStageId;
      settings.defaultPipelineId = defaultPipelineId;
      settings.defaultStageId = defaultStageId;
      if (fullConfig && (defaultPipelineId || defaultStageId || appointmentStageId)) {
        try {
          const pipelines = await fetchPipedrivePipelinesAndStages(tenantId, fullConfig);
          const defaultPipelineNum = defaultPipelineId ? Number(defaultPipelineId) : NaN;
          const pipeline = Number.isFinite(defaultPipelineNum)
            ? pipelines.find((p) => p.id === defaultPipelineNum) ?? null
            : null;
          const defaultStageNum = defaultStageId ? Number(defaultStageId) : NaN;
          const appointmentStageNum = appointmentStageId ? Number(appointmentStageId) : NaN;
          const defaultStage = pipeline && Number.isFinite(defaultStageNum)
            ? pipeline.stages.find((s) => s.id === defaultStageNum) ?? null
            : null;
          const appointmentStage = pipeline && Number.isFinite(appointmentStageNum)
            ? pipeline.stages.find((s) => s.id === appointmentStageNum) ?? null
            : null;
          settings.defaultPipelineLabel = pipeline?.name ?? null;
          settings.defaultStageLabel = defaultStage?.name ?? null;
          settings.appointmentStageLabel = appointmentStage?.name ?? null;
          settings.pipelineLookupError = null;
        } catch (err) {
          settings.defaultPipelineLabel = null;
          settings.defaultStageLabel = null;
          settings.appointmentStageLabel = null;
          settings.pipelineLookupError = err instanceof Error ? err.message : String(err);
        }
      } else {
        settings.defaultPipelineLabel = null;
        settings.defaultStageLabel = null;
        settings.appointmentStageLabel = null;
        settings.pipelineLookupError = null;
      }
    }
    return res.json({ provider: meta.provider, settings });
  } catch (err) {
    logger.error('Failed to read connector settings', { tenantId, integrationId, error: String(err) });
    return res.status(500).json({ error: 'Failed to read connector settings' });
  }
});

router.get('/connectors/:integrationId/salesforce/picklists', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { integrationId } = req.params;
  try {
    const meta = await getConnectorById(tenantId, integrationId);
    if (!meta) {
      return res.status(404).json({ error: 'Connector not found' });
    }
    if (meta.provider !== 'salesforce') {
      return res.status(400).json({ error: 'Picklist describe is only available for Salesforce connectors' });
    }
    const config = await getConnectorConfig(tenantId, meta.connectorType, meta.provider);
    if (!config) {
      return res.status(404).json({ error: 'Salesforce connector configuration not found' });
    }
    const picklists = await fetchSalesforceTaskPicklists(tenantId, config);
    return res.json(picklists);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to fetch Salesforce Task picklists', { tenantId, integrationId, error: message });
    return res.status(502).json({ error: message });
  }
});

router.get('/connectors/:integrationId/hubspot/pipelines', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { integrationId } = req.params;
  try {
    const meta = await getConnectorById(tenantId, integrationId);
    if (!meta) {
      return res.status(404).json({ error: 'Connector not found' });
    }
    if (meta.provider !== 'hubspot') {
      return res.status(400).json({ error: 'Pipeline fetch is only available for HubSpot connectors' });
    }
    const config = await getConnectorConfig(tenantId, meta.connectorType, meta.provider);
    if (!config) {
      return res.status(404).json({ error: 'HubSpot connector configuration not found' });
    }
    const pipelines = await fetchHubSpotDealPipelines(tenantId, config);
    return res.json({ pipelines });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to fetch HubSpot pipelines', { tenantId, integrationId, error: message });
    return res.status(502).json({ error: message });
  }
});

router.get('/connectors/:integrationId/pipedrive/pipelines', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { integrationId } = req.params;
  try {
    const meta = await getConnectorById(tenantId, integrationId);
    if (!meta) {
      return res.status(404).json({ error: 'Connector not found' });
    }
    if (meta.provider !== 'pipedrive') {
      return res.status(400).json({ error: 'Pipeline fetch is only available for Pipedrive connectors' });
    }
    const config = await getConnectorConfig(tenantId, meta.connectorType, meta.provider);
    if (!config) {
      return res.status(404).json({ error: 'Pipedrive connector configuration not found' });
    }
    const pipelines = await fetchPipedrivePipelinesAndStages(tenantId, config);
    return res.json({ pipelines });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to fetch Pipedrive pipelines', { tenantId, integrationId, error: message });
    return res.status(502).json({ error: message });
  }
});

router.delete('/connectors/:integrationId', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { integrationId } = req.params;

  try {
    await deleteConnector(tenantId, integrationId);
    logger.info('Connector deleted', { tenantId, integrationId });
    writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'connector.deleted',
      resourceType: 'connector',
      resourceId: integrationId,
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.json({ deleted: true });
  } catch (err) {
    logger.error('Failed to delete connector', { tenantId, integrationId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete connector' });
  }
});

router.post('/connectors/events/dispatch', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { eventType, payload } = req.body as {
    eventType?: string;
    payload?: Record<string, unknown>;
  };

  const validEvents = new Set(['call.completed', 'appointment.booked', 'sms.sent', 'ticket.created', 'call.missed']);
  if (!eventType || !validEvents.has(eventType)) {
    return res.status(400).json({ error: `Invalid eventType. Allowed: ${[...validEvents].join(', ')}` });
  }

  try {
    const result = await connectorService.dispatchEvent(
      tenantId,
      eventType as StandardEventType,
      { type: eventType, ...payload },
    );
    return res.json(result);
  } catch (err) {
    logger.error('Failed to dispatch event', { tenantId, eventType, error: String(err) });
    return res.status(500).json({ error: 'Failed to dispatch event' });
  }
});

export default router;
