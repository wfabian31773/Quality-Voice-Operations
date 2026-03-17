import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import {
  Search, Filter, PhoneCall, ChevronLeft, ChevronRight, X, Clock,
  AlertTriangle, TrendingUp, Zap, ArrowRight, ChevronDown, ChevronUp,
  Activity, Eye, Globe, Code, MessageSquare, Bot, User, Wrench, Layers,
  Radio, Timer,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';

interface CallSummary {
  id: string;
  agent_id: string;
  agent_name: string | null;
  direction: string;
  lifecycle_state: string;
  start_time: string;
  end_time: string | null;
  duration_seconds: number | null;
  total_cost_cents: number | null;
  sentiment_score: number | null;
  has_tool_failure: boolean;
  escalated: boolean;
  escalation_reason: string | null;
  call_sid: string | null;
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

interface TraceEvent {
  id: string;
  traceType: string;
  stepName: string;
  sequenceNumber: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  inputData: Record<string, unknown> | null;
  outputData: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  parentTraceId: string | null;
}

interface ToolInvocation {
  id: string;
  tool_name: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  status: string;
  error_message: string | null;
  duration_ms: number | null;
  invoked_at: string;
  completed_at: string | null;
  result: unknown;
  recovery_action: string | null;
}

interface IntegrationEvent {
  id: string;
  tool_invocation_id: string | null;
  request_method: string;
  request_url: string;
  request_headers: Record<string, unknown>;
  request_body: unknown;
  response_status: number | null;
  response_body: unknown;
  response_headers: Record<string, unknown>;
  latency_ms: number | null;
  error_message: string | null;
  service_name: string | null;
  created_at: string;
}

interface ReplayData {
  call: Record<string, unknown>;
  transcript: TranscriptEntry[];
  events: CallEvent[];
  toolInvocations: ToolInvocation[];
  traces: TraceEvent[];
  integrationEvents: IntegrationEvent[];
}

interface ActiveCall {
  id: string;
  agentName: string;
  agentSlug: string | null;
  direction: string;
  lifecycleState: string;
  startTime: string;
  callerNumber: string;
  workflowId: string | null;
  elapsedSeconds: number;
  currentStep: { traceType: string; stepName: string; startedAt: string } | null;
  activeToolCalls: Array<{
    id: string;
    toolName: string;
    status: string;
    invokedAt: string;
  }>;
}

interface Agent {
  id: string;
  name: string;
}

type TabType = 'search' | 'replay' | 'live';

function JsonViewer({ data, label }: { data: unknown; label?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!data) return null;
  return (
    <div className="mt-1">
      <button onClick={() => setExpanded(!expanded)}
        className="text-xs text-primary hover:text-primary-hover flex items-center gap-1 font-medium">
        <Code className="h-3 w-3" />
        {label ?? 'View Data'}
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {expanded && (
        <pre className="mt-1 p-2 bg-gray-900 text-green-400 text-xs rounded-lg overflow-x-auto max-h-60 font-mono">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function TraceIcon({ type }: { type: string }) {
  const iconMap: Record<string, React.ReactNode> = {
    intent_classified: <Layers className="h-3.5 w-3.5 text-blue-500" />,
    slot_collected: <MessageSquare className="h-3.5 w-3.5 text-indigo-500" />,
    tool_invoked: <Wrench className="h-3.5 w-3.5 text-orange-500" />,
    tool_responded: <Wrench className="h-3.5 w-3.5 text-green-500" />,
    model_prompted: <Bot className="h-3.5 w-3.5 text-purple-500" />,
    model_responded: <Bot className="h-3.5 w-3.5 text-violet-500" />,
    workflow_started: <Activity className="h-3.5 w-3.5 text-cyan-500" />,
    workflow_step: <ArrowRight className="h-3.5 w-3.5 text-teal-500" />,
    escalation_check: <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />,
    call_started: <PhoneCall className="h-3.5 w-3.5 text-green-500" />,
    call_ended: <PhoneCall className="h-3.5 w-3.5 text-red-500" />,
    integration_call: <Globe className="h-3.5 w-3.5 text-sky-500" />,
  };
  return <>{iconMap[type] ?? <Activity className="h-3.5 w-3.5 text-gray-400" />}</>;
}

function traceColor(type: string): string {
  const colors: Record<string, string> = {
    intent_classified: 'border-blue-500',
    slot_collected: 'border-indigo-500',
    tool_invoked: 'border-orange-500',
    tool_responded: 'border-green-500',
    model_prompted: 'border-purple-500',
    model_responded: 'border-violet-500',
    workflow_started: 'border-cyan-500',
    workflow_step: 'border-teal-500',
    escalation_check: 'border-yellow-500',
    call_started: 'border-green-500',
    call_ended: 'border-red-500',
    integration_call: 'border-sky-500',
  };
  return colors[type] ?? 'border-gray-400';
}

function CallReplayView({ callId, onBack }: { callId: string; onBack: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['call-replay', callId],
    queryFn: () => api.get<ReplayData>(`/calls/${callId}/replay`),
  });

  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<string>('all');

  const toggleItem = (id: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const call = data?.call;
  const transcript = data?.transcript ?? [];
  const events = data?.events ?? [];
  const toolInvocations = data?.toolInvocations ?? [];
  const traces = data?.traces ?? [];
  const integrationEvents = data?.integrationEvents ?? [];
  const callStartTime = call?.start_time ? new Date(call.start_time as string).getTime() : 0;

  const timelineItems = useMemo(() => {
    const items: Array<{
      id: string;
      type: 'transcript' | 'event' | 'tool' | 'trace' | 'integration';
      timestamp: string;
      data: unknown;
    }> = [];

    transcript.forEach(t => items.push({
      id: `t-${t.id}`, type: 'transcript', timestamp: t.occurred_at, data: t,
    }));
    events.forEach(e => items.push({
      id: `e-${e.id}`, type: 'event', timestamp: e.occurred_at, data: e,
    }));
    toolInvocations.forEach(t => items.push({
      id: `tool-${t.id}`, type: 'tool', timestamp: t.invoked_at, data: t,
    }));
    traces.forEach(tr => items.push({
      id: `trace-${tr.id}`, type: 'trace', timestamp: tr.startedAt, data: tr,
    }));
    integrationEvents.forEach(ie => items.push({
      id: `int-${ie.id}`, type: 'integration', timestamp: ie.created_at, data: ie,
    }));

    items.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return items;
  }, [transcript, events, toolInvocations, traces, integrationEvents]);

  const filteredItems = typeFilter === 'all' ? timelineItems : timelineItems.filter(i => i.type === typeFilter);

  if (isLoading) return <div className="text-center py-12 text-text-secondary">Loading call replay...</div>;
  if (error || !data || !call) return <div className="text-center py-12 text-red-500">Failed to load call replay</div>;

  const relativeTime = (ts: string) => {
    if (!callStartTime || !ts) return '';
    const diff = new Date(ts).getTime() - callStartTime;
    const secs = Math.floor(diff / 1000);
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    return `+${mins}:${remSecs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="p-2 rounded-lg border border-border hover:bg-surface-hover transition">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div>
          <h2 className="text-xl font-bold text-text-primary">Call Replay</h2>
          <p className="text-sm text-text-secondary font-mono">{callId}</p>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-5">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div><span className="text-text-secondary block text-xs mb-0.5">Agent</span><span className="font-medium">{(call.agent_name as string) || '--'}</span></div>
          <div><span className="text-text-secondary block text-xs mb-0.5">Direction</span><span className="font-medium capitalize">{call.direction as string}</span></div>
          <div><span className="text-text-secondary block text-xs mb-0.5">Status</span>
            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
              call.lifecycle_state === 'CALL_COMPLETED' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
              call.lifecycle_state === 'CALL_FAILED' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
              'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
            }`}>{call.lifecycle_state as string}</span>
          </div>
          <div><span className="text-text-secondary block text-xs mb-0.5">Duration</span><span className="font-medium">{call.duration_seconds ? `${call.duration_seconds}s` : '--'}</span></div>
          <div><span className="text-text-secondary block text-xs mb-0.5">Start</span><span className="text-xs">{call.start_time ? format(new Date(call.start_time as string), 'PPp') : '--'}</span></div>
          <div><span className="text-text-secondary block text-xs mb-0.5">End</span><span className="text-xs">{call.end_time ? format(new Date(call.end_time as string), 'PPp') : '--'}</span></div>
          <div><span className="text-text-secondary block text-xs mb-0.5">Cost</span><span className="font-medium">{call.total_cost_cents != null ? `$${((call.total_cost_cents as number) / 100).toFixed(2)}` : '--'}</span></div>
          <div><span className="text-text-secondary block text-xs mb-0.5">Sentiment</span><span className="font-medium">{call.sentiment_score != null ? (call.sentiment_score as number).toFixed(2) : '--'}</span></div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium text-text-secondary mr-1">Filter:</span>
        {[
          { key: 'all', label: 'All', count: timelineItems.length },
          { key: 'transcript', label: 'Transcript', count: transcript.length },
          { key: 'event', label: 'Events', count: events.length },
          { key: 'tool', label: 'Tools', count: toolInvocations.length },
          { key: 'trace', label: 'Traces', count: traces.length },
          { key: 'integration', label: 'Integrations', count: integrationEvents.length },
        ].map(f => (
          <button key={f.key} onClick={() => setTypeFilter(f.key)}
            className={`text-xs px-3 py-1.5 rounded-full font-medium transition ${
              typeFilter === f.key ? 'bg-primary text-white' : 'bg-surface-hover text-text-secondary hover:text-text-primary'
            }`}>
            {f.label} ({f.count})
          </button>
        ))}
      </div>

      <div className="relative">
        <div className="absolute left-5 top-0 bottom-0 w-px bg-border" />
        <div className="space-y-3">
          {filteredItems.length === 0 ? (
            <p className="text-sm text-text-secondary pl-10">No events to display</p>
          ) : filteredItems.map(item => (
            <div key={item.id} className="relative pl-12">
              <div className={`absolute left-3.5 top-2 w-3 h-3 rounded-full border-2 border-surface ${
                item.type === 'transcript' ? 'bg-blue-500' :
                item.type === 'event' ? 'bg-yellow-500' :
                item.type === 'tool' ? 'bg-orange-500' :
                item.type === 'trace' ? 'bg-purple-500' :
                'bg-sky-500'
              }`} />
              <span className="absolute left-12 -top-0.5 text-[10px] text-text-muted font-mono">{relativeTime(item.timestamp)}</span>
              <div className="pt-4">
                {item.type === 'transcript' && (() => {
                  const t = item.data as TranscriptEntry;
                  return (
                    <div className={`rounded-lg p-3 ${t.role === 'assistant' ? 'bg-primary-light border-l-2 border-primary' : 'bg-surface-hover border-l-2 border-gray-400'}`}>
                      <div className="flex items-center gap-2 mb-1">
                        {t.role === 'assistant' ? <Bot className="h-3.5 w-3.5 text-primary" /> : <User className="h-3.5 w-3.5 text-text-secondary" />}
                        <span className="text-xs font-medium text-text-secondary capitalize">{t.role}</span>
                      </div>
                      <p className="text-sm text-text-primary">{t.content}</p>
                    </div>
                  );
                })()}
                {item.type === 'event' && (() => {
                  const e = item.data as CallEvent;
                  return (
                    <div className="bg-surface-hover rounded-lg p-3 border-l-2 border-yellow-500">
                      <div className="flex items-center gap-2 mb-1">
                        <Activity className="h-3.5 w-3.5 text-yellow-500" />
                        <span className="text-xs font-semibold text-text-primary">{e.event_type}</span>
                      </div>
                      {e.from_state && e.to_state && (
                        <p className="text-xs text-text-secondary flex items-center gap-1">{e.from_state} <ArrowRight className="h-3 w-3" /> {e.to_state}</p>
                      )}
                      <JsonViewer data={e.payload} label="Event Payload" />
                    </div>
                  );
                })()}
                {item.type === 'tool' && (() => {
                  const t = item.data as ToolInvocation;
                  return (
                    <div className={`bg-surface-hover rounded-lg p-3 border-l-2 ${t.status === 'success' ? 'border-green-500' : t.status === 'failed' ? 'border-red-500' : 'border-orange-500'}`}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <Wrench className="h-3.5 w-3.5 text-orange-500" />
                          <span className="text-sm font-semibold font-mono text-text-primary">{t.tool_name}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {t.duration_ms != null && <span className="text-xs text-text-muted">{t.duration_ms}ms</span>}
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            t.status === 'success' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                            t.status === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                            'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                          }`}>{t.status}</span>
                        </div>
                      </div>
                      {t.error_message && <p className="text-xs text-red-500 mt-1">{t.error_message}</p>}
                      <div className="flex gap-4">
                        <JsonViewer data={t.input} label="Input" />
                        <JsonViewer data={t.output ?? t.result} label="Output" />
                      </div>
                    </div>
                  );
                })()}
                {item.type === 'trace' && (() => {
                  const trace = item.data as TraceEvent;
                  const isExpanded = expandedItems.has(item.id);
                  return (
                    <div className={`bg-surface border rounded-lg overflow-hidden border-l-4 ${traceColor(trace.traceType)}`}>
                      <button onClick={() => toggleItem(item.id)}
                        className="w-full flex items-center justify-between p-3 hover:bg-surface-hover transition text-left">
                        <div className="flex items-center gap-3">
                          <TraceIcon type={trace.traceType} />
                          <div>
                            <span className="text-sm font-medium text-text-primary">{trace.stepName}</span>
                            <span className="text-xs text-text-muted ml-2">{trace.traceType.replace(/_/g, ' ')}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          {trace.durationMs != null && (
                            <span className="text-xs text-text-muted flex items-center gap-1">
                              <Timer className="h-3 w-3" />{trace.durationMs}ms
                            </span>
                          )}
                          {isExpanded ? <ChevronUp className="h-4 w-4 text-text-muted" /> : <ChevronDown className="h-4 w-4 text-text-muted" />}
                        </div>
                      </button>
                      {isExpanded && (
                        <div className="px-3 pb-3 border-t border-border pt-3 space-y-2">
                          {(trace.traceType === 'model_prompted' || trace.traceType === 'model_responded') && (
                            <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3">
                              <h4 className="text-xs font-semibold text-text-secondary mb-2 uppercase tracking-wider">
                                {trace.traceType === 'model_prompted' ? 'Prompt Context Sent to Model' : 'Raw Model Completion'}
                              </h4>
                              {trace.inputData && (
                                <div>
                                  <span className="text-xs text-text-muted block mb-1">Input:</span>
                                  <pre className="text-xs bg-gray-900 text-green-400 p-2 rounded overflow-x-auto max-h-60 font-mono">
                                    {typeof trace.inputData === 'string' ? trace.inputData : JSON.stringify(trace.inputData, null, 2)}
                                  </pre>
                                </div>
                              )}
                              {trace.outputData && (
                                <div className="mt-2">
                                  <span className="text-xs text-text-muted block mb-1">Output:</span>
                                  <pre className="text-xs bg-gray-900 text-green-400 p-2 rounded overflow-x-auto max-h-60 font-mono">
                                    {typeof trace.outputData === 'string' ? trace.outputData : JSON.stringify(trace.outputData, null, 2)}
                                  </pre>
                                </div>
                              )}
                            </div>
                          )}
                          {trace.traceType !== 'model_prompted' && trace.traceType !== 'model_responded' && (
                            <>
                              <JsonViewer data={trace.inputData} label="Input Data" />
                              <JsonViewer data={trace.outputData} label="Output Data" />
                            </>
                          )}
                          {trace.metadata && Object.keys(trace.metadata).length > 0 && (
                            <JsonViewer data={trace.metadata} label="Metadata" />
                          )}
                          <div className="text-xs text-text-muted flex items-center gap-4 mt-2">
                            <span>Started: {trace.startedAt ? format(new Date(trace.startedAt), 'h:mm:ss.SSS a') : '--'}</span>
                            {trace.endedAt && <span>Ended: {format(new Date(trace.endedAt), 'h:mm:ss.SSS a')}</span>}
                            {trace.parentTraceId && <span>Parent: {trace.parentTraceId.slice(0, 8)}...</span>}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
                {item.type === 'integration' && (() => {
                  const evt = item.data as IntegrationEvent;
                  return (
                    <div className="bg-surface border border-border rounded-lg p-4 border-l-4 border-l-sky-500">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <Globe className="h-4 w-4 text-sky-500" />
                          <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${
                            evt.request_method === 'GET' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                            evt.request_method === 'POST' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
                            evt.request_method === 'PUT' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                            'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                          }`}>{evt.request_method}</span>
                          <span className="text-sm font-mono text-text-primary truncate max-w-md">{evt.request_url}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          {evt.latency_ms != null && <span className="text-xs text-text-muted">{evt.latency_ms}ms</span>}
                          {evt.response_status != null && (
                            <span className={`text-xs px-2 py-0.5 rounded-full font-mono font-bold ${
                              evt.response_status >= 200 && evt.response_status < 300 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                              evt.response_status >= 400 ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                              'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                            }`}>{evt.response_status}</span>
                          )}
                        </div>
                      </div>
                      {evt.service_name && <p className="text-xs text-text-muted mb-2">Service: {evt.service_name}</p>}
                      {evt.error_message && <p className="text-xs text-red-500 mb-2">{evt.error_message}</p>}
                      <div className="flex gap-4 flex-wrap">
                        <JsonViewer data={evt.request_headers} label="Request Headers" />
                        <JsonViewer data={evt.request_body} label="Request Body" />
                        <JsonViewer data={evt.response_body} label="Response Body" />
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LiveOperationsBoard() {
  const { data, isLoading } = useQuery({
    queryKey: ['live-board'],
    queryFn: () => api.get<{
      activeCalls: ActiveCall[];
      totalActive: number;
      recentTraces: Array<{
        id: string;
        callSessionId: string;
        traceType: string;
        stepName: string;
        startedAt: string;
        durationMs: number | null;
      }>;
    }>('/operations/live-board'),
    refetchInterval: 3000,
  });

  const activeCalls = data?.activeCalls ?? [];
  const recentTraces = data?.recentTraces ?? [];

  if (isLoading) return <div className="text-center py-12 text-text-secondary">Loading live data...</div>;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-1">
            <Radio className="h-4 w-4 text-green-500 animate-pulse" />
            <span className="text-sm text-text-secondary">Active Calls</span>
          </div>
          <p className="text-3xl font-bold text-text-primary">{activeCalls.length}</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-1">
            <Wrench className="h-4 w-4 text-orange-500" />
            <span className="text-sm text-text-secondary">Tools In Flight</span>
          </div>
          <p className="text-3xl font-bold text-text-primary">
            {activeCalls.reduce((sum, c) => sum + c.activeToolCalls.length, 0)}
          </p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-1">
            <Activity className="h-4 w-4 text-purple-500" />
            <span className="text-sm text-text-secondary">Recent Traces</span>
          </div>
          <p className="text-3xl font-bold text-text-primary">{recentTraces.length}</p>
        </div>
      </div>

      {activeCalls.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <PhoneCall className="h-12 w-12 text-text-muted mx-auto mb-3" />
          <p className="text-text-secondary">No active calls right now</p>
        </div>
      ) : (
        <div className="space-y-3">
          {activeCalls.map(call => (
            <div key={call.id} className="bg-surface border border-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
                  <span className="text-sm font-semibold text-text-primary">{call.agentName}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    call.direction === 'inbound' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                  }`}>{call.direction}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-text-muted flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {Math.floor(call.elapsedSeconds / 60)}:{(call.elapsedSeconds % 60).toString().padStart(2, '0')}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400`}>
                    {call.lifecycleState}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3 text-xs text-text-secondary">
                <div>Caller: <span className="font-mono">{call.callerNumber}</span></div>
                <div>Workflow: <span className="font-mono">{call.workflowId ?? '--'}</span></div>
                <div>Started: {call.startTime ? formatDistanceToNow(new Date(call.startTime), { addSuffix: true }) : '--'}</div>
              </div>
              {call.currentStep && (
                <div className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
                  <Activity className="h-3 w-3 text-purple-500" />
                  <span>Current Step:</span>
                  <span className="font-mono px-1.5 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 rounded">
                    {call.currentStep.traceType}
                  </span>
                  <span className="text-text-muted">{call.currentStep.stepName}</span>
                </div>
              )}
              {call.activeToolCalls.length > 0 && (
                <div className="mt-3 border-t border-border pt-2">
                  <span className="text-xs font-medium text-text-secondary">Active Tools:</span>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {call.activeToolCalls.map(tc => (
                      <span key={tc.id} className="text-xs px-2 py-1 bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 rounded-full font-mono flex items-center gap-1">
                        <Zap className="h-3 w-3" />{tc.toolName}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {recentTraces.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-text-secondary mb-3">Recent Execution Activity</h3>
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-text-muted">
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Step</th>
                  <th className="px-4 py-2">Duration</th>
                  <th className="px-4 py-2">Time</th>
                </tr>
              </thead>
              <tbody>
                {recentTraces.slice(0, 20).map(t => (
                  <tr key={t.id} className="border-b border-border last:border-0 text-xs">
                    <td className="px-4 py-2 flex items-center gap-1">
                      <TraceIcon type={t.traceType} />
                      <span className="text-text-secondary">{t.traceType.replace(/_/g, ' ')}</span>
                    </td>
                    <td className="px-4 py-2 text-text-primary font-medium">{t.stepName}</td>
                    <td className="px-4 py-2 text-text-muted">{t.durationMs != null ? `${t.durationMs}ms` : '--'}</td>
                    <td className="px-4 py-2 text-text-muted">{t.startedAt ? format(new Date(t.startedAt), 'h:mm:ss a') : '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CallDebug() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabType>(
    (searchParams.get('tab') as TabType) ?? 'search'
  );
  const [selectedCallId, setSelectedCallId] = useState<string | null>(searchParams.get('callId'));
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({
    agent_id: '',
    agent_template: '',
    direction: '',
    lifecycle_state: '',
    dateRange: '',
    has_tool_failure: '',
    escalated: '',
    sentiment_band: '',
    cost_range: '',
    search: '',
    sort_by: 'start_time',
    sort_order: 'desc',
  });

  const limit = 20;

  useEffect(() => {
    const callId = searchParams.get('callId');
    if (callId) {
      setSelectedCallId(callId);
      setActiveTab('replay');
    }
  }, [searchParams]);

  const { data: agentsData } = useQuery({
    queryKey: ['agents', 'filter-list'],
    queryFn: () => api.get<{ agents: Agent[] }>('/agents?limit=100'),
  });

  const buildQueryString = () => {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('page', String(page));
    if (filters.agent_id) params.set('agent_id', filters.agent_id);
    if (filters.agent_template) params.set('agent_template', filters.agent_template);
    if (filters.direction) params.set('direction', filters.direction);
    if (filters.lifecycle_state) params.set('lifecycle_state', filters.lifecycle_state);
    if (filters.has_tool_failure === 'true') params.set('has_tool_failure', 'true');
    if (filters.escalated === 'true') params.set('escalated', 'true');
    if (filters.search) params.set('search', filters.search);
    if (filters.sort_by) params.set('sort_by', filters.sort_by);
    if (filters.sort_order) params.set('sort_order', filters.sort_order);

    if (filters.dateRange) {
      const now = new Date();
      let since: Date | null = null;
      if (filters.dateRange === 'today') since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      else if (filters.dateRange === '7d') since = new Date(now.getTime() - 7 * 86400000);
      else if (filters.dateRange === '30d') since = new Date(now.getTime() - 30 * 86400000);
      if (since) params.set('since', since.toISOString());
    }

    if (filters.sentiment_band === 'positive') { params.set('sentiment_min', '0.6'); }
    else if (filters.sentiment_band === 'neutral') { params.set('sentiment_min', '0.3'); params.set('sentiment_max', '0.6'); }
    else if (filters.sentiment_band === 'negative') { params.set('sentiment_max', '0.3'); }

    if (filters.cost_range === 'low') { params.set('cost_max', '50'); }
    else if (filters.cost_range === 'medium') { params.set('cost_min', '50'); params.set('cost_max', '200'); }
    else if (filters.cost_range === 'high') { params.set('cost_min', '200'); }

    return params.toString();
  };

  const { data, isLoading } = useQuery({
    queryKey: ['calls-debug-search', page, filters],
    queryFn: () => api.get<{ calls: CallSummary[]; total: number }>(`/calls-debug/search?${buildQueryString()}`),
    enabled: activeTab === 'search',
  });

  const calls = data?.calls ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit);
  const agents = agentsData?.agents ?? [];
  const activeFilterCount = Object.values(filters).filter(v => v && v !== 'start_time' && v !== 'desc').length;

  const setFilter = (key: string, val: string) => {
    setFilters(f => ({ ...f, [key]: val }));
    setPage(1);
  };

  const openReplay = (callId: string) => {
    setSelectedCallId(callId);
    setActiveTab('replay');
    setSearchParams({ tab: 'replay', callId });
  };

  const backToSearch = () => {
    setSelectedCallId(null);
    setActiveTab('search');
    setSearchParams({});
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Call Debugging</h1>
          <p className="text-sm text-text-secondary mt-1">Trace, replay, and debug agent calls with full execution visibility</p>
        </div>
      </div>

      {activeTab !== 'replay' && (
        <div className="flex gap-1 border-b border-border">
          <button onClick={() => { setActiveTab('search'); setSearchParams({}); }}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition ${activeTab === 'search' ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
            <div className="flex items-center gap-2"><Search className="h-4 w-4" /> Search & Filter</div>
          </button>
          <button onClick={() => { setActiveTab('live'); setSearchParams({ tab: 'live' }); }}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition ${activeTab === 'live' ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
            <div className="flex items-center gap-2"><Radio className="h-4 w-4" /> Live Operations</div>
          </button>
        </div>
      )}

      {activeTab === 'replay' && selectedCallId && (
        <CallReplayView callId={selectedCallId} onBack={backToSearch} />
      )}

      {activeTab === 'live' && <LiveOperationsBoard />}

      {activeTab === 'search' && (
        <>
          <div className="flex items-center gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
              <input
                type="text"
                value={filters.search}
                onChange={(e) => setFilter('search', e.target.value)}
                placeholder="Search by call ID, agent name..."
                className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-border bg-surface text-text-primary text-sm placeholder:text-text-muted"
              />
            </div>
            <button onClick={() => setShowFilters(!showFilters)}
              className={`inline-flex items-center gap-2 text-sm font-medium px-4 py-2.5 rounded-lg border transition ${
                activeFilterCount > 0 ? 'border-primary text-primary bg-primary-light' : 'border-border text-text-secondary hover:bg-surface-hover'
              }`}>
              <Filter className="h-4 w-4" /> Filters {activeFilterCount > 0 && `(${activeFilterCount})`}
            </button>
          </div>

          {showFilters && (
            <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
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
                    {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">Agent Template</label>
                  <select value={filters.agent_template} onChange={(e) => setFilter('agent_template', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                    <option value="">All Templates</option>
                    <option value="answering-service">Answering Service</option>
                    <option value="medical-after-hours">Medical After Hours</option>
                    <option value="sales">Sales</option>
                    <option value="support">Support</option>
                    <option value="custom">Custom</option>
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
                    <option value="CALL_COMPLETED">Completed</option>
                    <option value="CALL_FAILED">Failed</option>
                    <option value="ESCALATED">Escalated</option>
                    <option value="ACTIVE_CONVERSATION">Active</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">Tool Failure</label>
                  <select value={filters.has_tool_failure} onChange={(e) => setFilter('has_tool_failure', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                    <option value="">Any</option>
                    <option value="true">Has Tool Failure</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">Escalated</label>
                  <select value={filters.escalated} onChange={(e) => setFilter('escalated', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                    <option value="">Any</option>
                    <option value="true">Escalated Only</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">Sentiment</label>
                  <select value={filters.sentiment_band} onChange={(e) => setFilter('sentiment_band', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                    <option value="">All</option>
                    <option value="positive">Positive</option>
                    <option value="neutral">Neutral</option>
                    <option value="negative">Negative</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">Cost Range</label>
                  <select value={filters.cost_range} onChange={(e) => setFilter('cost_range', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                    <option value="">All</option>
                    <option value="low">Low (&lt; $0.50)</option>
                    <option value="medium">Medium ($0.50 - $2.00)</option>
                    <option value="high">High (&gt; $2.00)</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center justify-between mt-4">
                <div className="flex items-center gap-3">
                  <label className="text-xs font-medium text-text-secondary">Sort by:</label>
                  <select value={filters.sort_by} onChange={(e) => setFilter('sort_by', e.target.value)}
                    className="px-3 py-1.5 rounded-lg border border-border bg-surface text-text-primary text-xs">
                    <option value="start_time">Date</option>
                    <option value="duration">Duration</option>
                    <option value="cost">Cost</option>
                    <option value="sentiment">Sentiment</option>
                  </select>
                  <select value={filters.sort_order} onChange={(e) => setFilter('sort_order', e.target.value)}
                    className="px-3 py-1.5 rounded-lg border border-border bg-surface text-text-primary text-xs">
                    <option value="desc">Newest First</option>
                    <option value="asc">Oldest First</option>
                  </select>
                </div>
                {activeFilterCount > 0 && (
                  <button onClick={() => { setFilters({ agent_id: '', agent_template: '', direction: '', lifecycle_state: '', dateRange: '', has_tool_failure: '', escalated: '', sentiment_band: '', cost_range: '', search: '', sort_by: 'start_time', sort_order: 'desc' }); setPage(1); }}
                    className="text-xs text-primary hover:text-primary-hover font-medium">Clear all filters</button>
                )}
              </div>
            </div>
          )}

          {isLoading ? (
            <div className="text-center py-12 text-text-secondary">Loading...</div>
          ) : calls.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-12 text-center">
              <PhoneCall className="h-12 w-12 text-text-muted mx-auto mb-3" />
              <p className="text-text-secondary">{activeFilterCount > 0 ? 'No calls match your filters' : 'No calls found'}</p>
            </div>
          ) : (
            <>
              <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="px-4 py-3 text-text-secondary font-medium text-xs">Agent</th>
                      <th className="px-4 py-3 text-text-secondary font-medium text-xs">Direction</th>
                      <th className="px-4 py-3 text-text-secondary font-medium text-xs">Status</th>
                      <th className="px-4 py-3 text-text-secondary font-medium text-xs">Duration</th>
                      <th className="px-4 py-3 text-text-secondary font-medium text-xs">Cost</th>
                      <th className="px-4 py-3 text-text-secondary font-medium text-xs">Sentiment</th>
                      <th className="px-4 py-3 text-text-secondary font-medium text-xs">Flags</th>
                      <th className="px-4 py-3 text-text-secondary font-medium text-xs">Date</th>
                      <th className="px-4 py-3 text-text-secondary font-medium text-xs"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {calls.map(call => (
                      <tr key={call.id} className="border-b border-border last:border-0 hover:bg-surface-hover transition-colors">
                        <td className="px-4 py-3 text-text-primary text-sm">{call.agent_name || '--'}</td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            call.direction === 'inbound' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                          }`}>{call.direction}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            call.lifecycle_state === 'CALL_COMPLETED' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                            call.lifecycle_state === 'CALL_FAILED' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                            'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                          }`}>{call.lifecycle_state}</span>
                        </td>
                        <td className="px-4 py-3 text-text-secondary text-xs">{call.duration_seconds ? `${call.duration_seconds}s` : '--'}</td>
                        <td className="px-4 py-3 text-text-secondary text-xs">{call.total_cost_cents != null ? `$${(call.total_cost_cents / 100).toFixed(2)}` : '--'}</td>
                        <td className="px-4 py-3">
                          {call.sentiment_score != null ? (
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                              call.sentiment_score >= 0.6 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                              call.sentiment_score >= 0.3 ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                              'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                            }`}>{call.sentiment_score.toFixed(2)}</span>
                          ) : <span className="text-xs text-text-muted">--</span>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            {call.has_tool_failure && (
                              <span className="text-xs px-1.5 py-0.5 bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 rounded" title="Tool Failure">
                                <AlertTriangle className="h-3 w-3" />
                              </span>
                            )}
                            {call.escalated && (
                              <span className="text-xs px-1.5 py-0.5 bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 rounded" title="Escalated">
                                <TrendingUp className="h-3 w-3" />
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-text-secondary text-xs">{call.start_time ? format(new Date(call.start_time), 'MMM d, h:mm a') : '--'}</td>
                        <td className="px-4 py-3">
                          <button onClick={() => openReplay(call.id)}
                            className="text-xs text-primary hover:text-primary-hover font-medium flex items-center gap-1">
                            <Eye className="h-3.5 w-3.5" /> Replay
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-between">
                  <p className="text-sm text-text-secondary">{total} calls total</p>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                      className="p-2 rounded-lg border border-border hover:bg-surface-hover disabled:opacity-30 transition">
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <span className="text-sm text-text-secondary">Page {page} of {totalPages}</span>
                    <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                      className="p-2 rounded-lg border border-border hover:bg-surface-hover disabled:opacity-30 transition">
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
