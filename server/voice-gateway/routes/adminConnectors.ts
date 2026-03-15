import { Router, type Request, type Response, type NextFunction } from 'express';
import { listConnectorConfigs, upsertConnector, deleteConnector } from '../../../platform/integrations/connectors';
import type { ConnectorType } from '../../../platform/integrations/connectors';
import type { TenantId } from '../../../platform/core/types';
import { createLogger } from '../../../platform/core/logger';

const VALID_CONNECTOR_TYPES = new Set<ConnectorType>([
  'ticketing', 'sms', 'crm', 'scheduling', 'ehr', 'email', 'webhook', 'custom',
]);

const router = Router();
const logger = createLogger('ADMIN_CONNECTORS');

const IS_PROD = (process.env.APP_ENV ?? process.env.NODE_ENV ?? '').startsWith('prod');

function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  const adminToken = process.env.ADMIN_INTERNAL_TOKEN;

  if (!adminToken) {
    logger.error('ADMIN_INTERNAL_TOKEN not configured — rejecting admin request');
    res.status(503).json({ error: 'Admin endpoint not available: missing server configuration' });
    return;
  }

  const provided = req.headers['x-admin-token'];
  if (provided !== adminToken) {
    logger.warn('Admin request rejected: invalid token', { ip: req.ip });
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  next();
}

router.use('/admin', requireAdminToken);

router.get('/admin/connectors', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  if (typeof tenantId !== 'string' || !tenantId) {
    return res.status(400).json({ error: 'x-tenant-id header required' });
  }

  try {
    const connectors = await listConnectorConfigs(tenantId as TenantId);
    return res.json({ connectors });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('Failed to list connectors', { tenantId, error });
    return res.status(500).json({ error: 'Failed to list connectors' });
  }
});

router.post('/admin/connectors', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  if (typeof tenantId !== 'string' || !tenantId) {
    return res.status(400).json({ error: 'x-tenant-id header required' });
  }

  const { connectorType, provider, name, credentials, isEnabled } = req.body as {
    connectorType?: string;
    provider?: string;
    name?: string;
    credentials?: Record<string, string>;
    isEnabled?: boolean;
  };

  if (!connectorType || !provider || !name || !credentials) {
    return res.status(400).json({
      error: 'Fields required: connectorType, provider, name, credentials',
    });
  }

  if (!VALID_CONNECTOR_TYPES.has(connectorType as ConnectorType)) {
    return res.status(400).json({
      error: `Invalid connectorType '${connectorType}'. Allowed: ${[...VALID_CONNECTOR_TYPES].join(', ')}`,
    });
  }

  try {
    const integrationId = await upsertConnector(tenantId as TenantId, {
      connectorType: connectorType as ConnectorType,
      provider,
      name,
      credentials,
      isEnabled: isEnabled ?? true,
    });
    logger.info('Connector upserted via admin API', { tenantId, connectorType, provider, integrationId });
    return res.status(201).json({ integrationId });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('Failed to upsert connector', { tenantId, error });
    return res.status(500).json({ error: 'Failed to upsert connector' });
  }
});

router.delete('/admin/connectors/:integrationId', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  if (typeof tenantId !== 'string' || !tenantId) {
    return res.status(400).json({ error: 'x-tenant-id header required' });
  }

  const { integrationId } = req.params;
  if (!integrationId) {
    return res.status(400).json({ error: 'integrationId path param required' });
  }

  try {
    await deleteConnector(tenantId as TenantId, integrationId);
    logger.info('Connector deleted via admin API', { tenantId, integrationId });
    return res.json({ deleted: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('Failed to delete connector', { tenantId, error });
    return res.status(500).json({ error: 'Failed to delete connector' });
  }
});

export default router;
