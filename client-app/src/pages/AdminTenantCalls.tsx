import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ChevronLeft, ChevronRight, FileText, ListOrdered, PhoneCall, Search, Wrench, X } from 'lucide-react';
import { format } from 'date-fns';
import { api } from '../lib/api';
import { formatCents as formatCentsHelper } from '../lib/formatCurrency';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
import Modal from '../components/Modal';
import { getAgentLanguageLabel } from '../lib/agentLanguages';
import { PageHeader } from '../components/ui';

interface TenantInfo {
  id: string;
  name: string;
  slug: string;
}

interface CallRow {
  id: string;
  agent_id: string | null;
  agent_name: string | null;
  direction: string;
  lifecycle_state: string;
  caller_number: string | null;
  called_number: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_seconds: number | null;
  total_cost_cents: number | null;
  language?: string | null;
  has_transcript?: boolean;
  has_events?: boolean;
  tool_count?: number;
  failed_tool_count?: number;
}

interface ApiResp {
  tenant: TenantInfo;
  calls: CallRow[];
  total: number;
  limit: number;
  offset: number;
}

interface AgentOption {
  id: string;
  name: string;
}

interface CallDetail extends CallRow {
  escalation_target?: string | null;
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

interface ToolExecution {
  id: string;
  toolName: string;
  status: string;
  durationMs: number | null;
  invokedAt: string;
  errorMessage: string | null;
  recoveryAction: string | null;
}

const RANGES: Array<{ value: string; label: string }> = [
  { value: '', label: 'All Time' },
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
  { value: '90d', label: 'Last 90 Days' },
];

const LIFECYCLE_STATES: Array<{ value: string; label: string }> = [
  { value: '', label: 'All' },
  { value: 'CALL_INITIATED', label: 'Initiated' },
  { value: 'CALL_RINGING', label: 'Ringing' },
  { value: 'CALL_ANSWERED', label: 'Answered' },
  { value: 'CALL_IN_PROGRESS', label: 'In Progress' },
  { value: 'CALL_COMPLETED', label: 'Completed' },
  { value: 'CALL_FAILED', label: 'Failed' },
  { value: 'WORKFLOW_FAILED', label: 'Workflow Failed' },
  { value: 'ESCALATION_FAILED', label: 'Escalation Failed' },
];

function AdminCallDetailDrawer({
  tenantId,
  tenant,
  callId,
  onClose,
}: {
  tenantId: string;
  tenant: TenantInfo | undefined;
  callId: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'transcript' | 'events' | 'tools'>('transcript');

  const { data: callData } = useQuery({
    queryKey: ['admin-tenant-call', tenantId, callId],
    queryFn: () =>
      api.get<{ tenant: TenantInfo; call: CallDetail; costBreakdown: CostBreakdown | null; currency?: string }>(
        `/platform/tenants/${tenantId}/calls/${callId}`,
      ),
  });

  const currency = useTenantCurrency(callData?.currency);
  const formatCents = (cents: number) => formatCentsHelper(cents, { currency });

  const { data: transcriptData, isLoading: transcriptLoading } = useQuery({
    queryKey: ['admin-tenant-call-transcript', tenantId, callId],
    queryFn: () =>
      api.get<{ transcript: TranscriptEntry[] }>(
        `/platform/tenants/${tenantId}/calls/${callId}/transcript`,
      ),
  });

  const { data: eventsData, isLoading: eventsLoading } = useQuery({
    queryKey: ['admin-tenant-call-events', tenantId, callId],
    queryFn: () =>
      api.get<{ events: CallEvent[] }>(
        `/platform/tenants/${tenantId}/calls/${callId}/events`,
      ),
  });

  const { data: toolExecData, isLoading: toolExecLoading } = useQuery({
    queryKey: ['admin-tenant-call-tools', tenantId, callId],
    queryFn: () =>
      api.get<{ executions: ToolExecution[] }>(
        `/platform/tenants/${tenantId}/calls/${callId}/tool-executions`,
      ),
  });

  const call = callData?.call;
  const costBreakdown = callData?.costBreakdown ?? null;
  const transcript = transcriptData?.transcript ?? [];
  const events = eventsData?.events ?? [];
  const toolExecutions = toolExecData?.executions ?? [];

  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel="Call Details"
      containerClassName="fixed inset-0 z-drawer flex justify-end"
      panelClassName="w-full max-w-lg bg-surface h-full overflow-y-auto shadow-xl border-l border-border"
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-surface z-sticky-header">
          <h2 className="text-lg font-semibold text-text-primary">Call Details</h2>
          <button onClick={onClose} aria-label="Close">
            <X className="h-5 w-5 text-text-secondary hover:text-text-primary" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-border bg-accent/10">
          <p className="text-xs text-accent">
            Viewing as admin — tenant: {tenant?.name ?? callData?.tenant?.name ?? '...'}
          </p>
        </div>

        {call && (
          <div className="px-5 py-4 border-b border-border space-y-2">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div><span className="text-text-secondary">From:</span> <span className="font-mono text-xs">{call.caller_number || '--'}</span></div>
              <div><span className="text-text-secondary">To:</span> <span className="font-mono text-xs">{call.called_number || '--'}</span></div>
              <div><span className="text-text-secondary">Direction:</span> {call.direction}</div>
              <div><span className="text-text-secondary">Status:</span> {call.lifecycle_state}</div>
              <div><span className="text-text-secondary">Agent:</span> {call.agent_name || '--'}</div>
              <div data-testid="admin-call-detail-language"><span className="text-text-secondary">Language:</span> {call.language ? getAgentLanguageLabel(call.language) : 'Unknown'}</div>
              <div><span className="text-text-secondary">Duration:</span> {call.duration_seconds ? `${call.duration_seconds}s` : '--'}</div>
              <div><span className="text-text-secondary">Started:</span> {call.start_time ? format(new Date(call.start_time), 'PPp') : '--'}</div>
              <div><span className="text-text-secondary">Ended:</span> {call.end_time ? format(new Date(call.end_time), 'PPp') : '--'}</div>
            </div>
          </div>
        )}

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
            </div>
          </div>
        )}

        <div className="border-b border-border">
          <div className="flex px-5">
            <button
              onClick={() => setTab('transcript')}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition ${tab === 'transcript' ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
            >
              Transcript
            </button>
            <button
              onClick={() => setTab('events')}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition ${tab === 'events' ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
            >
              Events ({events.length})
            </button>
            <button
              onClick={() => setTab('tools')}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition ${tab === 'tools' ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
            >
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
                    {events.map((event) => (
                      <div key={event.id} className="relative pl-8">
                        <div className="absolute left-1.5 top-1.5 w-3 h-3 rounded-full bg-primary border-2 border-surface" />
                        <div className="bg-surface-hover rounded-lg p-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium text-text-primary">{event.event_type}</span>
                            <span className="text-xs text-text-muted">{event.occurred_at ? format(new Date(event.occurred_at), 'h:mm:ss a') : '--'}</span>
                          </div>
                          {event.from_state && event.to_state && (
                            <p className="text-xs text-text-secondary">{event.from_state} → {event.to_state}</p>
                          )}
                        </div>
                      </div>
                    ))}
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
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${exec.status === 'success' ? 'bg-success-light text-success' : exec.status === 'failed' ? 'bg-danger-light text-danger' : 'bg-warning-light text-warning'}`}>
                          {exec.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-text-muted mt-1">
                        <span>{exec.invokedAt ? format(new Date(exec.invokedAt), 'h:mm:ss a') : '--'}</span>
                        {exec.durationMs != null && <span>{exec.durationMs}ms</span>}
                      </div>
                      {exec.errorMessage && (
                        <p className="text-xs text-danger mt-2">{exec.errorMessage}</p>
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

export default function AdminTenantCalls() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [page, setPage] = useState(() => Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1));
  const [direction, setDirection] = useState<string>(searchParams.get('direction') ?? '');
  const [range, setRange] = useState<string>(searchParams.get('range') ?? '');
  const [agentId, setAgentId] = useState<string>(searchParams.get('agent_id') ?? '');
  const [lifecycleState, setLifecycleState] = useState<string>(searchParams.get('lifecycle_state') ?? '');
  const [hasTranscript, setHasTranscript] = useState<string>(searchParams.get('has_transcript') ?? '');
  const [hasEvents, setHasEvents] = useState<string>(searchParams.get('has_events') ?? '');
  const [hasToolExecutions, setHasToolExecutions] = useState<string>(searchParams.get('has_tool_executions') ?? '');
  const [toolFailuresOnly, setToolFailuresOnly] = useState<boolean>(searchParams.get('tool_failures_only') === 'true');
  const [searchInput, setSearchInput] = useState<string>(searchParams.get('q') ?? '');
  const [search, setSearch] = useState<string>(searchParams.get('q') ?? '');
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const limit = 20;

  // Debounce search input -> committed search
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== search) {
        setSearch(searchInput);
        setPage(1);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search]);

  // Sync state -> URL
  useEffect(() => {
    const next = new URLSearchParams();
    if (range) next.set('range', range);
    if (direction) next.set('direction', direction);
    if (agentId) next.set('agent_id', agentId);
    if (lifecycleState) next.set('lifecycle_state', lifecycleState);
    if (hasTranscript) next.set('has_transcript', hasTranscript);
    if (hasEvents) next.set('has_events', hasEvents);
    if (hasToolExecutions) next.set('has_tool_executions', hasToolExecutions);
    if (toolFailuresOnly) next.set('tool_failures_only', 'true');
    if (search) next.set('q', search);
    if (page > 1) next.set('page', String(page));
    setSearchParams(next, { replace: true });
  }, [range, direction, agentId, lifecycleState, hasTranscript, hasEvents, hasToolExecutions, toolFailuresOnly, search, page, setSearchParams]);

  const sinceIso = useMemo(() => {
    if (!range) return '';
    const now = Date.now();
    if (range === '24h') return new Date(now - 24 * 3600 * 1000).toISOString();
    if (range === '7d') return new Date(now - 7 * 86400 * 1000).toISOString();
    if (range === '30d') return new Date(now - 30 * 86400 * 1000).toISOString();
    if (range === '90d') return new Date(now - 90 * 86400 * 1000).toISOString();
    return '';
  }, [range]);

  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('page', String(page));
  if (direction) params.set('direction', direction);
  if (sinceIso) params.set('since', sinceIso);
  if (agentId) params.set('agent_id', agentId);
  if (lifecycleState) params.set('lifecycle_state', lifecycleState);
  if (hasTranscript) params.set('has_transcript', hasTranscript);
  if (hasEvents) params.set('has_events', hasEvents);
  if (hasToolExecutions) params.set('has_tool_executions', hasToolExecutions);
  if (toolFailuresOnly) params.set('tool_failures_only', 'true');
  if (search) params.set('q', search);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-tenant-calls', tenantId, page, direction, range, agentId, lifecycleState, hasTranscript, hasEvents, hasToolExecutions, toolFailuresOnly, search],
    queryFn: () => api.get<ApiResp>(`/platform/tenants/${tenantId}/calls?${params.toString()}`),
    enabled: !!tenantId,
  });

  const { data: agentsData } = useQuery({
    queryKey: ['admin-tenant-agents', tenantId],
    queryFn: () => api.get<{ agents: AgentOption[] }>(`/platform/tenants/${tenantId}/agents`),
    enabled: !!tenantId,
  });
  const agents = agentsData?.agents ?? [];

  const tenant = data?.tenant;
  const calls = data?.calls ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const hasFilters = !!(range || direction || agentId || lifecycleState || hasTranscript || hasEvents || hasToolExecutions || toolFailuresOnly || search);
  const clearFilters = () => {
    setRange('');
    setDirection('');
    setAgentId('');
    setLifecycleState('');
    setHasTranscript('');
    setHasEvents('');
    setHasToolExecutions('');
    setToolFailuresOnly(false);
    setSearchInput('');
    setSearch('');
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={tenant ? `${tenant.name} — Calls` : 'Tenant Calls'}
        description="Read-only call list scoped to this tenant. Click a row to view transcript, events, and tool executions."
        icon={<PhoneCall className="h-5 w-5" />}
        breadcrumbs={
          <button
            type="button"
            onClick={() => navigate(`/admin/analytics/tenants/${tenantId}`)}
            className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-primary transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Tenant Analytics
          </button>
        }
      />

      <div className="bg-card border border-border rounded-xl p-4 shadow-sm space-y-3">
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
                onClick={() => { setSearchInput(''); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Date Range</label>
            <select
              value={range}
              onChange={(e) => { setRange(e.target.value); setPage(1); }}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm"
            >
              {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Direction</label>
            <select
              value={direction}
              onChange={(e) => { setDirection(e.target.value); setPage(1); }}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm"
            >
              <option value="">All</option>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Agent</label>
            <select
              value={agentId}
              onChange={(e) => { setAgentId(e.target.value); setPage(1); }}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm"
            >
              <option value="">All Agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Lifecycle State</label>
            <select
              value={lifecycleState}
              onChange={(e) => { setLifecycleState(e.target.value); setPage(1); }}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm"
            >
              {LIFECYCLE_STATES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Transcript</label>
            <select
              value={hasTranscript}
              onChange={(e) => { setHasTranscript(e.target.value); setPage(1); }}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm"
            >
              <option value="">Any</option>
              <option value="true">With transcript</option>
              <option value="false">Without transcript</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Events</label>
            <select
              value={hasEvents}
              onChange={(e) => { setHasEvents(e.target.value); setPage(1); }}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm"
            >
              <option value="">Any</option>
              <option value="true">With events</option>
              <option value="false">Without events</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Tool Executions</label>
            <select
              value={hasToolExecutions}
              onChange={(e) => { setHasToolExecutions(e.target.value); setPage(1); }}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm"
            >
              <option value="">Any</option>
              <option value="true">With tool runs</option>
              <option value="false">Without tool runs</option>
            </select>
          </div>
        </div>

        <div>
          <label className="inline-flex items-center gap-2 text-sm text-text-primary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={toolFailuresOnly}
              onChange={(e) => { setToolFailuresOnly(e.target.checked); setPage(1); }}
              className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
            />
            <span>Tool failures only</span>
            <span className="text-xs text-text-muted">(calls with at least one failed or timed-out tool execution)</span>
          </label>
        </div>

        {hasFilters && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-accent hover:text-accent inline-flex items-center gap-1"
            >
              <X className="h-3 w-3" />
              Clear filters
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Failed to load calls for this tenant.
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-text-secondary">Loading...</div>
      ) : calls.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <PhoneCall className="h-12 w-12 text-text-muted mx-auto mb-3" />
          <p className="text-text-secondary">
            {hasFilters
              ? 'No calls match the current filters.'
              : 'No calls found for this tenant in the selected window.'}
          </p>
        </div>
      ) : (
        <>
          <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-5 py-3 text-text-secondary font-medium">Agent</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Language</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Direction</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Status</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Caller</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Duration</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Data</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Started</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setSelectedCallId(c.id)}
                    className="border-b border-border last:border-0 hover:bg-surface-hover cursor-pointer transition-colors"
                  >
                    <td className="px-5 py-3 text-text-primary">{c.agent_name || '--'}</td>
                    <td className="px-5 py-3 text-text-secondary">{c.language ? getAgentLanguageLabel(c.language) : '--'}</td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${c.direction === 'inbound' ? 'bg-info-light text-info' : 'bg-warning-light text-warning'}`}>
                        {c.direction}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-text-secondary">{c.lifecycle_state}</td>
                    <td className="px-5 py-3 text-text-secondary font-mono text-xs">{c.caller_number || '--'}</td>
                    <td className="px-5 py-3 text-text-secondary">{c.duration_seconds ? `${c.duration_seconds}s` : '--'}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1.5">
                        {c.has_transcript ? (
                          <span
                            title="Transcript available"
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs font-medium bg-success-light text-success"
                          >
                            <FileText className="h-3 w-3" />
                            Transcript
                          </span>
                        ) : null}
                        {c.has_events ? (
                          <span
                            title="Lifecycle events recorded"
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs font-medium bg-accent-light text-accent"
                          >
                            <ListOrdered className="h-3 w-3" />
                            Events
                          </span>
                        ) : null}
                        {c.tool_count && c.tool_count > 0 ? (
                          <span
                            title={`${c.tool_count} tool execution${c.tool_count === 1 ? '' : 's'}`}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs font-medium bg-warning-light text-warning"
                          >
                            <Wrench className="h-3 w-3" />
                            {c.tool_count}
                          </span>
                        ) : null}
                        {c.failed_tool_count && c.failed_tool_count > 0 ? (
                          <span
                            title={`${c.failed_tool_count} failed or timed-out tool execution${c.failed_tool_count === 1 ? '' : 's'}`}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs font-medium bg-danger-light text-danger"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {c.failed_tool_count} failed
                          </span>
                        ) : null}
                        {!c.has_transcript && !c.has_events && !(c.tool_count && c.tool_count > 0) ? (
                          <span className="text-xs text-text-muted">—</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-text-secondary">{c.start_time ? format(new Date(c.start_time), 'MMM d, h:mm a') : '--'}</td>
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
                  className="p-2 rounded-lg border border-border hover:bg-surface-hover disabled:opacity-30 transition">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-sm text-text-secondary">Page {page} of {totalPages}</span>
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="p-2 rounded-lg border border-border hover:bg-surface-hover disabled:opacity-30 transition">
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {selectedCallId && tenantId && (
        <AdminCallDetailDrawer
          tenantId={tenantId}
          tenant={tenant}
          callId={selectedCallId}
          onClose={() => setSelectedCallId(null)}
        />
      )}
    </div>
  );
}
