import { createLogger } from '../../core/logger';
import { withPrivilegedClient } from '../../db';
import { writeAuditLog } from '../../audit/AuditService';
import {
  getConnectorConfig,
  getPreferredSchedulingProvider,
  listEnabledConnectorConfigs,
  updateConnectorSyncStatus,
  recordAppointmentSchedulingDispatch,
  getAppointmentSchedulingProvider,
} from './db';
import {
  notifyConnectorSyncError,
  notifySustainedConnectorFailure,
  notifyConnectorRecovery,
  isRevenueCriticalProvider,
} from './SyncErrorAlerter';
import type { ConnectorConfig as ConnectorConfigType } from './types';
import { TicketingConnectorAdapter } from './adapters/ticketing';
import { TwilioSmsConnectorAdapter } from './adapters/sms';
import { HubSpotConnectorAdapter } from './adapters/hubspot';
import { GoogleCalendarConnectorAdapter } from './adapters/google-calendar';
import { OutlookCalendarConnectorAdapter } from './adapters/outlook-calendar';
import { SlackConnectorAdapter } from './adapters/slack';
import { ZapierWebhookConnectorAdapter } from './adapters/zapier';
import { PipedriveConnectorAdapter } from './adapters/pipedrive';
import { SalesforceConnectorAdapter } from './adapters/salesforce';
import { QuickBooksConnectorAdapter } from './adapters/quickbooks';
import { ZohoConnectorAdapter } from './adapters/zoho';
import { recordIntegrationEvent } from '../../core/observability/traceLogger';
import {
  clearCrmCallerIdentity,
  extractIdentityFromMeta,
  lookupCrmCallerIdentity,
  upsertCrmCallerIdentity,
  type StaleCrmIds,
} from './crmCallerIdentity';
import { recordStaleCacheScrub } from './CrmStaleCacheTracker';
import type { ConnectorAdapter, ConnectorPayload, ConnectorResult, ConnectorType, StandardEventType } from './types';
import type { TenantId } from '../../core/types';

const logger = createLogger('CONNECTOR_SERVICE');

const googleCalendarAdapter = new GoogleCalendarConnectorAdapter();
const outlookCalendarAdapter = new OutlookCalendarConnectorAdapter();
const hubspotAdapter = new HubSpotConnectorAdapter();
const salesforceAdapter = new SalesforceConnectorAdapter();
const pipedriveAdapter = new PipedriveConnectorAdapter();
const slackAdapter = new SlackConnectorAdapter();
const zapierAdapter = new ZapierWebhookConnectorAdapter();
const twilioSmsAdapter = new TwilioSmsConnectorAdapter();
const quickbooksAdapter = new QuickBooksConnectorAdapter();
const zohoAdapter = new ZohoConnectorAdapter();

const TYPE_ADAPTER_REGISTRY: Record<string, ConnectorAdapter> = {
  ticketing: new TicketingConnectorAdapter(),
  sms: twilioSmsAdapter,
  crm: hubspotAdapter,
  scheduling: googleCalendarAdapter,
  webhook: zapierAdapter,
  custom: slackAdapter,
  accounting: quickbooksAdapter,
};

const PROVIDER_ADAPTER_REGISTRY: Record<string, ConnectorAdapter> = {
  hubspot: hubspotAdapter,
  salesforce: salesforceAdapter,
  pipedrive: pipedriveAdapter,
  zoho: zohoAdapter,
  'google-calendar': googleCalendarAdapter,
  'outlook-calendar': outlookCalendarAdapter,
  slack: slackAdapter,
  zapier: zapierAdapter,
  webhook: zapierAdapter,
  twilio: twilioSmsAdapter,
  quickbooks: quickbooksAdapter,
};

const ADAPTER_REGISTRY: Record<string, ConnectorAdapter> = {
  ...TYPE_ADAPTER_REGISTRY,
  'crm:salesforce': salesforceAdapter,
  'crm:hubspot': hubspotAdapter,
  'crm:pipedrive': pipedriveAdapter,
  'crm:zoho': zohoAdapter,
  'accounting:quickbooks': quickbooksAdapter,
};

const SCHEDULING_ADAPTERS: Record<string, ConnectorAdapter> = {
  'google-calendar': googleCalendarAdapter,
  'outlook-calendar': outlookCalendarAdapter,
};

function resolveAdapter(connectorType: ConnectorType, provider?: string): ConnectorAdapter | undefined {
  if (connectorType === 'scheduling' && provider && SCHEDULING_ADAPTERS[provider]) {
    return SCHEDULING_ADAPTERS[provider];
  }
  if (provider) {
    const keyed = ADAPTER_REGISTRY[`${connectorType}:${provider}`] || PROVIDER_ADAPTER_REGISTRY[provider];
    if (keyed) return keyed;
  }
  return ADAPTER_REGISTRY[connectorType];
}

const SCHEDULING_DRIFT_AUDIT_TTL_MS = 60 * 60 * 1000;
const schedulingDriftAuditCache = new Map<string, number>();

function shouldAuditSchedulingDrift(key: string): boolean {
  const now = Date.now();
  const last = schedulingDriftAuditCache.get(key);
  if (last && now - last < SCHEDULING_DRIFT_AUDIT_TTL_MS) return false;
  schedulingDriftAuditCache.set(key, now);
  if (schedulingDriftAuditCache.size > 1024) {
    for (const [k, ts] of schedulingDriftAuditCache) {
      if (now - ts >= SCHEDULING_DRIFT_AUDIT_TTL_MS) schedulingDriftAuditCache.delete(k);
    }
  }
  return true;
}

const STANDARD_EVENT_TYPES = new Set<string>([
  'call.completed',
  'appointment.booked',
  'appointment.rescheduled',
  'appointment.cancelled',
  'appointment.no_show',
  'sms.sent',
  'ticket.created',
  'call.missed',
]);

const EVENT_TO_CONNECTOR_TYPES: Record<string, ConnectorType[]> = {
  'call.completed': ['crm', 'accounting', 'custom', 'webhook'],
  'appointment.booked': ['crm', 'scheduling', 'accounting', 'custom', 'webhook'],
  'appointment.rescheduled': ['crm', 'scheduling', 'custom', 'webhook'],
  'appointment.cancelled': ['crm', 'scheduling', 'custom', 'webhook'],
  'appointment.no_show': ['crm', 'scheduling', 'custom', 'webhook'],
  'sms.sent': ['custom', 'webhook'],
  'ticket.created': ['custom', 'webhook'],
  'call.missed': ['custom', 'webhook'],
};

const APPOINTMENT_LIFECYCLE_EVENTS = new Set<string>([
  'appointment.booked',
  'appointment.rescheduled',
  'appointment.cancelled',
  'appointment.no_show',
]);

/**
 * Derive every stable lookup key the payload supports, ordered by
 * specificity (most specific first). At booking time we record one ledger
 * row per derived key so that downstream lifecycle events — which may carry
 * a different subset of identifying fields — can still find the original
 * scheduling provider. At lookup time we try the keys in the same order
 * and return on the first hit.
 *
 * Supported keys:
 *   - `appt:<appointmentId>`           (explicit canonical ID)
 *   - `sid:<callSid>`                  (voice-gateway initiated bookings)
 *   - `phone:<callerPhone>:<startTime>` derived from `startTime` or
 *     `appointmentDate`+`appointmentTime`.
 */
function deriveAppointmentLookupKeys(payload: ConnectorPayload): string[] {
  const p = payload as Record<string, unknown>;
  const keys: string[] = [];

  const appointmentId = typeof p.appointmentId === 'string' ? p.appointmentId.trim() : '';
  if (appointmentId) keys.push(`appt:${appointmentId}`);

  const callSid = typeof p.callSid === 'string' ? p.callSid.trim() : '';
  if (callSid) keys.push(`sid:${callSid}`);

  const callerPhone = typeof p.callerPhone === 'string' ? p.callerPhone.trim() : '';
  let startTime = typeof p.startTime === 'string' ? p.startTime.trim() : '';
  if (!startTime) {
    const date = typeof p.appointmentDate === 'string' ? p.appointmentDate.trim() : '';
    const time = typeof p.appointmentTime === 'string' ? p.appointmentTime.trim() : '';
    if (date && time) startTime = `${date}T${time}`;
  }
  if (callerPhone && startTime) keys.push(`phone:${callerPhone}:${startTime}`);

  return keys;
}

function inferConnectorType(payload: ConnectorPayload): ConnectorType | null {
  switch (payload.type) {
    case 'create_ticket':
    case 'answering_service_ticket':
    case 'after_hours_triage_ticket':
      return 'ticketing';
    case 'send_sms':
    case 'escalation_notification':
      return 'sms';
    default:
      return null;
  }
}

export class ConnectorService {
  async execute(
    tenantId: TenantId,
    connectorType: ConnectorType,
    payload: ConnectorPayload,
    provider?: string,
  ): Promise<ConnectorResult> {
    const config = await getConnectorConfig(tenantId, connectorType, provider);
    const adapter = resolveAdapter(connectorType, config?.provider ?? provider);
    if (!adapter) {
      return { success: false, error: `No adapter registered for connector type: ${connectorType}` };
    }

    if (!config) {
      logger.warn('No connector configured for type', { tenantId, connectorType, provider });
      return {
        success: false,
        error: `No ${connectorType} connector configured for this tenant`,
      };
    }

    return this.executeWithConfig(tenantId, config, payload);
  }

  private async executeWithConfig(
    tenantId: TenantId,
    config: ConnectorConfigType,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const adapter = resolveAdapter(config.connectorType, config.provider);
    if (!adapter) {
      return { success: false, error: `No adapter for ${config.connectorType}:${config.provider}` };
    }

    if (!config.isEnabled) {
      return { success: false, error: `${config.connectorType} connector is disabled for this tenant` };
    }

    logger.info('Dispatching to connector', {
      tenantId,
      connectorType: config.connectorType,
      provider: config.provider,
      payloadType: payload.type,
    });

    const effectivePayload = await this.maybeInjectCachedCrmIdentity(tenantId, config, payload);

    const startTime = Date.now();
    const result = await adapter.execute(tenantId, config, effectivePayload);
    const latencyMs = Date.now() - startTime;

    if (result.success) {
      this.maybePersistCrmIdentity(tenantId, config, effectivePayload, result).catch(() => {});
    } else {
      this.maybeInvalidateCrmIdentity(tenantId, config, effectivePayload, result).catch(() => {});
    }

    const callSessionId = (payload as Record<string, unknown>).callSessionId as string | undefined;
    const toolInvocationId = (payload as Record<string, unknown>).toolInvocationId as string | undefined;

    recordIntegrationEvent({
      tenantId,
      callSessionId,
      toolInvocationId,
      requestMethod: 'POST',
      requestUrl: `connector://${config.connectorType}/${config.provider}`,
      requestBody: { type: payload.type },
      responseStatus: result.success ? 200 : 500,
      responseBody: { success: result.success, error: result.error ?? null },
      latencyMs,
      errorMessage: result.error ?? undefined,
      serviceName: `${config.connectorType}:${config.provider}`,
    }).catch(() => {});

    recordConnectorDispatchEvent({
      tenantId,
      callSessionId,
      connectorType: config.connectorType,
      provider: config.provider,
      payloadType: payload.type,
      result,
      latencyMs,
    }).catch((err) => {
      logger.warn('Failed to record connector dispatch call event', {
        tenantId,
        connectorType: config.connectorType,
        provider: config.provider,
        error: String(err),
      });
    });

    const errorMessage = result.success ? null : (result.error ?? 'Unknown error');
    updateConnectorSyncStatus(
      tenantId,
      config.connectorType,
      result.success ? 'success' : 'error',
      config.provider,
      errorMessage,
    )
      .then((updates) => {
        if (!isRevenueCriticalProvider(config.provider)) return;
        for (const u of updates) {
          if (result.success) {
            // Recovery path: fire an "all clear" the first time a previously
            // erroring integration syncs successfully again. Throttled inside
            // notifyConnectorRecovery to prevent flapping spam.
            if (u.transitionedToRecovery) {
              notifyConnectorRecovery({
                tenantId,
                integrationId: u.integrationId,
                connectorType: config.connectorType,
                provider: u.provider,
                outageDurationMs: u.outageDurationMs,
              }).catch((err) => {
                logger.warn('notifyConnectorRecovery failed', {
                  tenantId,
                  integrationId: u.integrationId,
                  error: String(err),
                });
              });
            }
            continue;
          }
          if (u.transitionedToError) {
            notifyConnectorSyncError({
              tenantId,
              integrationId: u.integrationId,
              connectorType: config.connectorType,
              provider: u.provider,
              errorMessage,
              firstFailedAt: u.firstFailedAt,
            }).catch((err) => {
              logger.warn('notifyConnectorSyncError failed', {
                tenantId,
                integrationId: u.integrationId,
                error: String(err),
              });
            });
          }
          // Sustained-failure SMS escalation: fires on any error (including
          // consecutive ones) once the integration has been failing past the
          // sustained threshold, and respects its own throttle / opt-out.
          notifySustainedConnectorFailure({
            tenantId,
            integrationId: u.integrationId,
            connectorType: config.connectorType,
            provider: u.provider,
            errorMessage,
            firstFailedAt: u.firstFailedAt,
          }).catch((err) => {
            logger.warn('notifySustainedConnectorFailure failed', {
              tenantId,
              integrationId: u.integrationId,
              error: String(err),
            });
          });
        }
      })
      .catch(() => {});

    if (!result.success && config.fallbackConnectorType) {
      logger.info('Primary connector failed, attempting fallback', {
        tenantId,
        primaryType: config.connectorType,
        fallbackType: config.fallbackConnectorType,
        payloadType: payload.type,
      });
      return this.executeFallback(tenantId, config.fallbackConnectorType, payload);
    }

    return result;
  }

  private async executeFallback(
    tenantId: TenantId,
    fallbackType: ConnectorType,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const config = await getConnectorConfig(tenantId, fallbackType);
    if (!config || !config.isEnabled) {
      return { success: false, error: `Fallback connector ${fallbackType} not available` };
    }

    const adapter = resolveAdapter(fallbackType, config.provider);
    if (!adapter) {
      return { success: false, error: `No fallback adapter for ${fallbackType}/${config.provider}` };
    }

    logger.info('Executing fallback connector', { tenantId, fallbackType, provider: config.provider });
    const effectivePayload = await this.maybeInjectCachedCrmIdentity(tenantId, config, payload);
    const startTime = Date.now();
    const result = await adapter.execute(tenantId, config, effectivePayload);
    const latencyMs = Date.now() - startTime;

    if (result.success) {
      this.maybePersistCrmIdentity(tenantId, config, effectivePayload, result).catch(() => {});
    } else {
      this.maybeInvalidateCrmIdentity(tenantId, config, effectivePayload, result).catch(() => {});
    }

    const callSessionId = (payload as Record<string, unknown>).callSessionId as string | undefined;
    const toolInvocationId = (payload as Record<string, unknown>).toolInvocationId as string | undefined;

    recordIntegrationEvent({
      tenantId,
      callSessionId,
      toolInvocationId,
      requestMethod: 'POST',
      requestUrl: `connector://${fallbackType}/${config.provider}`,
      requestBody: { type: payload.type },
      responseStatus: result.success ? 200 : 500,
      responseBody: { success: result.success, error: result.error ?? null },
      latencyMs,
      errorMessage: result.error ?? undefined,
      serviceName: `${fallbackType}:${config.provider}`,
    }).catch(() => {});

    const fallbackResult = { ...result, meta: { ...result.meta, usedFallback: true } };

    recordConnectorDispatchEvent({
      tenantId,
      callSessionId,
      connectorType: fallbackType,
      provider: config.provider,
      payloadType: payload.type,
      result: fallbackResult,
      latencyMs,
      usedFallback: true,
    }).catch((err) => {
      logger.warn('Failed to record fallback connector dispatch call event', {
        tenantId,
        connectorType: fallbackType,
        provider: config.provider,
        error: String(err),
      });
    });

    return fallbackResult;
  }

  async executeByPayload(
    tenantId: TenantId,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const connectorType = inferConnectorType(payload);
    if (!connectorType) {
      logger.warn('Cannot infer connector type from payload', { tenantId, payloadType: payload.type });
      return { success: false, error: `Cannot route payload type: ${payload.type}` };
    }
    return this.execute(tenantId, connectorType, payload);
  }

  async dispatchEvent(
    tenantId: TenantId,
    eventType: StandardEventType,
    payload: ConnectorPayload,
    options?: { schedulingProvider?: string | null },
  ): Promise<{ dispatched: number; results: Array<{ connectorType: string; provider: string; success: boolean; error?: string }> }> {
    const eventPayload = { ...payload, type: eventType };
    const results: Array<{ connectorType: string; provider: string; success: boolean; error?: string }> = [];

    const targetTypes = EVENT_TO_CONNECTOR_TYPES[eventType] ?? [];
    if (targetTypes.length === 0) {
      return { dispatched: 0, results };
    }

    const isLifecycleEvent = APPOINTMENT_LIFECYCLE_EVENTS.has(eventType);
    const appointmentLookupKeys = isLifecycleEvent ? deriveAppointmentLookupKeys(payload) : [];

    let schedulingProvider: string | null | undefined = options?.schedulingProvider;
    if (schedulingProvider === undefined && targetTypes.includes('scheduling')) {
      // For non-booked lifecycle events (reschedule / cancel / no-show) the
      // ledger is authoritative: we always want to route back to the calendar
      // that originally received the booking, even if the tenant has since
      // changed their default scheduling provider for that agent or phone
      // number. Otherwise a reschedule could land in a calendar that has no
      // record of the original event.
      //
      // For `appointment.booked` itself we skip the ledger — the booking
      // *creates* the entry, so reading from it for the same event would
      // only ever return a stale prior decision — and instead use the
      // per-target preference (agentId / phoneNumberId).
      if (isLifecycleEvent && eventType !== 'appointment.booked' && appointmentLookupKeys.length > 0) {
        for (const key of appointmentLookupKeys) {
          const recorded = await getAppointmentSchedulingProvider(tenantId, key);
          if (recorded) {
            schedulingProvider = recorded;
            logger.info('Resolved scheduling provider from appointment dispatch ledger', {
              tenantId,
              eventType,
              lookupKey: key,
              schedulingProvider: recorded,
            });
            break;
          }
        }
      }

      if (schedulingProvider === undefined) {
        const payloadObj = payload as Record<string, unknown>;
        const agentId = typeof payloadObj.agentId === 'string'
          ? (payloadObj.agentId as string)
          : null;
        const phoneNumberId = typeof payloadObj.phoneNumberId === 'string'
          ? (payloadObj.phoneNumberId as string)
          : null;
        if (agentId || phoneNumberId) {
          schedulingProvider = await getPreferredSchedulingProvider(tenantId, {
            agentId,
            phoneNumberId,
          });
        } else {
          schedulingProvider = null;
        }
      }
    }

    const configs = await listEnabledConnectorConfigs(tenantId, targetTypes);
    const dispatched = new Set<string>();
    let schedulingProviderMatched = false;

    for (const config of configs) {
      // Honour the per-agent / per-phone-number scheduling provider choice so
      // bookings only land in the calendar the tenant picked, rather than
      // fanning out to every enabled scheduling integration.
      if (config.connectorType === 'scheduling' && schedulingProvider && config.provider !== schedulingProvider) {
        continue;
      }
      if (config.connectorType === 'scheduling' && schedulingProvider && config.provider === schedulingProvider) {
        schedulingProviderMatched = true;
      }
      const key = `${config.connectorType}:${config.provider}`;
      if (dispatched.has(key)) continue;
      dispatched.add(key);

      try {
        const result = await this.executeWithConfig(tenantId, config, eventPayload);
        results.push({
          connectorType: config.connectorType,
          provider: config.provider,
          success: result.success,
          error: result.error,
        });

        // Remember which scheduling integration accepted the booking so that
        // downstream reschedule / cancel / no-show events for the same
        // appointment can route back to the same calendar. We record one
        // row per derivable key (appointmentId, callSid, phone+startTime)
        // so a later lifecycle event finds the booking even if it carries
        // a different subset of identifiers.
        //
        // Awaited (in parallel across keys) so an immediately-following
        // lifecycle event can't race past the ledger write and fall back
        // to broadcast/preference behaviour. Failures are logged but do
        // not fail the dispatch itself — the booking has already
        // succeeded at this point.
        if (
          eventType === 'appointment.booked'
          && config.connectorType === 'scheduling'
          && result.success
          && appointmentLookupKeys.length > 0
        ) {
          await Promise.all(
            appointmentLookupKeys.map((key) =>
              recordAppointmentSchedulingDispatch(
                tenantId,
                key,
                config.provider,
                result.externalId ?? null,
              ).catch((err) => {
                logger.warn('Failed to record appointment scheduling dispatch', {
                  tenantId,
                  eventType,
                  provider: config.provider,
                  lookupKey: key,
                  error: String(err),
                });
              }),
            ),
          );
        }
      } catch (err) {
        results.push({
          connectorType: config.connectorType,
          provider: config.provider,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('Event dispatched to connectors', {
      tenantId,
      eventType,
      dispatched: results.length,
      successful: results.filter((r) => r.success).length,
    });

    if (
      schedulingProvider &&
      targetTypes.includes('scheduling') &&
      !schedulingProviderMatched
    ) {
      const payloadObj = payload as Record<string, unknown>;
      const agentId = typeof payloadObj.agentId === 'string' ? (payloadObj.agentId as string) : null;
      const phoneNumberId = typeof payloadObj.phoneNumberId === 'string'
        ? (payloadObj.phoneNumberId as string)
        : null;
      const refKey = phoneNumberId
        ? `phone:${phoneNumberId}`
        : agentId
          ? `agent:${agentId}`
          : 'tenant';
      const dedupeKey = `${tenantId}:${refKey}:${schedulingProvider}`;
      logger.warn('Scheduling provider drift: chosen calendar is not connected', {
        tenantId,
        eventType,
        schedulingProvider,
        agentId,
        phoneNumberId,
      });
      if (shouldAuditSchedulingDrift(dedupeKey)) {
        try {
          await writeAuditLog({
            tenantId,
            actorUserId: 'system',
            actorRole: 'system',
            action: 'connector.scheduling_provider_drift',
            resourceType: phoneNumberId ? 'phone_number' : agentId ? 'agent' : 'tenant',
            resourceId: phoneNumberId ?? agentId ?? undefined,
            severity: 'warning',
            changes: {
              eventType,
              schedulingProvider,
              agentId,
              phoneNumberId,
              reason: 'no_enabled_scheduling_connector_matches',
            },
          });
        } catch {
          // best-effort; writeAuditLog already logs
        }
      }
    }

    return { dispatched: results.length, results };
  }

  isStandardEvent(eventType: string): boolean {
    return STANDARD_EVENT_TYPES.has(eventType);
  }

  /**
   * For CRM dispatches, look up any cached `{ contactId, accountId, opportunityId }`
   * for this caller and merge them into the payload so the adapter can skip
   * phone/company lookups and Lead conversion. Explicit IDs already on the
   * payload always win.
   */
  private async maybeInjectCachedCrmIdentity(
    tenantId: TenantId,
    config: ConnectorConfigType,
    payload: ConnectorPayload,
  ): Promise<ConnectorPayload> {
    if (config.connectorType !== 'crm') return payload;
    const callerPhone = (payload as Record<string, unknown>).callerPhone as string | undefined;
    if (!callerPhone) return payload;

    const cached = await lookupCrmCallerIdentity(tenantId, config.provider, callerPhone);
    if (!cached) return payload;

    const merged: ConnectorPayload = { ...payload };
    const current = payload as Record<string, unknown>;
    const out = merged as Record<string, unknown>;
    let injected = false;

    // Salesforce-style hints (always set when cached + missing — Salesforce
    // adapter and any other adapter that reads these names benefits).
    if (!current.contactId && cached.contactId) {
      out.contactId = cached.contactId;
      injected = true;
    }
    if (!current.accountId && cached.accountId) {
      out.accountId = cached.accountId;
      injected = true;
    }
    if (!current.opportunityId && cached.opportunityId) {
      out.opportunityId = cached.opportunityId;
      injected = true;
    }

    // Provider-specific aliases so the HubSpot and Pipedrive adapters can
    // read hints under the field names they expect. Native IDs live in
    // `cached.extras` keyed by the adapter-facing field name (e.g. `companyId`,
    // `dealId`, `personId`, `orgId`) so we can re-inject them verbatim. The
    // canonical Salesforce-shaped slots are kept as a fallback for already-
    // cached rows that pre-date the `extras` column.
    const extras = cached.extras ?? {};
    if (config.provider === 'hubspot') {
      const companyId = extras.companyId ?? cached.accountId;
      if (!current.companyId && companyId) {
        out.companyId = companyId;
        injected = true;
      }
      const dealId = extras.dealId ?? cached.opportunityId;
      if (!current.dealId && dealId) {
        out.dealId = dealId;
        injected = true;
      }
      // HubSpot's contactId already matches the canonical slot name, but
      // prefer the verbatim extras value when present for full round-trip.
      const hsContactId = extras.contactId ?? cached.contactId;
      if (!current.contactId && hsContactId) {
        out.contactId = hsContactId;
        injected = true;
      }
    } else if (config.provider === 'pipedrive') {
      const personId = extras.personId ?? cached.contactId;
      if (!current.personId && personId) {
        out.personId = personId;
        injected = true;
      }
      const orgId = extras.orgId ?? cached.accountId;
      if (!current.orgId && orgId) {
        out.orgId = orgId;
        injected = true;
      }
      const dealId = extras.dealId ?? cached.opportunityId;
      if (!current.dealId && dealId) {
        out.dealId = dealId;
        injected = true;
      }
    } else if (config.provider === 'zoho') {
      if (!current.dealId && cached.opportunityId) {
        out.dealId = cached.opportunityId;
        injected = true;
      }
    }

    if (injected) {
      logger.info('Injected cached CRM caller identity into payload', {
        tenantId,
        provider: config.provider,
        payloadType: payload.type,
        hasContact: Boolean(out.contactId ?? out.personId),
        hasAccount: Boolean(out.accountId ?? out.companyId ?? out.orgId),
        hasOpportunity: Boolean(out.opportunityId ?? out.dealId),
      });
    }
    return merged;
  }

  /**
   * After a successful CRM dispatch, persist any IDs returned by the adapter
   * (in `result.meta`) keyed by tenant + caller phone + provider, so the next
   * event for this caller can re-use them.
   */
  private async maybePersistCrmIdentity(
    tenantId: TenantId,
    config: ConnectorConfigType,
    payload: ConnectorPayload,
    result: ConnectorResult,
  ): Promise<void> {
    if (config.connectorType !== 'crm') return;
    const callerPhone = (payload as Record<string, unknown>).callerPhone as string | undefined;
    if (!callerPhone) return;
    const identity = extractIdentityFromMeta(result.meta, config.provider);
    const hasExtras = identity.extras && Object.keys(identity.extras).length > 0;
    if (!identity.contactId && !identity.accountId && !identity.opportunityId && !hasExtras) return;
    await upsertCrmCallerIdentity(tenantId, config.provider, callerPhone, identity);
  }

  /**
   * When a CRM dispatch fails because a cached `{ contactId, accountId,
   * opportunityId }` (or a provider-native equivalent) refers to a record
   * that has been deleted/merged/archived in the upstream CRM, the adapter
   * surfaces the offending IDs via `result.meta.staleIds`. Scrub those IDs
   * from `crm_caller_identities` so the next event for the same caller
   * re-runs phone/company lookup instead of injecting the same zombie ID.
   *
   * Matching inside `clearCrmCallerIdentity` is by value, so it's safe to
   * forward IDs that may not actually be in the cache (no-op fallback).
   */
  private async maybeInvalidateCrmIdentity(
    tenantId: TenantId,
    config: ConnectorConfigType,
    payload: ConnectorPayload,
    result: ConnectorResult,
  ): Promise<void> {
    if (config.connectorType !== 'crm') return;
    const callerPhone = (payload as Record<string, unknown>).callerPhone as string | undefined;
    if (!callerPhone) return;
    const meta = result.meta;
    if (!meta || typeof meta !== 'object') return;
    const rawStale = (meta as Record<string, unknown>).staleIds;
    if (!rawStale || typeof rawStale !== 'object') return;

    const stale: StaleCrmIds = {};
    const allowedKeys: Array<keyof StaleCrmIds> = [
      'contactId', 'accountId', 'opportunityId',
      'companyId', 'dealId', 'personId', 'orgId',
    ];
    for (const key of allowedKeys) {
      const value = (rawStale as Record<string, unknown>)[key];
      if (typeof value === 'string' && value) stale[key] = value;
      else if (typeof value === 'number' && Number.isFinite(value)) stale[key] = String(value);
    }
    if (Object.keys(stale).length === 0) return;

    const staleErrorCode = typeof (meta as Record<string, unknown>).staleErrorCode === 'string'
      ? ((meta as Record<string, unknown>).staleErrorCode as string)
      : null;
    logger.info('Invalidating CRM caller identity due to stale-record dispatch failure', {
      tenantId,
      provider: config.provider,
      payloadType: payload.type,
      staleIds: stale,
      errorCode: staleErrorCode ?? undefined,
    });
    await clearCrmCallerIdentity(tenantId, config.provider, callerPhone, stale);

    // Track this scrub event so the alerter can warn the customer when a
    // single caller phone repeatedly hits stale records — almost always a
    // sign of upstream CRM data hygiene problems (records being deleted/
    // re-created or hand-removed by the customer's team after the AI just
    // created them). Best-effort: tracker swallows its own DB errors and
    // we wrap the call in case the module itself blows up so the dispatch
    // path is never affected.
    try {
      await recordStaleCacheScrub({
        tenantId,
        provider: config.provider,
        callerPhone,
        staleIds: stale,
        errorCode: staleErrorCode,
      });
    } catch (err) {
      logger.warn('Failed to record stale-cache scrub for alerting', {
        tenantId,
        provider: config.provider,
        error: String(err),
      });
    }
  }
}

export const connectorService = new ConnectorService();

async function recordConnectorDispatchEvent(args: {
  tenantId: TenantId;
  callSessionId?: string;
  connectorType: string;
  provider: string;
  payloadType: string;
  result: { success: boolean; error?: string; externalId?: string; meta?: Record<string, unknown> };
  latencyMs: number;
  usedFallback?: boolean;
}): Promise<void> {
  if (!args.callSessionId) return;

  const safeMeta = sanitizeConnectorMeta(args.result.meta);
  const eventPayload = {
    connectorType: args.connectorType,
    provider: args.provider,
    payloadType: args.payloadType,
    success: args.result.success,
    error: args.result.error ?? null,
    externalId: args.result.externalId ?? null,
    latencyMs: args.latencyMs,
    usedFallback: Boolean(args.usedFallback),
    meta: safeMeta,
  };

  await withPrivilegedClient(async (client) => {
    await client.query(
      `INSERT INTO call_events
         (id, tenant_id, call_session_id, event_type, from_state, to_state, payload, occurred_at)
       VALUES (gen_random_uuid(), $1, $2, 'connector_dispatched', NULL, NULL, $3, NOW())`,
      [args.tenantId, args.callSessionId, JSON.stringify(eventPayload)],
    );
  });
}

// Drop sensitive auth-style fields if any adapter ever puts them into meta.
// CRM record IDs (Salesforce 15/18-char IDs, HubSpot numeric IDs, etc.) are
// safe to surface — they are required to render deep-links to the records.
function sanitizeConnectorMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!meta || typeof meta !== 'object') return null;
  const REDACT_KEYS = ['accessToken', 'access_token', 'refreshToken', 'refresh_token', 'apiKey', 'api_key', 'secret', 'password', 'token'];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (REDACT_KEYS.some((r) => k.toLowerCase().includes(r.toLowerCase()))) continue;
    out[k] = v;
  }
  return out;
}
