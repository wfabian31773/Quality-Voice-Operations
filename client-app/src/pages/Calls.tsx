import { useState, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { PhoneCall, X, ChevronLeft, ChevronRight, Filter, AlertTriangle, Search, Star, Bookmark, Trash2, Users, Mail, MailX } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import EmptyState from '../components/EmptyState';

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

function CallDetailDrawer({ callId, onClose }: { callId: string; onClose: () => void }) {
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
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="w-full max-w-lg bg-surface h-full overflow-y-auto shadow-xl border-l border-border" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-surface z-10">
          <h2 className="text-lg font-semibold text-text-primary">Call Details</h2>
          <button onClick={onClose}><X className="h-5 w-5 text-text-secondary hover:text-text-primary" /></button>
        </div>

        {call && (
          <div className="px-5 py-4 border-b border-border space-y-2">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div><span className="text-text-secondary">From:</span> <span className="font-mono text-xs">{call.caller_number}</span></div>
              <div><span className="text-text-secondary">To:</span> <span className="font-mono text-xs">{call.called_number}</span></div>
              <div><span className="text-text-secondary">Direction:</span> {call.direction}</div>
              <div><span className="text-text-secondary">Status:</span> {call.lifecycle_state}</div>
              <div><span className="text-text-secondary">Agent:</span> {call.agent_name || '--'}</div>
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
              <div><span className="text-text-secondary">STT:</span> ${(costBreakdown.sttCostCents / 100).toFixed(2)}</div>
              <div><span className="text-text-secondary">LLM:</span> ${(costBreakdown.llmCostCents / 100).toFixed(2)}</div>
              <div><span className="text-text-secondary">TTS:</span> ${(costBreakdown.ttsCostCents / 100).toFixed(2)}</div>
              <div><span className="text-text-secondary">Infra:</span> ${(costBreakdown.infraCostCents / 100).toFixed(2)}</div>
              <div className="col-span-2 font-semibold border-t border-border pt-1 mt-1">
                <span className="text-text-secondary">Total:</span> ${(costBreakdown.totalCostCents / 100).toFixed(2)}
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
      </div>
    </div>
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

  // Hydrate filters from a deep-link ?view=<id>: when the saved views load and the
  // active view's filters differ from current state (because the URL only contained
  // ?view=<id> with no individual filter params), apply the view's filters once.
  const [hasHydratedFromUrl, setHasHydratedFromUrl] = useState(false);
  useEffect(() => {
    if (hasHydratedFromUrl) return;
    if (!activeViewId) { setHasHydratedFromUrl(true); return; }
    if (!savedViewsLoaded) return; // wait for the query to complete (success, even if empty)
    const match = savedViews.find((v) => v.id === activeViewId);
    if (!match) {
      // Stale id in URL — drop it.
      setActiveViewId(null);
      setHasHydratedFromUrl(true);
      return;
    }
    const viewFilters = normalizeFilters(match.filters);
    // Only overwrite filter state if the URL didn't already specify a richer filter set
    // (any individual filter param wins over the saved view to preserve manual deep links).
    const urlHasExplicitFilters = (Object.keys(EMPTY_FILTERS) as Array<keyof FiltersState>).some(
      (k) => searchParams.get(k),
    );
    if (!urlHasExplicitFilters) {
      setFilters(viewFilters);
      setSearchInput(viewFilters.q);
    }
    setHasHydratedFromUrl(true);
  }, [activeViewId, savedViews, savedViewsLoaded, hasHydratedFromUrl, searchParams]);

  // If the active view's stored filters drift from the current filters, treat it as detached.
  // Suppress dirty state until URL hydration finishes to avoid a flicker of "Update view".
  const isViewDirty = useMemo(() => {
    if (!activeView || !hasHydratedFromUrl) return false;
    return !filtersEqual(filters, normalizeFilters(activeView.filters));
  }, [activeView, filters, hasHydratedFromUrl]);

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Conversations</h1>
          <p className="text-sm text-text-secondary mt-1">Browse and review past calls with transcripts</p>
        </div>
        <div className="flex items-center gap-2">
          {activeView && isViewDirty && (
            <button
              onClick={handleUpdateActiveView}
              className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border border-border text-text-secondary hover:bg-surface-hover transition"
              title={`Save current filters into "${activeView.name}"`}
            >
              <Star className="h-4 w-4" /> Update view
            </button>
          )}
          {activeFilterCount > 0 && !savingView && (
            <button
              onClick={() => { setSavingView(true); setSaveError(null); setNewViewName(''); setNewViewShared(false); setNewViewDigest(false); }}
              className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border border-border text-text-secondary hover:bg-surface-hover transition"
            >
              <Bookmark className="h-4 w-4" /> Save view
            </button>
          )}
          <button onClick={() => setShowFilters(!showFilters)}
            className={`inline-flex items-center gap-2 text-sm font-medium px-4 py-2.5 rounded-lg border transition ${activeFilterCount > 0 ? 'border-primary text-primary bg-primary-light' : 'border-border text-text-secondary hover:bg-surface-hover'}`}>
            <Filter className="h-4 w-4" /> Filters {activeFilterCount > 0 && `(${activeFilterCount})`}
          </button>
        </div>
      </div>

      {(savedViews.length > 0 || savingView) && (
        <div className="flex flex-wrap items-center gap-2">
          {savedViews.map((view) => {
            const isActive = activeViewId === view.id && !isViewDirty;
            const isOwner = !!currentUserId && view.created_by === currentUserId;
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
                key={view.id}
                className={`group inline-flex items-center gap-1 rounded-full border text-sm transition ${isActive ? 'border-primary bg-primary-light text-primary' : 'border-border bg-surface text-text-secondary hover:bg-surface-hover'}`}
              >
                <button
                  onClick={() => applySavedView(view)}
                  className={`inline-flex items-center gap-1.5 pl-3 ${isOwner ? 'pr-2' : 'pr-3'} py-1.5 font-medium`}
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
      )}

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
        <div className="text-center py-12 text-text-secondary">Loading...</div>
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
