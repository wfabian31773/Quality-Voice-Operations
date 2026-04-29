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
import { fetchGoogleCalendarList } from '../../../platform/integrations/connectors/adapters/google-calendar';
import { fetchOutlookCalendarList } from '../../../platform/integrations/connectors/adapters/outlook-calendar';
import { resolveZohoApiDomain, resolveZohoAccountsServer } from '../../../platform/integrations/connectors/zohoRegion';

const router = Router();
const logger = createLogger('ADMIN_CONNECTORS');

const VALID_CONNECTOR_TYPES = new Set<ConnectorType>([
  'ticketing', 'sms', 'crm', 'scheduling', 'ehr', 'email', 'webhook', 'custom', 'accounting',
]);

/**
 * Provider-specific guards for tenant-supplied credentials. Today this only
 * locks down Zoho's region/host fields, which are used as the base URL for
 * privileged outbound calls (OAuth token + CRM data) and would otherwise be
 * a tenant-controlled SSRF / token-exfiltration primitive.
 *
 * Returns `null` when the credentials are acceptable, or a human-readable
 * error string to surface to the caller.
 */
function validateProviderSpecificCredentials(
  provider: string,
  credentials: Record<string, string>,
): string | null {
  if (provider !== 'zoho') return null;
  if (typeof credentials.api_domain === 'string' && credentials.api_domain.trim() !== '') {
    if (!resolveZohoApiDomain(credentials.api_domain)) {
      return 'api_domain is not a recognized Zoho API host. Reconnect via OAuth to set it.';
    }
  }
  if (typeof credentials.accounts_server === 'string' && credentials.accounts_server.trim() !== '') {
    if (!resolveZohoAccountsServer(credentials.accounts_server)) {
      return 'accounts_server is not a recognized Zoho accounts host. Reconnect via OAuth to set it.';
    }
  }
  return null;
}

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

/**
 * Outage alert audit history. Surfaces the per-tenant connector escalation
 * trail recorded in `tenant_notifications` (types `integration` and
 * `integration_sms`) so admins can answer "did anyone get paged for that
 * outage?" without reading server logs.
 *
 * The alerter fans each alert out as one row per opted-in user, so we
 * collapse rows that belong to the same dispatch (same integration + type +
 * minute bucket) and report the in-app recipient count alongside the
 * email/SMS metadata stored on the alert. Tenant-scoped via req.user.
 */
router.get('/connectors/alerts', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  const integrationFilter =
    typeof req.query.integrationId === 'string' && req.query.integrationId.trim() !== ''
      ? req.query.integrationId.trim()
      : null;

  try {
    const { getPlatformPool } = await import('../../../platform/db');
    const pool = getPlatformPool();

    // Group fanned-out per-user rows back into a single alert event keyed by
    // (integrationId, type, minute). MIN(created_at) anchors the event time;
    // MAX(metadata) is safe because every per-user row in a single fan-out
    // carries identical metadata (the alerter computes the JSON once and
    // reuses it for every INSERT).
    const params: unknown[] = [tenantId];
    let integrationClause = '';
    if (integrationFilter) {
      params.push(integrationFilter);
      integrationClause = `AND metadata->>'integrationId' = $${params.length}`;
    }

    const totalQuery = `
      SELECT COUNT(*)::bigint AS total FROM (
        SELECT 1
          FROM tenant_notifications
         WHERE tenant_id = $1
           AND type IN ('integration', 'integration_sms')
           AND metadata->>'integrationId' IS NOT NULL
           ${integrationClause}
         GROUP BY metadata->>'integrationId', type, date_trunc('minute', created_at)
      ) t
    `;
    const totalResult = await pool.query<{ total: string }>(totalQuery, params);
    const total = Number(totalResult.rows[0]?.total ?? 0);

    params.push(limit);
    params.push(offset);
    const limitParam = params.length - 1;
    const offsetParam = params.length;

    const rowsQuery = `
      SELECT
        metadata->>'integrationId'                AS integration_id,
        type,
        MIN(created_at)                           AS created_at,
        COUNT(*)::int                             AS in_app_recipients,
        (array_agg(metadata ORDER BY created_at))[1] AS metadata,
        (array_agg(title    ORDER BY created_at))[1] AS title,
        (array_agg(message  ORDER BY created_at))[1] AS message
      FROM tenant_notifications
      WHERE tenant_id = $1
        AND type IN ('integration', 'integration_sms')
        AND metadata->>'integrationId' IS NOT NULL
        ${integrationClause}
      GROUP BY metadata->>'integrationId', type, date_trunc('minute', created_at)
      ORDER BY MIN(created_at) DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `;
    const { rows } = await pool.query(rowsQuery, params);

    // Resolve integration -> connector display name in one round-trip so the
    // UI doesn't have to guess from the raw provider slug.
    const integrationIds = Array.from(
      new Set(rows.map((r) => r.integration_id as string).filter(Boolean)),
    );
    const nameByIntegration = new Map<string, string>();
    if (integrationIds.length > 0) {
      const { rows: nameRows } = await pool.query<{ id: string; name: string | null }>(
        `SELECT id, name FROM integrations
          WHERE tenant_id = $1 AND id = ANY($2::text[])`,
        [tenantId, integrationIds],
      );
      for (const r of nameRows) {
        if (r.name) nameByIntegration.set(r.id, r.name);
      }
    }

    const alerts = rows.map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const integrationId = (r.integration_id as string) ?? '';
      const channel = r.type === 'integration_sms' ? 'sms' : 'email';
      // Email rows store the emailed recipient count under
      // `recipientCount`/`emailRecipientCount`. SMS rows store the SMS
      // recipient count under `recipientCount`. Fall back to the in-app
      // fan-out row count for older email alerts that pre-date the
      // metadata enrichment.
      const recordedRecipientCount =
        typeof meta.recipientCount === 'number'
          ? meta.recipientCount
          : typeof meta.emailRecipientCount === 'number'
            ? (meta.emailRecipientCount as number)
            : null;
      return {
        id: `${integrationId}:${r.type}:${new Date(r.created_at).getTime()}`,
        integrationId,
        integrationName: nameByIntegration.get(integrationId) ?? null,
        provider: (meta.provider as string | undefined) ?? null,
        connectorType: (meta.connectorType as string | undefined) ?? null,
        type: r.type as string,
        channel,
        title: r.title as string | null,
        message: r.message as string | null,
        createdAt: new Date(r.created_at).toISOString(),
        recipientCount:
          recordedRecipientCount ?? (r.in_app_recipients as number) ?? null,
        inAppRecipientCount: (r.in_app_recipients as number) ?? 0,
        outageMinutes:
          typeof meta.outageMinutes === 'number' ? (meta.outageMinutes as number) : null,
        firstFailedAt: (meta.firstFailedAt as string | null) ?? null,
        errorMessage: (meta.errorMessage as string | null) ?? null,
        smsAttempted:
          typeof meta.smsAttempted === 'number' ? (meta.smsAttempted as number) : null,
        smsSucceeded:
          typeof meta.smsSucceeded === 'number' ? (meta.smsSucceeded as number) : null,
        twilioConfigured:
          typeof meta.twilioConfigured === 'boolean'
            ? (meta.twilioConfigured as boolean)
            : null,
        // Present on alerts dispatched after migration 094. The detail
        // endpoint uses this to load per-recipient delivery rows; older
        // alerts without it fall back to "no per-recipient data on file".
        dispatchId: (meta.dispatchId as string | undefined) ?? null,
      };
    });

    return res.json({ alerts, total, limit, offset });
  } catch (err) {
    logger.error('Failed to list connector outage alerts', {
      tenantId,
      error: String(err),
    });
    return res.status(500).json({ error: 'Failed to list connector outage alerts' });
  }
});

/**
 * Outage alert detail view. Sibling to GET /connectors/alerts: takes the
 * composite alert id from the listing endpoint
 * (`${integrationId}:${type}:${createdAtMs}`) and returns:
 *
 *   - The full alert metadata (title, message, error trace, outage timing).
 *   - Every individual recipient the alert was fanned out to (name +
 *     email/phone) and, for SMS rows, whether Twilio actually accepted the
 *     send (per-recipient delivery status), persisted by SyncErrorAlerter
 *     to `connector_alert_recipients` and pivoted via dispatch_id.
 *   - The current connector context (lastSyncErrorAt, lastSyncError,
 *     lastSyncStatus, lastSyncAt) so admins can audit the incident
 *     end-to-end without leaving the page.
 *
 * Older alerts written before migration 094 carry no dispatchId in
 * metadata, so the recipients list comes back empty and the response
 * carries `recipientsAvailable: false` to let the UI render an explanatory
 * "no per-recipient data on file" empty state.
 *
 * Tenant-scoped via req.user — every query filters by req.user.tenantId so
 * a tenant can never see another tenant's alert detail.
 */
router.get('/connectors/alerts/:alertId', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { alertId } = req.params;

  // Composite id format: `<integrationId>:<type>:<createdAtMs>`.
  // integrationId is a UUID with no colons; type is 'integration' or
  // 'integration_sms'; created_at is a numeric ms timestamp. We split on
  // the last two colons so any future colons in integrationId would still
  // parse correctly (today they don't appear).
  const parts = alertId.split(':');
  if (parts.length < 3) {
    return res.status(400).json({ error: 'Invalid alert id format' });
  }
  const createdAtMsStr = parts[parts.length - 1];
  const type = parts[parts.length - 2];
  const integrationId = parts.slice(0, parts.length - 2).join(':');
  const createdAtMs = Number(createdAtMsStr);
  if (
    !integrationId ||
    (type !== 'integration' && type !== 'integration_sms') ||
    !Number.isFinite(createdAtMs)
  ) {
    return res.status(400).json({ error: 'Invalid alert id format' });
  }

  try {
    const { getPlatformPool } = await import('../../../platform/db');
    const pool = getPlatformPool();

    // 1. Re-aggregate the alert event from tenant_notifications so we can
    //    return the same metadata + counts the listing endpoint shows. We
    //    match by (integration_id, type, minute bucket) and tenant scope.
    const minuteIso = new Date(createdAtMs - (createdAtMs % 60000)).toISOString();
    const { rows: alertRows } = await pool.query<{
      created_at: string;
      in_app_recipients: number;
      metadata: Record<string, unknown> | null;
      title: string | null;
      message: string | null;
    }>(
      `SELECT
         MIN(created_at)                              AS created_at,
         COUNT(*)::int                                AS in_app_recipients,
         (array_agg(metadata ORDER BY created_at))[1] AS metadata,
         (array_agg(title    ORDER BY created_at))[1] AS title,
         (array_agg(message  ORDER BY created_at))[1] AS message
        FROM tenant_notifications
       WHERE tenant_id = $1
         AND type = $2
         AND metadata->>'integrationId' = $3
         AND date_trunc('minute', created_at) = date_trunc('minute', $4::timestamptz)
       GROUP BY metadata->>'integrationId', type, date_trunc('minute', created_at)
       LIMIT 1`,
      [tenantId, type, integrationId, minuteIso],
    );
    if (alertRows.length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    const alert = alertRows[0];
    const meta = (alert.metadata ?? {}) as Record<string, unknown>;
    const dispatchId = (meta.dispatchId as string | undefined) ?? null;
    const channel = type === 'integration_sms' ? 'sms' : 'email';

    // 2. Per-recipient delivery rows persisted by SyncErrorAlerter. Only
    //    available for alerts dispatched after migration 094.
    let recipients: Array<{
      userId: string | null;
      name: string | null;
      email: string | null;
      phone: string | null;
      deliveryStatus: string;
      deliveryError: string | null;
      twilioStatusCode: number | null;
      dispatchedAt: string;
    }> = [];
    let recipientsAvailable = false;
    if (dispatchId) {
      recipientsAvailable = true;
      const { rows: recipientRows } = await pool.query<{
        user_id: string | null;
        recipient_name: string | null;
        recipient_email: string | null;
        recipient_phone: string | null;
        delivery_status: string;
        delivery_error: string | null;
        twilio_status_code: number | null;
        dispatched_at: string;
      }>(
        `SELECT user_id, recipient_name, recipient_email, recipient_phone,
                delivery_status, delivery_error, twilio_status_code, dispatched_at
           FROM connector_alert_recipients
          WHERE tenant_id = $1
            AND dispatch_id = $2
          ORDER BY dispatched_at, id`,
        [tenantId, dispatchId],
      );
      recipients = recipientRows.map((r) => ({
        userId: r.user_id,
        name: r.recipient_name,
        email: r.recipient_email,
        phone: r.recipient_phone,
        deliveryStatus: r.delivery_status,
        deliveryError: r.delivery_error,
        twilioStatusCode: r.twilio_status_code,
        dispatchedAt: new Date(r.dispatched_at).toISOString(),
      }));
    }

    // 3. Current connector context. We pull lastSyncError + lastSyncErrorAt
    //    so admins can correlate the alert with the connector's most
    //    recent failure trace, plus lastSyncAt + lastSyncStatus so they
    //    can see whether the integration has since recovered. The row
    //    may be missing if the integration was deleted post-alert; we
    //    return null in that case rather than 404 (the alert audit trail
    //    survives integration deletes).
    let integration: {
      id: string;
      name: string | null;
      provider: string | null;
      connectorType: string | null;
      lastSyncAt: string | null;
      lastSyncStatus: string | null;
      lastSyncError: string | null;
      lastSyncErrorAt: string | null;
    } | null = null;
    const { rows: integrationRows } = await pool.query<{
      id: string;
      name: string | null;
      provider: string | null;
      connector_type: string | null;
      last_sync_at: string | null;
      last_sync_status: string | null;
      last_sync_error: string | null;
      last_sync_error_at: string | null;
    }>(
      `SELECT id, name, provider, connector_type,
              last_sync_at, last_sync_status, last_sync_error, last_sync_error_at
         FROM integrations
        WHERE tenant_id = $1 AND id = $2
        LIMIT 1`,
      [tenantId, integrationId],
    );
    if (integrationRows.length > 0) {
      const r = integrationRows[0];
      integration = {
        id: r.id,
        name: r.name,
        provider: r.provider,
        connectorType: r.connector_type,
        lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
        lastSyncStatus: r.last_sync_status,
        lastSyncError: r.last_sync_error,
        lastSyncErrorAt: r.last_sync_error_at
          ? new Date(r.last_sync_error_at).toISOString()
          : null,
      };
    }

    return res.json({
      id: alertId,
      integrationId,
      integrationName: integration?.name ?? null,
      provider:
        (meta.provider as string | undefined) ?? integration?.provider ?? null,
      connectorType:
        (meta.connectorType as string | undefined) ?? integration?.connectorType ?? null,
      type,
      channel,
      title: alert.title,
      message: alert.message,
      createdAt: new Date(alert.created_at).toISOString(),
      inAppRecipientCount: alert.in_app_recipients ?? 0,
      recipientCount:
        typeof meta.recipientCount === 'number'
          ? (meta.recipientCount as number)
          : typeof meta.emailRecipientCount === 'number'
            ? (meta.emailRecipientCount as number)
            : (alert.in_app_recipients ?? null),
      outageMinutes:
        typeof meta.outageMinutes === 'number' ? (meta.outageMinutes as number) : null,
      firstFailedAt: (meta.firstFailedAt as string | null) ?? null,
      errorMessage: (meta.errorMessage as string | null) ?? null,
      smsAttempted:
        typeof meta.smsAttempted === 'number' ? (meta.smsAttempted as number) : null,
      smsSucceeded:
        typeof meta.smsSucceeded === 'number' ? (meta.smsSucceeded as number) : null,
      twilioConfigured:
        typeof meta.twilioConfigured === 'boolean'
          ? (meta.twilioConfigured as boolean)
          : null,
      reconnectLink: (meta.link as string | undefined) ?? null,
      dispatchId,
      recipientsAvailable,
      recipients,
      integration,
    });
  } catch (err) {
    logger.error('Failed to load connector outage alert detail', {
      tenantId,
      alertId,
      error: String(err),
    });
    return res.status(500).json({ error: 'Failed to load connector outage alert detail' });
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
  const credsValidationError = validateProviderSpecificCredentials(provider, credentials);
  if (credsValidationError) {
    return res.status(400).json({ error: credsValidationError });
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

    if (credentials) {
      const credsValidationError = validateProviderSpecificCredentials(existing.provider, credentials);
      if (credsValidationError) {
        return res.status(400).json({ error: credsValidationError });
      }
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
    if (meta.provider === 'salesforce' || meta.provider === 'hubspot' || meta.provider === 'pipedrive' || meta.provider === 'zoho') {
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
    if (meta.provider === 'zoho') {
      settings.appointmentPipelineId = credentials.appointment_pipeline_id ?? null;
      settings.appointmentStageId = credentials.appointment_stage_id ?? null;
    }
    if (meta.provider === 'google-calendar' || meta.provider === 'outlook-calendar') {
      const rawCalendarId = typeof credentials.calendar_id === 'string' ? credentials.calendar_id.trim() : '';
      const calendarId = rawCalendarId === '' ? null : rawCalendarId;
      const timezone = typeof credentials.timezone === 'string' && credentials.timezone.trim() !== ''
        ? credentials.timezone.trim()
        : null;
      settings.calendarId = calendarId;
      settings.timezone = timezone;

      const isPrimary = !calendarId || calendarId.toLowerCase() === 'primary';
      if (isPrimary) {
        settings.calendarLabel = null;
        settings.calendarLookupError = null;
      } else if (!fullConfig) {
        settings.calendarLabel = null;
        settings.calendarLookupError = null;
      } else {
        try {
          const list = meta.provider === 'google-calendar'
            ? await fetchGoogleCalendarList(tenantId, fullConfig)
            : await fetchOutlookCalendarList(tenantId, fullConfig);
          const match = list.find((c) => c.id === calendarId);
          settings.calendarLabel = match?.name ?? null;
          settings.calendarLookupError = null;
        } catch (err) {
          settings.calendarLabel = null;
          settings.calendarLookupError = err instanceof Error ? err.message : String(err);
        }
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

router.get('/connectors/:integrationId/google-calendar/calendars', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { integrationId } = req.params;
  try {
    const meta = await getConnectorById(tenantId, integrationId);
    if (!meta) {
      return res.status(404).json({ error: 'Connector not found' });
    }
    if (meta.provider !== 'google-calendar') {
      return res.status(400).json({ error: 'Calendar fetch is only available for Google Calendar connectors' });
    }
    const config = await getConnectorConfig(tenantId, meta.connectorType, meta.provider);
    if (!config) {
      return res.status(404).json({ error: 'Google Calendar connector configuration not found' });
    }
    const calendars = await fetchGoogleCalendarList(tenantId, config);
    const sorted = [...calendars].sort((a, b) => {
      if (a.primary && !b.primary) return -1;
      if (!a.primary && b.primary) return 1;
      return a.name.localeCompare(b.name);
    });
    return res.json({ calendars: sorted });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to fetch Google calendars', { tenantId, integrationId, error: message });
    return res.status(502).json({ error: message });
  }
});

router.get('/connectors/:integrationId/outlook-calendar/calendars', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { integrationId } = req.params;
  try {
    const meta = await getConnectorById(tenantId, integrationId);
    if (!meta) {
      return res.status(404).json({ error: 'Connector not found' });
    }
    if (meta.provider !== 'outlook-calendar') {
      return res.status(400).json({ error: 'Calendar fetch is only available for Outlook Calendar connectors' });
    }
    const config = await getConnectorConfig(tenantId, meta.connectorType, meta.provider);
    if (!config) {
      return res.status(404).json({ error: 'Outlook Calendar connector configuration not found' });
    }
    const calendars = await fetchOutlookCalendarList(tenantId, config);
    const sorted = [...calendars].sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1;
      if (!a.isDefault && b.isDefault) return 1;
      return a.name.localeCompare(b.name);
    });
    return res.json({ calendars: sorted });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to fetch Outlook calendars', { tenantId, integrationId, error: message });
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
