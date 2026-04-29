import { useState, useEffect, useMemo, useRef, Fragment, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { formatCents as formatCentsHelper } from '../lib/formatCurrency';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
import { PhoneCall, X, ChevronLeft, ChevronRight, Filter, AlertTriangle, Search, Star, Bookmark, Trash2, Users, Mail, MailX, UserMinus, Pin, PinOff, GripVertical, ExternalLink, ArrowRightLeft, UserPlus, Building2, Briefcase, ClipboardCheck, Cloud, CheckCircle2, XCircle, Circle } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import EmptyState from '../components/EmptyState';
import { SkeletonRows } from '../components/state';
import { PageHeader } from '../components/ui';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import Modal from '../components/Modal';
import { getAgentLanguageLabel } from '../lib/agentLanguages';

type PinnedDragHandleProps = {
  attributes: ReturnType<typeof useSortable>['attributes'];
  listeners: ReturnType<typeof useSortable>['listeners'];
};

type PinnedSortableState = {
  setNodeRef: (el: HTMLElement | null) => void;
  style: React.CSSProperties;
  isDragging: boolean;
  handle: PinnedDragHandleProps;
};

function SortablePinnedChip({
  id,
  render,
}: {
  id: string;
  render: (state: PinnedSortableState) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
    opacity: isDragging ? 0.85 : undefined,
  };
  return <>{render({ setNodeRef, style, isDragging, handle: { attributes, listeners } })}</>;
}

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
  const payload = event.payload;
  const meta = payload.meta ?? {};
  const instanceUrl = meta.instanceUrl;
  const isSuccess = payload.success !== false;
  const eventLabel = (() => {
    switch (meta.eventType ?? payload.payloadType) {
      case 'call.completed': return 'Call logged';
      case 'appointment.booked': return 'Appointment booked';
      default: return payload.payloadType ?? 'Event dispatched';
    }
  })();

  const records: Array<{ icon: typeof UserPlus; label: string; sobject: string; id: string | undefined; sublabel?: string }> = [];
  if (meta.convertedFromLead && meta.convertedFromLeadId) {
    records.push({ icon: ArrowRightLeft, label: 'Converted from Lead', sobject: 'Lead', id: meta.convertedFromLeadId, sublabel: 'Lead → Contact' });
  }
  if (meta.contactId || (meta.whoObject === 'Contact' && meta.whoId)) {
    const id = meta.contactId ?? meta.whoId;
    records.push({
      icon: UserPlus,
      label: meta.contactId ? 'Contact (created/linked)' : 'Contact attached',
      sobject: 'Contact',
      id,
    });
  } else if (meta.whoObject === 'Lead' && meta.whoId) {
    records.push({ icon: UserPlus, label: 'Lead attached', sobject: 'Lead', id: meta.whoId });
  }
  if (meta.accountId) {
    records.push({ icon: Building2, label: 'Account', sobject: 'Account', id: meta.accountId });
  }
  if (meta.opportunityId) {
    records.push({ icon: Briefcase, label: 'Opportunity', sobject: 'Opportunity', id: meta.opportunityId });
  }
  if (meta.taskId) {
    records.push({ icon: ClipboardCheck, label: 'Activity (Task)', sobject: 'Task', id: meta.taskId });
  }
  if (meta.whatId && !meta.opportunityId && !meta.accountId && meta.whatObject && meta.whatObject !== 'Task' && meta.whatObject !== 'Event') {
    const icon = meta.whatObject === 'Opportunity' ? Briefcase : Building2;
    records.push({ icon, label: `Related ${meta.whatObject}`, sobject: meta.whatObject, id: meta.whatId });
  }

  return (
    <div className="bg-surface-hover rounded-lg p-3 border border-border">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Cloud className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <span className="text-sm font-medium text-text-primary">Salesforce</span>
          {meta.pipelineMode && (
            <span className="text-[10px] uppercase tracking-wide text-text-muted bg-surface px-1.5 py-0.5 rounded">{meta.pipelineMode}</span>
          )}
          {payload.usedFallback && (
            <span className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-1.5 py-0.5 rounded">fallback</span>
          )}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${isSuccess ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'}`}>
          {isSuccess ? 'success' : 'failed'}
        </span>
      </div>

      <div className="text-xs text-text-secondary mb-2 flex items-center justify-between">
        <span>{eventLabel}</span>
        <span className="text-text-muted">{event.occurred_at ? format(new Date(event.occurred_at), 'h:mm:ss a') : '--'}</span>
      </div>

      {!isSuccess && payload.error && (
        <p className="text-xs text-red-600 dark:text-red-400 mb-2">{payload.error}</p>
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
        isSuccess && <p className="text-xs text-text-muted">No records returned</p>
      )}
    </div>
  );
}

function GenericConnectorCard({ event }: { event: CallEvent & { payload: ConnectorDispatchPayload } }) {
  const payload = event.payload;
  const isSuccess = payload.success !== false;
  return (
    <div className="bg-surface-hover rounded-lg p-3 border border-border">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-text-primary capitalize">
          {payload.provider ?? payload.connectorType ?? 'Connector'}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${isSuccess ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'}`}>
          {isSuccess ? 'success' : 'failed'}
        </span>
      </div>
      <div className="text-xs text-text-secondary flex items-center justify-between">
        <span>{payload.payloadType ?? '--'}</span>
        <span className="text-text-muted">{event.occurred_at ? format(new Date(event.occurred_at), 'h:mm:ss a') : '--'}</span>
      </div>
      {!isSuccess && payload.error && (
        <p className="text-xs text-red-600 dark:text-red-400 mt-2">{payload.error}</p>
      )}
      {payload.externalId && (
        <p className="text-xs text-text-muted mt-1 font-mono">id: {shortId(payload.externalId)}</p>
      )}
    </div>
  );
}

function CrmRecordsSection({ events }: { events: CallEvent[] }) {
  const dispatchEvents = useMemo(
    () => events.filter(isConnectorDispatchEvent),
    [events],
  );
  if (dispatchEvents.length === 0) return null;

  return (
    <div className="px-5 py-4 border-b border-border">
      <h3 className="text-sm font-semibold text-text-primary mb-3">CRM &amp; Connector Records</h3>
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
  const hasAnyStir =
    Boolean(call.stir_attestation) ||
    Boolean(call.stir_status) ||
    Boolean(call.stir_verstat);
  if (!hasAnyStir) return null;

  const degraded = isStirDegraded(call);
  const attestation = call.stir_attestation ?? null;
  const label = attestation
    ? `STIR ${attestation}`
    : call.stir_status
      ? `STIR ${call.stir_status}`
      : 'STIR unverified';
  const tooltipParts: string[] = [];
  if (attestation) tooltipParts.push(`Attestation level ${attestation}`);
  if (call.stir_status) tooltipParts.push(`Status: ${call.stir_status}`);
  if (call.stir_verstat) tooltipParts.push(`Verstat: ${call.stir_verstat}`);
  if (degraded && !attestation) tooltipParts.push('Carrier did not validate the caller ID');

  const cls = degraded
    ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-300 border border-amber-300 dark:border-amber-700'
    : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 border border-green-300 dark:border-green-800';

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

function CallDetailDrawer({ callId, onClose }: { callId: string; onClose: () => void }) {
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
      ariaLabel="Call Details"
      containerClassName="fixed inset-0 z-50 flex justify-end"
      panelClassName="w-full max-w-lg bg-surface h-full overflow-y-auto shadow-xl border-l border-border"
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-surface z-10">
          <h2 className="text-lg font-semibold text-text-primary">Call Details</h2>
          <button onClick={onClose} aria-label="Close"><X className="h-5 w-5 text-text-secondary hover:text-text-primary" /></button>
        </div>

        {call && (
          <div className="px-5 py-4 border-b border-border space-y-2">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-text-secondary">From:</span>
                <span className="font-mono text-xs">{call.caller_number}</span>
                <StirAttestationBadge call={call} />
              </div>
              <div><span className="text-text-secondary">To:</span> <span className="font-mono text-xs">{call.called_number}</span></div>
              <div><span className="text-text-secondary">Direction:</span> {call.direction}</div>
              <div><span className="text-text-secondary">Status:</span> {call.lifecycle_state}</div>
              <div><span className="text-text-secondary">Agent:</span> {call.agent_name || '--'}</div>
              <div data-testid="call-detail-language">
                <span className="text-text-secondary">Language:</span>{' '}
                {call.language ? getAgentLanguageLabel(call.language) : 'Unknown'}
              </div>
              <div><span className="text-text-secondary">Duration:</span> {call.duration_seconds ? `${call.duration_seconds}s` : '--'}</div>
              <div><span className="text-text-secondary">Started:</span> {call.start_time ? format(new Date(call.start_time), 'PPp') : '--'}</div>
              <div><span className="text-text-secondary">Ended:</span> {call.end_time ? format(new Date(call.end_time), 'PPp') : '--'}</div>
            </div>
          </div>
        )}

        <CrmRecordsSection events={events} />

        {costBreakdown && (
          <div className="px-5 py-4 border-b border-border">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Cost Breakdown</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div><span className="text-text-secondary">STT:</span> {formatCents(costBreakdown.sttCostCents)}</div>
              <div><span className="text-text-secondary">LLM:</span> {formatCents(costBreakdown.llmCostCents)}</div>
              <div><span className="text-text-secondary">TTS:</span> {formatCents(costBreakdown.ttsCostCents)}</div>
              <div><span className="text-text-secondary">Infra:</span> {formatCents(costBreakdown.infraCostCents)}</div>
              <div className="col-span-2 font-semibold border-t border-border pt-1 mt-1">
                <span className="text-text-secondary">Total:</span> {formatCents(costBreakdown.totalCostCents)}
              </div>
              <div><span className="text-text-secondary">Model:</span> {costBreakdown.modelUsed}</div>
              <div><span className="text-text-secondary">Tier:</span> <span className="capitalize">{costBreakdown.modelTier}</span></div>
              <div><span className="text-text-secondary">Input Tokens:</span> {costBreakdown.inputTokens.toLocaleString()}</div>
              <div><span className="text-text-secondary">Output Tokens:</span> {costBreakdown.outputTokens.toLocaleString()}</div>
              {costBreakdown.cacheHits > 0 && (
                <div><span className="text-text-secondary">Cache Hits:</span> {costBreakdown.cacheHits}</div>
              )}
              {costBreakdown.promptTokensSaved > 0 && (
                <div><span className="text-text-secondary">Tokens Saved:</span> {costBreakdown.promptTokensSaved.toLocaleString()}</div>
              )}
            </div>
          </div>
        )}

        <div className="border-b border-border">
          <div className="flex px-5">
            <button onClick={() => setTab('transcript')}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition ${tab === 'transcript' ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
              Transcript
            </button>
            <button onClick={() => setTab('events')}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition ${tab === 'events' ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
              Events ({events.length})
            </button>
            <button onClick={() => setTab('tools')}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition ${tab === 'tools' ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
              Tools ({toolExecutions.length})
            </button>
          </div>
        </div>

        <div className="px-5 py-4">
          {tab === 'transcript' && (
            <>
              {transcriptLoading ? (
                <p className="text-sm text-text-secondary">Loading transcript...</p>
              ) : transcript.length === 0 ? (
                <p className="text-sm text-text-secondary">No transcript available</p>
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
                <p className="text-sm text-text-secondary">Loading events...</p>
              ) : events.length === 0 ? (
                <p className="text-sm text-text-secondary">No events recorded</p>
              ) : (
                <div className="relative">
                  <div className="absolute left-3 top-0 bottom-0 w-px bg-border" />
                  <div className="space-y-4">
                    {events.map((event) => {
                      const dispatchPayload = isConnectorDispatchEvent(event) ? event.payload : null;
                      const dispatchProvider = dispatchPayload?.provider ?? dispatchPayload?.meta?.provider;
                      const dispatchSuccess = dispatchPayload ? dispatchPayload.success !== false : null;
                      const eventLabel = dispatchPayload
                        ? `${dispatchProvider ?? dispatchPayload.connectorType ?? 'connector'} · ${dispatchPayload.payloadType ?? 'dispatched'}`
                        : event.event_type;
                      const dispatchStatusLabel =
                        dispatchSuccess === false
                          ? 'failed'
                          : dispatchSuccess === true
                            ? 'succeeded'
                            : 'recorded';
                      const dispatchTitle =
                        dispatchSuccess === false
                          ? 'Dispatch failed'
                          : dispatchSuccess === true
                            ? 'Dispatch succeeded'
                            : 'Event recorded';
                      const StatusIcon =
                        dispatchSuccess === false
                          ? XCircle
                          : dispatchSuccess === true
                            ? CheckCircle2
                            : Circle;
                      const statusBgClass =
                        dispatchSuccess === false
                          ? 'bg-red-500 text-white'
                          : dispatchSuccess === true
                            ? 'bg-primary text-white'
                            : 'bg-surface-hover text-text-secondary';
                      return (
                        <div key={event.id} className="relative pl-8">
                          <span
                            role="img"
                            aria-label={`Event ${dispatchStatusLabel}`}
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
                              <p className="text-xs text-red-600 dark:text-red-400 mt-1">{dispatchPayload.error}</p>
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
                <p className="text-sm text-text-secondary">Loading tool executions...</p>
              ) : toolExecutions.length === 0 ? (
                <p className="text-sm text-text-secondary">No tool executions for this call</p>
              ) : (
                <div className="space-y-3">
                  {toolExecutions.map((exec) => (
                    <div key={exec.id} className="bg-surface-hover rounded-lg p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium text-text-primary font-mono">{exec.toolName}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${exec.status === 'success' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : exec.status === 'failed' ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'}`}>
                          {exec.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-text-muted mt-1">
                        <span>{exec.invokedAt ? format(new Date(exec.invokedAt), 'h:mm:ss a') : '--'}</span>
                        {exec.durationMs != null && <span>{exec.durationMs}ms</span>}
                      </div>
                      {exec.errorMessage && (
                        <p className="text-xs text-red-600 dark:text-red-400 mt-2">{exec.errorMessage}</p>
                      )}
                      {exec.recoveryAction && (
                        <p className="text-xs text-text-secondary mt-1 italic">Recovery: {exec.recoveryAction}</p>
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

const EMPTY_FILTERS = {
  agent_id: '',
  direction: '',
  lifecycle_state: '',
  dateRange: '',
  has_transcript: '',
  has_events: '',
  has_tool_executions: '',
  tool_failures_only: '',
  q: '',
};

type FiltersState = typeof EMPTY_FILTERS;

interface SavedView {
  id: string;
  name: string;
  filters: Partial<FiltersState>;
  is_shared: boolean;
  is_pinned: boolean;
  pin_order: number;
  created_by: string | null;
  digest_enabled?: boolean;
  digest_subscribers?: string[];
  digest_last_run_at?: string | null;
  digest_last_match_count?: number | null;
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
  const pinnedDragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
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
      setSaveError('Please enter a name');
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
      setSaveError(err instanceof Error ? err.message : 'Failed to save view');
    }
  };

  const handleUpdateActiveView = async () => {
    if (!activeView) return;
    try {
      await api.patch(`/call-saved-views/${activeView.id}`, { filters });
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views'] });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to update view');
    }
  };

  const handleToggleDigest = async (view: SavedView) => {
    try {
      await api.patch(`/call-saved-views/${view.id}`, { digest_enabled: !view.digest_enabled });
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views'] });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to toggle digest');
    }
  };

  const handleToggleSubscribe = async (view: SavedView) => {
    if (!currentUserEmail) {
      setSaveError('Your account needs an email to subscribe.');
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
      setSaveError(err instanceof Error ? err.message : 'Failed to update subscription');
    }
  };

  const handleRemoveSubscriber = async (view: SavedView, email: string) => {
    const target = email.toLowerCase();
    const next = (view.digest_subscribers ?? []).filter((e) => e.toLowerCase() !== target);
    try {
      await api.patch(`/call-saved-views/${view.id}`, { digest_subscribers: next });
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views'] });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to remove subscriber');
    }
  };

  const persistPinnedOrder = async (orderedIds: string[]) => {
    try {
      await api.post('/call-saved-views/pinned/reorder', { ids: orderedIds });
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views'] });
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views', 'pinned'] });
    } catch (err) {
      alert(`Failed to reorder pinned view: ${err instanceof Error ? err.message : 'Unknown error'}`);
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
      setSaveError(err instanceof Error ? err.message : 'Failed to pin view');
    }
  };

  const handleDeleteView = async (id: string) => {
    if (!window.confirm('Delete this saved view?')) return;
    try {
      await api.delete(`/call-saved-views/${id}`);
      if (activeViewId === id) setActiveViewId(null);
      await queryClient.invalidateQueries({ queryKey: ['call-saved-views'] });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to delete view');
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
                title={`Save current filters into "${activeView.name}"`}
              >
                <Star className="h-4 w-4" /> Update view
              </button>
            )}
            {activeFilterCount > 0 && !savingView && (
              <button
                onClick={() => { setSavingView(true); setSaveError(null); setNewViewName(''); setNewViewShared(false); setNewViewDigest(false); }}
                className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border border-border text-text-secondary hover:bg-surface-hover transition-colors"
              >
                <Bookmark className="h-4 w-4" /> Save view
              </button>
            )}
            <button onClick={() => setShowFilters(!showFilters)}
              className={`inline-flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-lg border transition-colors ${activeFilterCount > 0 ? 'border-primary text-primary bg-primary-light' : 'border-border text-text-secondary hover:bg-surface-hover'}`}>
              <Filter className="h-4 w-4" /> Filters {activeFilterCount > 0 && `(${activeFilterCount})`}
            </button>
          </>
        }
      />

      {(savedViews.length > 0 || savingView) && (() => {
        // Pins are per-user, so any view this user has pinned (whether they own it or not)
        // participates in their personal drag-to-reorder list.
        const myPinnedOrdered = savedViews
          .filter((v) => v.is_pinned)
          .sort((a, b) => ((a.pin_order ?? 0) - (b.pin_order ?? 0)) || a.name.localeCompare(b.name));
        const myPinnedIndex = new Map(myPinnedOrdered.map((v, i) => [v.id, i]));
        const pinnedIds = myPinnedOrdered.map((v) => v.id);

        const handleDragEnd = (event: DragEndEvent) => {
          const { active, over } = event;
          if (!over || active.id === over.id) return;
          const oldIdx = pinnedIds.indexOf(String(active.id));
          const newIdx = pinnedIds.indexOf(String(over.id));
          if (oldIdx === -1 || newIdx === -1) return;
          const reordered = arrayMove(pinnedIds, oldIdx, newIdx);
          // Optimistically update the cached saved views so the chips don't snap back.
          queryClient.setQueryData<{ views: SavedView[] }>(['call-saved-views'], (prev) => {
            if (!prev?.views) return prev;
            const orderMap = new Map(reordered.map((id, i) => [id, i]));
            const next = prev.views.map((v) =>
              orderMap.has(v.id) ? { ...v, pin_order: orderMap.get(v.id)! } : v,
            );
            return { ...prev, views: next };
          });
          void persistPinnedOrder(reordered);
        };

        const renderChipMarkup = (view: SavedView, sortable: PinnedSortableState | null) => {
          const isActive = activeViewId === view.id && !isViewDirty;
          const isOwner = !!currentUserId && view.created_by === currentUserId;
          const myPinIdx = myPinnedIndex.get(view.id);
          const isSortablePinned = myPinIdx !== undefined && myPinnedOrdered.length > 1;
          const lastRunRel = view.digest_last_run_at
            ? formatDistanceToNow(new Date(view.digest_last_run_at), { addSuffix: true })
            : null;
          const lastRunAbs = view.digest_last_run_at
            ? format(new Date(view.digest_last_run_at), 'PPp')
            : null;
          const matchCount = view.digest_last_match_count ?? 0;
          const digestStatus = view.digest_enabled
            ? (lastRunRel
                ? `Last digest ran ${lastRunRel} (${lastRunAbs}) — ${matchCount} matching call${matchCount === 1 ? '' : 's'}`
                : 'Daily digest is on — has not run yet')
            : null;
          return (
              <div
                ref={sortable?.setNodeRef}
                style={sortable?.style}
                className={`group inline-flex items-center gap-1 rounded-full border text-sm transition ${isActive ? 'border-primary bg-primary-light text-primary' : 'border-border bg-surface text-text-secondary hover:bg-surface-hover'} ${sortable?.isDragging ? 'shadow-lg ring-2 ring-primary/40' : ''}`}
              >
                {isSortablePinned && sortable && (
                  <button
                    type="button"
                    {...sortable.handle.attributes}
                    {...sortable.handle.listeners}
                    className="touch-none cursor-grab active:cursor-grabbing pl-2 pr-0.5 py-1.5 text-text-muted hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-l-full"
                    title="Drag to reorder (or use Space + arrow keys)"
                    aria-label={`Reorder pinned view ${view.name}`}
                  >
                    <GripVertical className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  onClick={() => applySavedView(view)}
                  className={`inline-flex items-center gap-1.5 ${isSortablePinned ? 'pl-1' : 'pl-3'} pr-2 py-1.5 font-medium`}
                  title={[
                    view.is_shared ? (isOwner ? 'Shared with team' : 'Shared by a teammate') : 'Personal view',
                    digestStatus,
                  ].filter(Boolean).join('\n')}
                >
                  {view.is_shared ? <Users className="h-3.5 w-3.5" /> : <Star className="h-3.5 w-3.5" />}
                  {view.name}
                </button>
                {view.digest_enabled && (
                  <span
                    className="text-xs text-text-muted whitespace-nowrap"
                    title={digestStatus ?? undefined}
                  >
                    · {lastRunRel ? `${matchCount} ${lastRunRel}` : 'not run yet'}
                  </span>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); handleTogglePin(view); }}
                  className={`p-1 ${isOwner ? '' : 'mr-1'} rounded-full transition ${view.is_pinned ? 'text-primary' : 'text-text-muted hover:text-primary'}`}
                  title={view.is_pinned ? 'Unpin from my sidebar' : 'Pin to my sidebar'}
                  aria-label={view.is_pinned ? `Unpin saved view ${view.name} from my sidebar` : `Pin saved view ${view.name} to my sidebar`}
                >
                  {view.is_pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                </button>
                {isOwner ? (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleToggleDigest(view); }}
                      className={`p-1 rounded-full transition ${view.digest_enabled ? 'text-primary' : 'text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100'}`}
                      title={
                        view.digest_enabled
                          ? `Daily email digest is on — click to turn off\n${digestStatus ?? ''}`.trim()
                          : 'Send me a daily email digest'
                      }
                      aria-label={view.digest_enabled ? `Turn off daily digest for ${view.name}` : `Turn on daily digest for ${view.name}`}
                    >
                      {view.digest_enabled ? <Mail className="h-3.5 w-3.5" /> : <MailX className="h-3.5 w-3.5" />}
                    </button>
                    {view.is_shared && (view.digest_subscribers?.length ?? 0) > 0 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setSubscribersOpenFor(subscribersOpenFor === view.id ? null : view.id); }}
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs transition ${subscribersOpenFor === view.id ? 'bg-primary text-white' : 'text-text-muted hover:text-text-primary'}`}
                        title={`${view.digest_subscribers!.length} teammate${view.digest_subscribers!.length === 1 ? '' : 's'} subscribed — click to manage`}
                        aria-label={`Manage ${view.digest_subscribers!.length} subscribers for ${view.name}`}
                        aria-expanded={subscribersOpenFor === view.id}
                      >
                        <Users className="h-3.5 w-3.5" />
                        {view.digest_subscribers!.length}
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteView(view.id); }}
                      className="p-1 mr-1 rounded-full text-text-muted hover:text-red-600 opacity-0 group-hover:opacity-100 transition"
                      title="Delete view"
                      aria-label={`Delete saved view ${view.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (view.is_shared && view.digest_enabled && currentUserEmail) ? (
                  (() => {
                    const subscribed = (view.digest_subscribers ?? []).map((e) => e.toLowerCase()).includes(currentUserEmail);
                    return (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggleSubscribe(view); }}
                        className={`p-1 mr-1 rounded-full transition ${subscribed ? 'text-primary' : 'text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100'}`}
                        title={subscribed ? 'You are subscribed to this digest — click to unsubscribe' : 'Subscribe me to this daily digest'}
                        aria-label={subscribed ? `Unsubscribe from ${view.name} digest` : `Subscribe to ${view.name} digest`}
                      >
                        {subscribed ? <Mail className="h-3.5 w-3.5" /> : <MailX className="h-3.5 w-3.5" />}
                      </button>
                    );
                  })()
                ) : null}
              </div>
            );
        };

        return (
          <DndContext
            sensors={pinnedDragSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={pinnedIds} strategy={rectSortingStrategy}>
              <div className="flex flex-wrap items-center gap-2">
                {savedViews.map((view) => {
                  const isMyPinnedSortable =
                    view.is_pinned && myPinnedOrdered.length > 1;
                  if (isMyPinnedSortable) {
                    return (
                      <SortablePinnedChip
                        key={view.id}
                        id={view.id}
                        render={(s) => renderChipMarkup(view, s)}
                      />
                    );
                  }
                  return <Fragment key={view.id}>{renderChipMarkup(view, null)}</Fragment>;
                })}
                {activeViewId && (
                  <button
                    onClick={() => { setActiveViewId(null); clearFilters(); }}
                    className="text-xs text-text-secondary hover:text-text-primary px-2 py-1"
                  >
                    Reset
                  </button>
                )}
              </div>
            </SortableContext>
          </DndContext>
        );
      })()}

      {subscribersOpenFor && (() => {
        const view = savedViews.find((v) => v.id === subscribersOpenFor);
        if (!view || view.created_by !== currentUserId) return null;
        const subs = view.digest_subscribers ?? [];
        return (
          <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <h3 className="text-sm font-semibold text-text-primary">
                  Digest subscribers — {view.name}
                </h3>
                <p className="text-xs text-text-secondary mt-0.5">
                  Teammates who opted in to this shared view's daily email.
                </p>
              </div>
              <button
                onClick={() => setSubscribersOpenFor(null)}
                className="p-1 rounded text-text-muted hover:text-text-primary"
                aria-label="Close subscribers panel"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {subs.length === 0 ? (
              <p className="text-sm text-text-secondary">No teammates have subscribed yet.</p>
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
                      className="p-1 rounded-full text-text-muted hover:text-red-600 transition"
                      title={`Remove ${email}`}
                      aria-label={`Remove ${email} from ${view.name} digest`}
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
          <h3 className="text-sm font-semibold text-text-primary mb-2">Save current filters as a view</h3>
          <div className="flex flex-wrap items-center gap-3">
            <input
              autoFocus
              type="text"
              value={newViewName}
              onChange={(e) => setNewViewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveView(); if (e.key === 'Escape') setSavingView(false); }}
              placeholder='e.g. "Failed tools, last 24h"'
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
              Share with my team
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-text-primary" title="We'll email you once a day if any new calls match this view in the last 24 hours.">
              <input
                type="checkbox"
                checked={newViewDigest}
                onChange={(e) => setNewViewDigest(e.target.checked)}
                className="rounded border-border"
              />
              <Mail className="h-3.5 w-3.5" />
              Email me a daily summary
            </label>
            <button
              onClick={handleSaveView}
              className="text-sm font-medium px-4 py-2 rounded-lg bg-primary text-white hover:bg-primary-hover transition"
            >
              Save
            </button>
            <button
              onClick={() => { setSavingView(false); setSaveError(null); }}
              className="text-sm font-medium px-3 py-2 rounded-lg border border-border text-text-secondary hover:bg-surface-hover transition"
            >
              Cancel
            </button>
          </div>
          {saveError && <p className="text-xs text-red-600 mt-2">{saveError}</p>}
        </div>
      )}

      {showFilters && (
        <div className="bg-surface border border-border rounded-xl p-4 shadow-sm space-y-3">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              Search caller number or call ID
            </label>
            <div className="relative">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="e.g. +1555 or partial call ID"
                className="w-full pl-9 pr-9 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => setSearchInput('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary"
                  aria-label="Clear search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Date Range</label>
              <select value={filters.dateRange} onChange={(e) => setFilter('dateRange', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">All Time</option>
                <option value="today">Today</option>
                <option value="7d">Last 7 Days</option>
                <option value="30d">Last 30 Days</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Agent</label>
              <select value={filters.agent_id} onChange={(e) => setFilter('agent_id', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">All Agents</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Direction</label>
              <select value={filters.direction} onChange={(e) => setFilter('direction', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">All</option>
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Status</label>
              <select value={filters.lifecycle_state} onChange={(e) => setFilter('lifecycle_state', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">All</option>
                <option value="CALL_RECEIVED">Received</option>
                <option value="CALL_CONNECTED">Connected</option>
                <option value="CALL_ENDED">Ended</option>
                <option value="CALL_FAILED">Failed</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Transcript</label>
              <select value={filters.has_transcript} onChange={(e) => setFilter('has_transcript', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">Any</option>
                <option value="true">Has transcript</option>
                <option value="false">No transcript</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Events</label>
              <select value={filters.has_events} onChange={(e) => setFilter('has_events', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">Any</option>
                <option value="true">Has events</option>
                <option value="false">No events</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Tool executions</label>
              <select value={filters.has_tool_executions} onChange={(e) => setFilter('has_tool_executions', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">Any</option>
                <option value="true">Has tool executions</option>
                <option value="false">No tool executions</option>
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
                <AlertTriangle className="h-4 w-4 text-red-500" />
                Tool failures only
              </label>
            </div>
          </div>
          {activeFilterCount > 0 && (
            <button onClick={clearFilters}
              className="text-xs text-primary hover:text-primary-hover font-medium">Clear all filters</button>
          )}
        </div>
      )}

      {isLoading ? (
        <SkeletonRows count={6} rowClassName="h-16" />
      ) : calls.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl">
          {activeFilterCount > 0 ? (
            <EmptyState
              icon={Filter}
              title="No calls match your filters"
              description="Try adjusting or clearing your filters to see more conversations."
              primaryAction={{
                label: 'Clear filters',
                onClick: clearFilters,
              }}
            />
          ) : (
            <EmptyState
              icon={PhoneCall}
              title="No calls yet"
              description="When your agents handle calls, transcripts and recordings will show up here for review."
            />
          )}
        </div>
      ) : (
        <>
          <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-5 py-3 text-text-secondary font-medium">Agent</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Language</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Direction</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Status</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Duration</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Date</th>
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
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${call.direction === 'inbound' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                        {call.direction}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${['CALL_CONNECTED', 'active'].includes(call.lifecycle_state) ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-surface-hover text-text-secondary'}`}>
                          {call.lifecycle_state}
                        </span>
                        {call.failed_tool_count && call.failed_tool_count > 0 ? (
                          <span
                            title={`${call.failed_tool_count} failed or timed-out tool execution${call.failed_tool_count === 1 ? '' : 's'}`}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {call.failed_tool_count} failed
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-text-secondary">{call.duration_seconds ? `${call.duration_seconds}s` : '--'}</td>
                    <td className="px-5 py-3 text-text-secondary">{call.start_time ? format(new Date(call.start_time), 'MMM d, h:mm a') : '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-text-secondary">{total} calls total</p>
              <div className="flex items-center gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                  className="p-2 rounded-lg border border-border hover:bg-surface-hover disabled:opacity-30 transition"><ChevronLeft className="h-4 w-4" /></button>
                <span className="text-sm text-text-secondary">Page {page} of {totalPages}</span>
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="p-2 rounded-lg border border-border hover:bg-surface-hover disabled:opacity-30 transition"><ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>
          )}
        </>
      )}

      {selectedCall && <CallDetailDrawer callId={selectedCall} onClose={() => setSelectedCall(null)} />}
    </div>
  );
}
