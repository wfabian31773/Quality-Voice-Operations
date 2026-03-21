import { Router } from 'express';
import {
  listConnectorConfigs,
  upsertConnector,
  deleteConnector,
  getConnectorById,
  connectorService,
} from '../../../platform/integrations/connectors';
import type { ConnectorType, StandardEventType } from '../../../platform/integrations/connectors';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';

const router = Router();
const logger = createLogger('ADMIN_CONNECTORS');

const VALID_CONNECTOR_TYPES = new Set<ConnectorType>([
  'ticketing', 'sms', 'crm', 'scheduling', 'ehr', 'email', 'webhook', 'custom',
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
  const { connectorType, provider, name, credentials, isEnabled = true } = req.body as {
    connectorType?: string;
    provider?: string;
    name?: string;
    credentials?: Record<string, string>;
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

  try {
    const integrationId = await upsertConnector(tenantId, {
      connectorType: connectorType as ConnectorType,
      provider,
      name,
      credentials,
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
  const { credentials, isEnabled, name } = req.body as {
    credentials?: Record<string, string>;
    isEnabled?: boolean;
    name?: string;
  };

  try {
    const existing = await getConnectorById(tenantId, integrationId);
    if (!existing) {
      return res.status(404).json({ error: 'Connector not found' });
    }

    await upsertConnector(tenantId, {
      connectorType: existing.connectorType,
      provider: existing.provider,
      name: name ?? existing.name,
      credentials: credentials ?? {},
      isEnabled: isEnabled ?? existing.isEnabled,
    });

    return res.json({ updated: true });
  } catch (err) {
    logger.error('Failed to update connector', { tenantId, integrationId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update connector' });
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
