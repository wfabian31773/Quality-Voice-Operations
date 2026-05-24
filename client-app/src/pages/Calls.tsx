import { useState, useEffect, useMemo, useRef, Suspense, lazy } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { formatCents as formatCentsHelper } from '../lib/formatCurrency';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
import { PhoneCall, X, ChevronLeft, ChevronRight, Filter, AlertTriangle, Search, Bookmark, Star, Mail, Users, UserMinus, ExternalLink, ArrowRightLeft, UserPlus, Building2, Briefcase, ClipboardCheck, Cloud, CheckCircle2, XCircle, Circle } from 'lucide-react';
import { format } from 'date-fns';
import EmptyState from '../components/EmptyState';
import { SkeletonRows } from '../components/state';
import { PageHeader } from '../components/ui';
import Modal from '../components/Modal';
import { getAgentLanguageLabel } from '../lib/agentLanguages';
import {
  callLifecycleLabel,
  callDirectionLabel,
  toolExecStatusLabel,
} from '../lib/statusLabels';
import { EMPTY_FILTERS, type FiltersState, type SavedView } from './calls/types';

// The pinned-saved-views bar uses @dnd-kit for drag-to-reorder. dnd-kit pulls
// React in via the workspace's nested node_modules and that triggers
// "Invalid hook call" errors when Calls.tsx is rendered under vitest (two
// React copies). Lazy-loading the bar keeps Calls.tsx itself free of
// @dnd-kit imports so page-level vitest tests can render it cleanly; the
// chunk only loads in the browser when the bar is actually shown.
const PinnedSavedViewsBar = lazy(() => import('./calls/PinnedSavedViewsBar'));

interface Call {
  id: string;
  caller_number: string;
  called_number: string;
  direction: string;
  lifecycle_state: string;
  start_time: string;
  end_time: string | null;
  agent_id: string;
  agent_name: string | null;
  duration_seconds: number | null;
  failed_tool_count?: number;
  stir_status?: string | null;
  stir_verstat?: string | null;
  stir_attestation?: 'A' | 'B' | 'C' | null;
  language?: string | null;
}

interface TranscriptEntry {
  id: string;
  role: string;
  content: string;
  sequence_number: number;
  occurred_at: string;
}

interface CallEvent {
  id: string;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
}

interface CostBreakdown {
  sttCostCents: number;
  llmCostCents: number;
  ttsCostCents: number;
  infraCostCents: number;
  totalCostCents: number;
  modelTier: string;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  cacheHits: number;
  cacheMisses: number;
  promptTokensSaved: number;
}

interface Agent {
  id: string;
  name: string;
}

interface ConnectorDispatchPayload {
  connectorType?: string;
  provider?: string;
  payloadType?: string;
  success?: boolean;
  error?: string | null;
  externalId?: string | null;
  latencyMs?: number;
  usedFallback?: boolean;
  meta?: {
    provider?: string;
    pipelineMode?: 'leads' | 'contacts';
    instanceUrl?: string;
    eventType?: string;
    whoId?: string;
    whoObject?: 'Contact' | 'Lead';
    whatId?: string;
    whatObject?: 'Account' | 'Opportunity' | 'Lead' | 'Contact' | 'Task' | 'Event';
    taskId?: string;
    noteId?: string;
    convertedFromLead?: boolean;
    convertedFromLeadId?: string;
    contactId?: string;
    accountId?: string;
    opportunityId?: string;
    usedFallback?: boolean;
    [key: string]: unknown;
  } | null;
}

function isConnectorDispatchEvent(event: CallEvent): event is CallEvent & { payload: ConnectorDispatchPayload } {
  return event.event_type === 'connector_dispatched' && !!event.payload && typeof event.payload === 'object';
}

function buildSalesforceUrl(instanceUrl: string | undefined, sobject: string, id: string | undefined): string | undefined {
  if (!instanceUrl || !id) return undefined;
  const base = instanceUrl.replace(/\/+$/, '');
  return `${base}/lightning/r/${sobject}/${id}/view`;
}

function shortId(id: string | undefined): string {
  if (!id) return '--';
  return id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function SalesforceRecordCard({ event }: { event: CallEvent & { payload: ConnectorDispatchPayload } }) {
  const { t } = useTranslation('tenant');
  const payload = event.payload;
  const meta = payload.meta ?? {};
  const instanceUrl = meta.instanceUrl;
  const isSuccess = payload.success !== false;
  const eventLabel = (() => {
    switch (meta.eventType ?? payload.payloadType) {
      case 'call.completed': return t('calls.crm.event_call_logged');
      case 'appointment.booked': return t('calls.crm.event_appointment_booked');
      default: return payload.payloadType ?? t('calls.crm.event_default');
    }
  })();

  const records: Array<{ icon: typeof UserPlus; label: string; sobject: string; id: string | undefined; sublabel?: string }> = [];
  if (meta.convertedFromLead && meta.convertedFromLeadId) {
    records.push({ icon: ArrowRightLeft, label: t('calls.crm.record_converted_from_lead'), sobject: 'Lead', id: meta.convertedFromLeadId, sublabel: t('calls.crm.record_converted_sublabel') });
  }
  if (meta.contactId || (meta.whoObject === 'Contact' && meta.whoId)) {
    const id = meta.contactId ?? meta.whoId;
    records.push({
      icon: UserPlus,
      label: meta.contactId ? t('calls.crm.record_contact_created_linked') : t('calls.crm.record_contact_attached'),
      sobject: 'Contact',
      id,
    });
  } else if (meta.whoObject === 'Lead' && meta.whoId) {
    records.push({ icon: UserPlus, label: t('calls.crm.record_lead_attached'), sobject: 'Lead', id: meta.whoId });
  }
  if (meta.accountId) {
    records.push({ icon: Building2, label: t('calls.crm.record_account'), sobject: 'Account', id: meta.accountId });
  }
  if (meta.opportunityId) {
    records.push({ icon: Briefcase, label: t('calls.crm.record_opportunity'), sobject: 'Opportunity', id: meta.opportunityId });
  }
  if (meta.taskId) {
    records.push({ icon: ClipboardCheck, label: t('calls.crm.record_activity_task'), sobject: 'Task', id: meta.taskId });
  }
  if (meta.whatId && !meta.opportunityId && !meta.accountId && meta.whatObject && meta.whatObject !== 'Task' && meta.whatObject !== 'Event') {
    const icon = meta.whatObject === 'Opportunity' ? Briefcase : Building2;
    records.push({ icon, label: t('calls.crm.record_related', { object: meta.whatObject }), sobject: meta.whatObject, id: meta.whatId });
  }

  return (
    <div className="bg-surface-hover rounded-lg p-3 border border-border">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Cloud className="h-4 w-4 text-info" />
          <span className="text-sm font-medium text-text-primary">Salesforce</span>
          {meta.pipelineMode && (
            <span className="text-[10px] uppercase tracking-wide text-text-muted bg-surface px-1.5 py-0.5 rounded">{meta.pipelineMode}</span>
          )}
          {payload.usedFallback && (
            <span className="text-[10px] uppercase tracking-wide text-warning bg-warning-light px-1.5 py-0.5 rounded">{t('calls.crm.fallback_badge')}</span>
          )}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${isSuccess ? 'bg-success-light text-success' : 'bg-danger-light text-danger'}`}>
          {isSuccess ? t('calls.crm.success') : t('calls.crm.failed')}
        </span>
      </div>

      <div className="text-xs text-text-secondary mb-2 flex items-center justify-between">
        <span>{eventLabel}</span>
        <span className="text-text-muted">{event.occurred_at ? format(new Date(event.occurred_at), 'h:mm:ss a') : '--'}</span>
      </div>

      {!isSuccess && payload.error && (
        <p className="text-xs text-danger mb-2">{payload.error}</p>
      )}

      {records.length > 0 ? (
        <ul className="space-y-1.5">
          {records.map((r, i) => {
            const url = buildSalesforceUrl(instanceUrl, r.sobject, r.id);
            return (
              <li key={`${r.sobject}-${r.id}-${i}`} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <r.icon className="h-3.5 w-3.5 text-text-secondary flex-shrink-0" />
                  <span className="text-text-primary truncate">{r.label}</span>
                  {r.sublabel && <span className="text-text-muted">· {r.sublabel}</span>}
                </div>
                {r.id && (
                  url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 font-mono text-text-secondary hover:text-primary"
                      title={r.id}
                    >
                      {shortId(r.id)}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <span className="font-mono text-text-muted" title={r.id}>{shortId(r.id)}</span>
                  )
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        isSuccess && <p className="text-xs text-text-muted">{t('calls.crm.no_records')}</p>
      )}
    </div>
  );
}

function GenericConnectorCard({ event }: { event: CallEvent & { payload: ConnectorDispatchPayload } }) {
  const { t } = useTranslation('tenant');
  const payload = event.payload;
  const isSuccess = payload.success !== false;
  return (
    <div className="bg-surface-hover rounded-lg p-3 border border-border">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-text-primary capitalize">
          {payload.provider ?? payload.connectorType ?? t('calls.crm.connector_fallback')}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${isSuccess ? 'bg-success-light text-success' : 'bg-danger-light text-danger'}`}>
          {isSuccess ? t('calls.crm.success') : t('calls.crm.failed')}
        </span>
      </div>
      <div className="text-xs text-text-secondary flex items-center justify-between">
        <span>{payload.payloadType ?? '--'}</span>
        <span className="text-text-muted">{event.occurred_at ? format(new Date(event.occurred_at), 'h:mm:ss a') : '--'}</span>
      </div>
      {!isSuccess && payload.error && (
        <p className="text-xs text-danger mt-2">{payload.error}</p>
      )}
      {payload.externalId && (
        <p className="text-xs text-text-muted mt-1 font-mono">id: {shortId(payload.externalId)}</p>
      )}
    </div>
  );
}

function CrmRecordsSection({ events }: { events: CallEvent[] }) {
  const { t } = useTranslation('tenant');
  const dispatchEvents = useMemo(
    () => events.filter(isConnectorDispatchEvent),
    [events],
  );
  if (dispatchEvents.length === 0) return null;

  return (
    <div className="px-5 py-4 border-b border-border">
      <h3 className="text-sm font-semibold text-text-primary mb-3">{t('calls.crm.section_title')}</h3>
      <div className="space-y-3">
        {dispatchEvents.map((event) => {
          const provider = event.payload?.provider ?? event.payload?.meta?.provider;
          if (provider === 'salesforce') {
            return <SalesforceRecordCard key={event.id} event={event} />;
          }
          return <GenericConnectorCard key={event.id} event={event} />;
        })}
      </div>
    </div>
  );
}

// NOTE: this predicate intentionally mirrors `isStirAttestationDegraded`
// in `platform/telephony/stirAttestation.ts`. Keep the two in sync —
// changing one without the other will desync the badge from the
// server-side telemetry classifier.
function isStirDegraded(call: Pick<Call, 'stir_status' | 'stir_verstat' | 'stir_attestation'>): boolean {
  if (call.stir_attestation === 'B' || call.stir_attestation === 'C') return true;
  const status = call.stir_status?.toLowerCase() ?? null;
  if (status === 'failed' || status === 'not-signed') return true;
  const verstat = call.stir_verstat?.toUpperCase() ?? null;
  if (verstat && /TN-VALIDATION-FAILED/.test(verstat)) return true;
  return false;
}

function StirAttestationBadge({
  call,
}: {
  call: Pick<Call, 'stir_status' | 'stir_verstat' | 'stir_attestation'>;
}) {
  const { t } = useTranslation('tenant');
  const hasAnyStir =
    Boolean(call.stir_attestation) ||
    Boolean(call.stir_status) ||
    Boolean(call.stir_verstat);
  if (!hasAnyStir) return null;

  const degraded = isStirDegraded(call);
  const attestation = call.stir_attestation ?? null;
  const label = attestation
    ? t('calls.stir.label_attestation', { attestation })
    : call.stir_status
      ? t('calls.stir.label_status', { status: call.stir_status })
      : t('calls.stir.label_unverified');
  const tooltipParts: string[] = [];
  if (attestation) tooltipParts.push(t('calls.stir.tooltip_attestation', { level: attestation }));
  if (call.stir_status) tooltipParts.push(t('calls.stir.tooltip_status', { status: call.stir_status }));
  if (call.stir_verstat) tooltipParts.push(t('calls.stir.tooltip_verstat', { verstat: call.stir_verstat }));
  if (degraded && !attestation) tooltipParts.push(t('calls.stir.tooltip_carrier_failed'));

  const cls = degraded
    ? 'bg-warning-light text-warning border border-warning/30'
    : 'bg-success-light text-success border border-success/30';

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}
      title={tooltipParts.join(' · ')}
      data-testid="stir-attestation-badge"
    >
      {degraded && <AlertTriangle className="h-3 w-3" aria-hidden />}
      {label}
    </span>
  );
}

export function CallDetailDrawer({ callId, onClose }: { callId: string; onClose: () => void }) {
  const { t } = useTranslation('tenant');
  const currency = useTenantCurrency();
  const formatCents = (cents: number | null | undefined) => formatCentsHelper(cents, { currency });

  const { data: callData } = useQuery({
    queryKey: ['call', callId],
    queryFn: () => api.get<{ call: Call; costBreakdown: CostBreakdown | null }>(`/calls/${callId}`),
  });

  const { data: transcriptData, isLoading: transcriptLoading } = useQuery({
    queryKey: ['transcript', callId],
    queryFn: () => api.get<{ transcript: TranscriptEntry[] }>(`/calls/${callId}/transcript`),
  });

  const { data: eventsData, isLoading: eventsLoading } = useQuery({
    queryKey: ['call-events', callId],
    queryFn: () => api.get<{ events: CallEvent[] }>(`/calls/${callId}/events`),
  });

  const { data: toolExecData, isLoading: toolExecLoading } = useQuery({
    queryKey: ['call-tool-executions', callId],
    queryFn: () => api.get<{ executions: Array<{ id: string; toolName: string; status: string; durationMs: number | null; invokedAt: string; errorMessage: string | null; recoveryAction: string | null; result: unknown }> }>(`/tool-executions?callSessionId=${callId}`),
  });

  const call = callData?.call;
  const costBreakdown = callData?.costBreakdown ?? null;
  const transcript = transcriptData?.transcript ?? [];
  const events = eventsData?.events ?? [];
  const toolExecutions = toolExecData?.executions ?? [];
  const [tab, setTab] = useState<'transcript' | 'events' | 'tools'>('transcript');

  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel={t('calls.detail.title')}
      containerClassName="fixed inset-0 z-drawer flex justify-end"
      panelClassName="w-full max-w-lg bg-surface h-full overflow-y-auto shadow-xl border-l border-border"
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-surface z-sticky-header">
          <h2 className="text-lg font-semibold text-text-primary">{t('calls.detail.title')}</h2>
          <button onClick={onClose} aria-label={t('calls.detail.close_aria')}><X className="h-5 w-5 text-text-secondary hover:text-text-primary" /></button>
        </div>

        {call && (
          <div className="px-5 py-4 border-b border-border space-y-2">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-text-secondary">{t('calls.detail.from')}</span>
                <span className="font-mono text-xs">{call.caller_number}</span>
                <StirAttestationBadge call={call} />
              </div>
              <div><span className="text-text-secondary">{t('calls.detail.to')}</span> <span className="font-mono text-xs">{call.called_number}</span></div>
              <div><span className="text-text-secondary">{t('calls.detail.direction')}</span> {callDirectionLabel(t, call.direction)}</div>
              <div><span className="text-text-secondary">{t('calls.detail.status')}</span> {callLifecycleLabel(t, call.lifecycle_state)}</div>
              <div><span className="text-text-secondary">{t('calls.detail.agent')}</span> {call.agent_name || '--'}</div>
              <div data-testid="call-detail-language">
                <span className="text-text-secondary">{t('calls.detail.language')}</span>{' '}
                {call.language ? getAgentLanguageLabel(call.language) : t('calls.detail.unknown_language')}
              </div>
              <div><span className="text-text-secondary">{t('calls.detail.duration')}</span> {call.duration_seconds ? t('calls.detail.duration_seconds', { seconds: call.duration_seconds }) : '--'}</div>
              <div><span className="text-text-secondary">{t('calls.detail.started')}</span> {call.start_time ? format(new Date(call.start_time), 'PPp') : '--'}</div>
              <div><span className="text-text-secondary">{t('calls.detail.ended')}</span> {call.end_time ? format(new Date(call.end_time), 'PPp') : '--'}</div>
            </div>
          </div>
        )}

        <CrmRecordsSection events={events} />

        {costBreakdown && (
          <div className="px-5 py-4 border-b border-border">
            <h3 className="text-sm font-semibold text-text-primary mb-3">{t('calls.detail.cost_breakdown_title')}</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div><span className="text-text-secondary">{t('calls.detail.cost_stt')}</span> {formatCents(costBreakdown.sttCostCents)}</div>
              <div><span className="text-text-secondary">{t('calls.detail.cost_llm')}</span> {formatCents(costBreakdown.llmCostCents)}</div>
              <div><span className="text-text-secondary">{t('calls.detail.cost_tts')}</span> {formatCents(costBreakdown.ttsCostCents)}</div>
              <div><span className="text-text-secondary">{t('calls.detail.cost_infra')}</span> {formatCents(costBreakdown.infraCostCents)}</div>
              <div className="col-span-2 font-semibold border-t border-border pt-1 mt-1">
                <span className="text-text-secondary">{t('calls.detail.cost_total')}</span> {formatCents(costBreakdown.totalCostCents)}
              </div>
              <div><span className="text-text-secondary">{t('calls.detail.cost_model')}</span> {costBreakdown.modelUsed}</div>
              <div><span className="text-text-secondary">{t('calls.detail.cost_tier')}</span> <span className="capitalize">{costBreakdown.modelTier}</span></div>
              <div><span className="text-text-secondary">{t('calls.detail.cost_input_tokens')}</span> {costBreakdown.inputTokens.toLocaleString()}</div>
              <div><span className="text-text-secondary">{t('calls.detail.cost_output_tokens')}</span> {costBreakdown.outputTokens.toLocaleString()}</div>
              {costBreakdown.cacheHits > 0 && (
                <div><span className="text-text-secondary">{t('calls.detail.cost_cache_hits')}</span> {costBreakdown.cacheHits}</div>
              )}
              {costBreakdown.promptTokensSaved > 0 && (
                <div><span className="text-text-secondary">{t('calls.detail.cost_tokens_saved')}</span> {costBreakdown.promptTokensSaved.toLocaleString()}</div>
              )}
            </div>
          </div>
        )}

        <div className="border-b border-border">
          <div className="flex px-5">
            <button onClick={() => setTab('transcript')}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition ${tab === 'transcript' ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
              {t('calls.detail.tab_transcript')}
            </button>
            <button onClick={() => setTab('events')}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition ${tab === 'events' ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
              {t('calls.detail.tab_count', { label: t('calls.detail.tab_events'), count: events.length })}
            </button>
            <button onClick={() => setTab('tools')}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition ${tab === 'tools' ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
              {t('calls.detail.tab_count', { label: t('calls.detail.tab_tools'), count: toolExecutions.length })}
            </button>
          </div>
        </div>

        <div className="px-5 py-4">
          {tab === 'transcript' && (
            <>
              {transcriptLoading ? (
                <SkeletonRows count={4} rowClassName="h-12" />
              ) : transcript.length === 0 ? (
                <EmptyState icon={PhoneCall} title={t('calls.detail.transcript_empty')} variant="compact" />
              ) : (
                <div className="space-y-3">
                  {transcript.map((entry) => (
                    <div key={entry.id || entry.sequence_number} className={`flex ${entry.role === 'assistant' ? 'justify-start' : 'justify-end'}`}>
                      <div className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm ${
                        entry.role === 'assistant'
                          ? 'bg-primary-light text-text-primary rounded-bl-sm'
                          : 'bg-surface-hover text-text-primary rounded-br-sm'
                      }`}>
                        <p className="text-xs font-medium text-text-secondary mb-1 capitalize">{entry.role}</p>
                        <p>{entry.content}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'events' && (
            <>
              {eventsLoading ? (
                <SkeletonRows count={4} rowClassName="h-12" />
              ) : events.length === 0 ? (
                <EmptyState icon={Circle} title={t('calls.detail.events_empty')} variant="compact" />
              ) : (
                <div className="relative">
                  <div className="absolute left-3 top-0 bottom-0 w-px bg-border" />
                  <div className="space-y-4">
                    {events.map((event) => {
                      const dispatchPayload = isConnectorDispatchEvent(event) ? event.payload : null;
                      const dispatchProvider = dispatchPayload?.provider ?? dispatchPayload?.meta?.provider;
                      const dispatchSuccess = dispatchPayload ? dispatchPayload.success !== false : null;
                      const eventLabel = dispatchPayload
                        ? t('calls.detail.event_dispatch_label', {
                            provider: dispatchProvider ?? dispatchPayload.connectorType ?? t('calls.detail.event_dispatch_default_provider'),
                            type: dispatchPayload.payloadType ?? t('calls.detail.event_dispatch_default_type'),
                          })
                        : event.event_type;
                      const dispatchStatusLabel =
                        dispatchSuccess === false
                          ? t('calls.detail.event_status_failed')
                          : dispatchSuccess === true
                            ? t('calls.detail.event_status_succeeded')
                            : t('calls.detail.event_status_recorded');
                      const dispatchTitle =
                        dispatchSuccess === false
                          ? t('calls.detail.event_dispatch_failed')
                          : dispatchSuccess === true
                            ? t('calls.detail.event_dispatch_succeeded')
                            : t('calls.detail.event_recorded');
                      const StatusIcon =
                        dispatchSuccess === false
                          ? XCircle
                          : dispatchSuccess === true
                            ? CheckCircle2
                            : Circle;
                      const statusBgClass =
                        dispatchSuccess === false
                          ? 'bg-danger text-white'
                          : dispatchSuccess === true
                            ? 'bg-primary text-white'
                            : 'bg-surface-hover text-text-secondary';
                      return (
                        <div key={event.id} className="relative pl-8">
                          <span
                            role="img"
                            aria-label={t('calls.detail.event_status_aria', { status: dispatchStatusLabel })}
                            title={dispatchTitle}
                            className={`absolute left-0 top-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-surface ${statusBgClass}`}
                          >
                            <StatusIcon className="h-3 w-3" aria-hidden="true" />
                          </span>
                          <div className="bg-surface-hover rounded-lg p-3">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-sm font-medium text-text-primary capitalize">{eventLabel}</span>
                              <span className="text-xs text-text-muted">{event.occurred_at ? format(new Date(event.occurred_at), 'h:mm:ss a') : '--'}</span>
                            </div>
                            {event.from_state && event.to_state && (
                              <p className="text-xs text-text-secondary">{event.from_state} → {event.to_state}</p>
                            )}
                            {dispatchPayload && dispatchSuccess === false && dispatchPayload.error && (
                              <p className="text-xs text-danger mt-1">{dispatchPayload.error}</p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          {tab === 'tools' && (
            <>
              {toolExecLoading ? (
                <SkeletonRows count={4} rowClassName="h-12" />
              ) : toolExecutions.length === 0 ? (
                <EmptyState icon={ClipboardCheck} title={t('calls.detail.tools_empty')} variant="compact" />
              ) : (
                <div className="space-y-3">
                  {toolExecutions.map((exec) => (
                    <div key={exec.id} className="bg-surface-hover rounded-lg p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium text-text-primary font-mono">{exec.toolName}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${exec.status === 'success' ? 'bg-success-light text-success' : exec.status === 'failed' ? 'bg-danger-light text-danger' : 'bg-warning-light text-warning'}`}>
                          {toolExecStatusLabel(t, exec.status)}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-text-muted mt-1">
                        <span>{exec.invokedAt ? format(new Date(exec.invokedAt), 'h:mm:ss a') : '--'}</span>
                        {exec.durationMs != null && <span>{t('calls.detail.duration_ms', { ms: exec.durationMs })}</span>}
                      </div>
                      {exec.errorMessage && (
                        <p className="text-xs text-danger mt-2">{exec.errorMessage}</p>
                      )}
                      {exec.recoveryAction && (
                        <p className="text-xs text-text-secondary mt-1 italic">{t('calls.detail.tool_recovery', { action: exec.recoveryAction })}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
    </Modal>
  );
}

function normalizeFilters(input: Partial<FiltersState> | null | undefined): FiltersState {
  const out: FiltersState = { ...EMPTY_FILTERS };
  if (!input) return out;
  (Object.keys(EMPTY_FILTERS) as Array<keyof FiltersState>).forEach((k) => {
    const v = input[k];
    if (typeof v === 'string') out[k] = v;
  });
  return out;
}

function filtersEqual(a: FiltersState, b: FiltersState): boolean {
  return (Object.keys(EMPTY_FILTERS) as Array<keyof FiltersState>).every((k) => (a[k] || '') === (b[k] || ''));
}

export default function Calls() {
  const { t: tenantT } = useTranslation('tenant');
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(() => Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1));
  const [selectedCall, setSelectedCall] = useState<string | null>(null);
  const [filters, setFilters] = useState<FiltersState>(() => ({
    agent_id: searchParams.get('agent_id') ?? '',
    direction: searchParams.get('direction') ?? '',
    lifecycle_state: searchParams.get('lifecycle_state') ?? '',
    dateRange: searchParams.get('dateRange') ?? '',
    has_transcript: searchParams.get('has_transcript') ?? '',
    has_events: searchParams.get('has_events') ?? '',
    has_tool_executions: searchParams.get('has_tool_executions') ?? '',
    tool_failures_only: searchParams.get('tool_failures_only') === 'true' ? 'true' : '',
    q: searchParams.get('q') ?? '',
  }));
  const [searchInput, setSearchInput] = useState<string>(searchParams.get('q') ?? '');
  const [showFilters, setShowFilters] = useState(false);
  const [activeViewId, setActiveViewId] = useState<string | null>(searchParams.get('view'));
  const [savingView, setSavingView] = useState(false);
  const [newViewName, setNewViewName] = useState('');
  const [newViewShared, setNewViewShared] = useState(false);
  const [newViewDigest, setNewViewDigest] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [subscribersOpenFor, setSubscribersOpenFor] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const limit = 20;

  useEffect(() => {
    const highlight = searchParams.get('highlight');
    if (highlight) {
      setSelectedCall(highlight);
      const next = new URLSearchParams(searchParams);
      next.delete('highlight');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== filters.q) {
        setFilters((f) => ({ ...f, q: searchInput }));
        setPage(1);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, filters.q]);

  // Sync state -> URL
  useEffect(() => {
    const next = new URLSearchParams();
    (Object.keys(filters) as Array<keyof FiltersState>).forEach((k) => {
      if (filters[k]) next.set(k, filters[k]);
    });
    if (page > 1) next.set('page', String(page));
    if (activeViewId) next.set('view', activeViewId);
    const highlight = searchParams.get('highlight');
    if (highlight) next.set('highlight', highlight);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page, activeViewId]);

  const { data: savedViewsData, isSuccess: savedViewsLoaded } = useQuery({
    queryKey: ['call-saved-views'],
    queryFn: () => api.get<{ views: SavedView[] }>('/call-saved-views'),
  });
  const savedViews = savedViewsData?.views ?? [];

  const activeView = useMemo(
    () => savedViews.find((v) => v.id === activeViewId) ?? null,
    [savedViews, activeViewId],
  );

  const { data: meData } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: { userId: string; email?: string } }>('/auth/me'),
  });
  const currentUserId = meData?.user?.userId ?? null;
  const currentUserEmail = meData?.user?.email?.toLowerCase() ?? null;

  // Reactively sync the URL's ?view=<id> into local state. Runs on every URL change so
  // that clicking a different pinned view in the sidebar (which only changes ?view=)
  // hydrates the corresponding saved view's filters, not just on initial mount.
  // On the very first hydration only, an explicit per-filter URL param wins over the
  // stored view's filters (preserves manually-shared deep links).
  const initialUrlHadExplicitFiltersRef = useRef<boolean>(
    (Object.keys(EMPTY_FILTERS) as Array<keyof FiltersState>).some((k) => Boolean(searchParams.get(k))),
  );
  const [syncedViewId, setSyncedViewId] = useState<string | null>(null);
  const hasInitialSyncedRef = useRef(false);
  useEffect(() => {
    const urlViewId = searchParams.get('view');
    if (urlViewId !== activeViewId) {
      setActiveViewId(urlViewId);
    }
    if (!urlViewId) {
      setSyncedViewId(null);
      hasInitialSyncedRef.current = true;
      return;
    }
    if (!savedViewsLoaded) return;
    if (syncedViewId === urlViewId) return;
    const match = savedViews.find((v) => v.id === urlViewId);
    if (!match) {
      // Stale id in URL — drop it from URL and state.
      const next = new URLSearchParams(searchParams);
      next.delete('view');
      setSearchParams(next, { replace: true });
      setActiveViewId(null);
      setSyncedViewId(null);
      hasInitialSyncedRef.current = true;
      return;
    }
    const isFirstSync = !hasInitialSyncedRef.current;
    const shouldApplyViewFilters = !isFirstSync || !initialUrlHadExplicitFiltersRef.current;
    if (shouldApplyViewFilters) {
      const viewFilters = normalizeFilters(match.filters);
      setFilters(viewFilters);
      setSearchInput(viewFilters.q);
      setPage(1);
    }
    setSyncedViewId(urlViewId);
    hasInitialSyncedRef.current = true;
  }, [searchParams, savedViews, savedViewsLoaded, activeViewId, syncedViewId, setSearchParams]);

  // If the active view's stored filters drift from the current filters, treat it as detached.
  // Suppress dirty state until the URL view has been synced into filters to avoid a flicker
  // of "Update view" while applying a freshly-clicked pinned view.
  const isViewDirty = useMemo(() => {
    if (!activeView) return false;
    if (syncedViewId !== activeView.id) return false;
    return !filtersEqual(filters, normalizeFilters(activeView.filters));
  }, [activeView, filters, syncedViewId]);

  const applySavedView = (view: SavedView) => {
    const next = normalizeFilters(view.filters);
    setFilters(next);
    setSearchInput(next.q);
    setActiveViewId(view.id);
    setPage(1);
  };

  const handleSaveView = async () => {
    const name = newViewName.trim();
    if (!name) {
      setSaveError(tenantT('calls.save_view_panel.name_required'));
      return;
    }
    setSaveError(null);
    try {
      const res = await api.post<{ view: SavedView }>('/call-saved-views', {
        name,
        filters,
        is_shared: newViewShared,
        is_pinned: false,
        digest_enabled: newViewDigest,
      });
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views'] });
      setActiveViewId(res.view.id);
      setSavingView(false);
      setNewViewName('');
      setNewViewShared(false);
      setNewViewDigest(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : tenantT('calls.save_view_panel.save_error'));
    }
  };

  const handleUpdateActiveView = async () => {
    if (!activeView) return;
    try {
      await api.patch(`/call-saved-views/${activeView.id}`, { filters });
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views'] });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : tenantT('calls.save_view_panel.update_error'));
    }
  };

  const handleToggleDigest = async (view: SavedView) => {
    try {
      await api.patch(`/call-saved-views/${view.id}`, { digest_enabled: !view.digest_enabled });
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views'] });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : tenantT('calls.save_view_panel.toggle_digest_error'));
    }
  };

  const handleToggleSubscribe = async (view: SavedView) => {
    if (!currentUserEmail) {
      setSaveError(tenantT('calls.save_view_panel.subscribe_needs_email'));
      return;
    }
    const current = (view.digest_subscribers ?? []).map((e) => e.toLowerCase());
    const isSubscribed = current.includes(currentUserEmail);
    const next = isSubscribed
      ? current.filter((e) => e !== currentUserEmail)
      : Array.from(new Set([...current, currentUserEmail]));
    try {
      await api.patch(`/call-saved-views/${view.id}`, { digest_subscribers: next });
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views'] });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : tenantT('calls.save_view_panel.subscribe_error'));
    }
  };

  const handleRemoveSubscriber = async (view: SavedView, email: string) => {
    const target = email.toLowerCase();
    const next = (view.digest_subscribers ?? []).filter((e) => e.toLowerCase() !== target);
    try {
      await api.patch(`/call-saved-views/${view.id}`, { digest_subscribers: next });
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views'] });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : tenantT('calls.save_view_panel.remove_subscriber_error'));
    }
  };

  const persistPinnedOrder = async (orderedIds: string[]) => {
    try {
      await api.post('/call-saved-views/pinned/reorder', { ids: orderedIds });
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views'] });
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views', 'pinned'] });
    } catch (err) {
      alert(tenantT('calls.save_view_panel.reorder_error', { message: err instanceof Error ? err.message : tenantT('calls.save_view_panel.reorder_unknown_error') }));
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views'] });
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views', 'pinned'] });
    }
  };

  const handleTogglePin = async (view: SavedView) => {
    try {
      await api.patch(`/call-saved-views/${view.id}`, { is_pinned: !view.is_pinned });
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views'] });
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views', 'pinned'] });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : tenantT('calls.save_view_panel.pin_error'));
    }
  };

  const handleDeleteView = async (id: string) => {
    if (!window.confirm(tenantT('calls.save_view_panel.delete_confirm'))) return;
    try {
      await api.delete(`/call-saved-views/${id}`);
      if (activeViewId === id) setActiveViewId(null);
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views'] });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : tenantT('calls.save_view_panel.delete_error'));
    }
  };

  const { data: agentsData } = useQuery({
    queryKey: ['agents', 'filter-list'],
    queryFn: () => api.get<{ agents: Agent[] }>('/agents?limit=100'),
  });

  const sinceIso = useMemo(() => {
    if (!filters.dateRange) return '';
    const now = new Date();
    if (filters.dateRange === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    if (filters.dateRange === '7d') return new Date(now.getTime() - 7 * 86400000).toISOString();
    if (filters.dateRange === '30d') return new Date(now.getTime() - 30 * 86400000).toISOString();
    return '';
  }, [filters.dateRange]);

  const filterParams = new URLSearchParams();
  filterParams.set('limit', String(limit));
  filterParams.set('page', String(page));
  if (filters.agent_id) filterParams.set('agent_id', filters.agent_id);
  if (filters.direction) filterParams.set('direction', filters.direction);
  if (filters.lifecycle_state) filterParams.set('lifecycle_state', filters.lifecycle_state);
  if (sinceIso) filterParams.set('since', sinceIso);
  if (filters.has_transcript) filterParams.set('has_transcript', filters.has_transcript);
  if (filters.has_events) filterParams.set('has_events', filters.has_events);
  if (filters.has_tool_executions) filterParams.set('has_tool_executions', filters.has_tool_executions);
  if (filters.tool_failures_only) filterParams.set('tool_failures_only', 'true');
  if (filters.q) filterParams.set('q', filters.q);

  const { data, isLoading } = useQuery({
    queryKey: ['calls', page, filters],
    queryFn: () => api.get<{ calls: Call[]; total: number }>(`/calls?${filterParams.toString()}`),
  });

  const calls = data?.calls ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit);
  const agents = agentsData?.agents ?? [];

  const setFilter = (key: keyof FiltersState, val: string) => {
    setFilters((f) => ({ ...f, [key]: val }));
    setPage(1);
  };

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setSearchInput('');
    setActiveViewId(null);
    setPage(1);
  };

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title={tenantT('calls.page_title')}
        description={tenantT('calls.page_subtitle')}
        actions={
          <>
            {activeView && isViewDirty && (
              <button
                onClick={handleUpdateActiveView}
                className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border border-border text-text-secondary hover:bg-surface-hover transition-colors"
                title={tenantT('calls.toolbar.update_view_tooltip', { name: activeView.name })}
              >
                <Star className="h-4 w-4" /> {tenantT('calls.toolbar.update_view')}
              </button>
            )}
            {activeFilterCount > 0 && !savingView && (
              <button
                onClick={() => { setSavingView(true); setSaveError(null); setNewViewName(''); setNewViewShared(false); setNewViewDigest(false); }}
                className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border border-border text-text-secondary hover:bg-surface-hover transition-colors"
              >
                <Bookmark className="h-4 w-4" /> {tenantT('calls.toolbar.save_view')}
              </button>
            )}
            <button onClick={() => setShowFilters(!showFilters)}
              className={`inline-flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-lg border transition-colors ${activeFilterCount > 0 ? 'border-primary text-primary bg-primary-light' : 'border-border text-text-secondary hover:bg-surface-hover'}`}>
              <Filter className="h-4 w-4" /> {tenantT('calls.toolbar.filters')} {activeFilterCount > 0 && `(${activeFilterCount})`}
            </button>
          </>
        }
      />

      {(savedViews.length > 0 || savingView) && (
        <Suspense fallback={<div className="flex flex-wrap items-center gap-2" data-testid="pinned-saved-views-bar-loading" />}>
          <PinnedSavedViewsBar
            savedViews={savedViews}
            activeViewId={activeViewId}
            setActiveViewId={setActiveViewId}
            isViewDirty={isViewDirty}
            currentUserId={currentUserId}
            currentUserEmail={currentUserEmail}
            subscribersOpenFor={subscribersOpenFor}
            setSubscribersOpenFor={setSubscribersOpenFor}
            applySavedView={applySavedView}
            handleTogglePin={handleTogglePin}
            handleToggleDigest={handleToggleDigest}
            handleToggleSubscribe={handleToggleSubscribe}
            handleDeleteView={handleDeleteView}
            persistPinnedOrder={persistPinnedOrder}
            clearFilters={clearFilters}
            queryClient={queryClient}
          />
        </Suspense>
      )}

      {subscribersOpenFor && (() => {
        const view = savedViews.find((v) => v.id === subscribersOpenFor);
        if (!view || view.created_by !== currentUserId) return null;
        const subs = view.digest_subscribers ?? [];
        return (
          <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <h3 className="text-sm font-semibold text-text-primary">
                  {tenantT('calls.subscribers_panel.title', { name: view.name })}
                </h3>
                <p className="text-xs text-text-secondary mt-0.5">
                  {tenantT('calls.subscribers_panel.description')}
                </p>
              </div>
              <button
                onClick={() => setSubscribersOpenFor(null)}
                className="p-1 rounded text-text-muted hover:text-text-primary"
                aria-label={tenantT('calls.subscribers_panel.close_aria')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {subs.length === 0 ? (
              <EmptyState icon={Mail} title={tenantT('calls.subscribers_panel.empty')} variant="compact" />
            ) : (
              <ul className="flex flex-wrap gap-2">
                {subs.map((email) => (
                  <li
                    key={email}
                    className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-hover pl-3 pr-1 py-1 text-sm text-text-primary"
                  >
                    <span className="truncate max-w-[240px]">{email}</span>
                    <button
                      onClick={() => handleRemoveSubscriber(view, email)}
                      className="p-1 rounded-full text-text-muted hover:text-danger transition"
                      title={tenantT('calls.subscribers_panel.remove_tooltip', { email })}
                      aria-label={tenantT('calls.subscribers_panel.remove_aria', { email, name: view.name })}
                    >
                      <UserMinus className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })()}

      {savingView && (
        <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-text-primary mb-2">{tenantT('calls.save_view_panel.title')}</h3>
          <div className="flex flex-wrap items-center gap-3">
            <input
              autoFocus
              type="text"
              value={newViewName}
              onChange={(e) => setNewViewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveView(); if (e.key === 'Escape') setSavingView(false); }}
              placeholder={tenantT('calls.save_view_panel.name_placeholder')}
              maxLength={120}
              className="flex-1 min-w-[220px] px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm"
            />
            <label className="inline-flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={newViewShared}
                onChange={(e) => setNewViewShared(e.target.checked)}
                className="rounded border-border"
              />
              {tenantT('calls.save_view_panel.share_label')}
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-text-primary" title={tenantT('calls.save_view_panel.digest_tooltip')}>
              <input
                type="checkbox"
                checked={newViewDigest}
                onChange={(e) => setNewViewDigest(e.target.checked)}
                className="rounded border-border"
              />
              <Mail className="h-3.5 w-3.5" />
              {tenantT('calls.save_view_panel.digest_label')}
            </label>
            <button
              onClick={handleSaveView}
              className="text-sm font-medium px-4 py-2 rounded-lg bg-primary text-white hover:bg-primary-hover transition"
            >
              {tenantT('calls.save_view_panel.save')}
            </button>
            <button
              onClick={() => { setSavingView(false); setSaveError(null); }}
              className="text-sm font-medium px-3 py-2 rounded-lg border border-border text-text-secondary hover:bg-surface-hover transition"
            >
              {tenantT('calls.save_view_panel.cancel')}
            </button>
          </div>
          {saveError && <p className="text-xs text-danger mt-2">{saveError}</p>}
        </div>
      )}

      {showFilters && (
        <div className="bg-surface border border-border rounded-xl p-4 shadow-sm space-y-3">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              {tenantT('calls.filters.search_label')}
            </label>
            <div className="relative">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={tenantT('calls.filters.search_placeholder')}
                className="w-full pl-9 pr-9 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => setSearchInput('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary"
                  aria-label={tenantT('calls.filters.clear_search_aria')}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">{tenantT('calls.filters.date_range_label')}</label>
              <select value={filters.dateRange} onChange={(e) => setFilter('dateRange', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">{tenantT('calls.filters.date_range_all')}</option>
                <option value="today">{tenantT('calls.filters.date_range_today')}</option>
                <option value="7d">{tenantT('calls.filters.date_range_7d')}</option>
                <option value="30d">{tenantT('calls.filters.date_range_30d')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">{tenantT('calls.filters.agent_label')}</label>
              <select value={filters.agent_id} onChange={(e) => setFilter('agent_id', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">{tenantT('calls.filters.agent_all')}</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">{tenantT('calls.filters.direction_label')}</label>
              <select value={filters.direction} onChange={(e) => setFilter('direction', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">{tenantT('calls.filters.direction_all')}</option>
                <option value="inbound">{tenantT('calls.filters.direction_inbound')}</option>
                <option value="outbound">{tenantT('calls.filters.direction_outbound')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">{tenantT('calls.filters.status_label')}</label>
              <select value={filters.lifecycle_state} onChange={(e) => setFilter('lifecycle_state', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">{tenantT('calls.filters.status_all')}</option>
                <option value="CALL_RECEIVED">{tenantT('calls.filters.status_received')}</option>
                <option value="CALL_CONNECTED">{tenantT('calls.filters.status_connected')}</option>
                <option value="CALL_ENDED">{tenantT('calls.filters.status_ended')}</option>
                <option value="CALL_FAILED">{tenantT('calls.filters.status_failed')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">{tenantT('calls.filters.transcript_label')}</label>
              <select value={filters.has_transcript} onChange={(e) => setFilter('has_transcript', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">{tenantT('calls.filters.any')}</option>
                <option value="true">{tenantT('calls.filters.has_transcript')}</option>
                <option value="false">{tenantT('calls.filters.no_transcript')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">{tenantT('calls.filters.events_label')}</label>
              <select value={filters.has_events} onChange={(e) => setFilter('has_events', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">{tenantT('calls.filters.any')}</option>
                <option value="true">{tenantT('calls.filters.has_events')}</option>
                <option value="false">{tenantT('calls.filters.no_events')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">{tenantT('calls.filters.tool_executions_label')}</label>
              <select value={filters.has_tool_executions} onChange={(e) => setFilter('has_tool_executions', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">{tenantT('calls.filters.any')}</option>
                <option value="true">{tenantT('calls.filters.has_tool_executions')}</option>
                <option value="false">{tenantT('calls.filters.no_tool_executions')}</option>
              </select>
            </div>
            <div className="flex items-end">
              <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface text-sm text-text-primary cursor-pointer w-full">
                <input
                  type="checkbox"
                  checked={filters.tool_failures_only === 'true'}
                  onChange={(e) => setFilter('tool_failures_only', e.target.checked ? 'true' : '')}
                  className="rounded border-border"
                />
                <AlertTriangle className="h-4 w-4 text-danger" />
                {tenantT('calls.filters.tool_failures_only')}
              </label>
            </div>
          </div>
          {activeFilterCount > 0 && (
            <button onClick={clearFilters}
              className="text-xs text-primary hover:text-primary-hover font-medium">{tenantT('calls.filters.clear_all')}</button>
          )}
        </div>
      )}

      {isLoading ? (
        <SkeletonRows count={6} rowClassName="h-16" />
      ) : calls.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl" data-testid="tenant-calls-list">
          {activeFilterCount > 0 ? (
            <EmptyState
              icon={Filter}
              title={tenantT('calls.empty.filtered_title')}
              description={tenantT('calls.empty.filtered_description')}
              primaryAction={{
                label: tenantT('calls.empty.clear_filters'),
                onClick: clearFilters,
              }}
            />
          ) : (
            <EmptyState
              icon={PhoneCall}
              title={tenantT('calls.empty.no_calls_title')}
              description={tenantT('calls.empty.no_calls_description')}
            />
          )}
        </div>
      ) : (
        <>
          <div
            className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden"
            data-testid="tenant-calls-list"
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-5 py-3 text-text-secondary font-medium">{tenantT('calls.table.agent')}</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">{tenantT('calls.table.language')}</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">{tenantT('calls.table.direction')}</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">{tenantT('calls.table.status')}</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">{tenantT('calls.table.duration')}</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">{tenantT('calls.table.date')}</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((call) => (
                  <tr key={call.id} onClick={() => setSelectedCall(call.id)}
                    className="border-b border-border last:border-0 hover:bg-surface-hover cursor-pointer transition-colors">
                    <td className="px-5 py-3 text-text-primary">{call.agent_name || '--'}</td>
                    <td className="px-5 py-3 text-text-secondary">
                      {call.language ? getAgentLanguageLabel(call.language) : '--'}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${call.direction === 'inbound' ? 'bg-info-light text-info' : 'bg-warning-light text-warning'}`}>
                        {callDirectionLabel(tenantT, call.direction)}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${['CALL_CONNECTED', 'active'].includes(call.lifecycle_state) ? 'bg-success-light text-success' : 'bg-surface-hover text-text-secondary'}`}>
                          {callLifecycleLabel(tenantT, call.lifecycle_state)}
                        </span>
                        {call.failed_tool_count && call.failed_tool_count > 0 ? (
                          <span
                            title={tenantT('calls.table.failed_tool_tooltip', { count: call.failed_tool_count })}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs font-medium bg-danger-light text-danger"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {tenantT('calls.table.failed_tool_badge', { count: call.failed_tool_count })}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-text-secondary">{call.duration_seconds ? tenantT('calls.table.duration_seconds', { seconds: call.duration_seconds }) : '--'}</td>
                    <td className="px-5 py-3 text-text-secondary">{call.start_time ? format(new Date(call.start_time), 'MMM d, h:mm a') : '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-text-secondary">{tenantT('calls.pagination.total', { count: total })}</p>
              <div className="flex items-center gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                  className="p-2 rounded-lg border border-border hover:bg-surface-hover disabled:opacity-30 transition" aria-label={tenantT('calls.pagination.previous_aria')}><ChevronLeft className="h-4 w-4" /></button>
                <span className="text-sm text-text-secondary">{tenantT('calls.pagination.page_of', { page, total: totalPages })}</span>
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="p-2 rounded-lg border border-border hover:bg-surface-hover disabled:opacity-30 transition" aria-label={tenantT('calls.pagination.next_aria')}><ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>
          )}
        </>
      )}

      {selectedCall && <CallDetailDrawer callId={selectedCall} onClose={() => setSelectedCall(null)} />}
    </div>
  );
}
