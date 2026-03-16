import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../lib/api';
import {
  PhoneCall, Bot, Clock, TrendingUp, AlertTriangle, Wifi, WifiOff,
  Wrench, Check, Loader2, X, Bell, BellOff, ChevronDown, ChevronUp,
  Phone, User, Activity, Filter, Pause, Play, ExternalLink,
  CheckCircle2, XCircle, AlertCircle, Timer, Zap, Eye,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface ActiveCall {
  id: string;
  direction: string;
  lifecycle_state: string;
  start_time: string;
  agent_id: string;
  agent_name: string | null;
  caller_number: string | null;
  escalation_target: string | null;
  duration_seconds: number | null;
}

interface TranscriptMessage {
  id: string;
  speaker: 'caller' | 'agent';
  text: string;
  timestamp: string;
}

interface ToolExecution {
  id: string;
  tool: string;
  status: 'running' | 'completed';
  startedAt: string;
  completedAt?: string;
}

interface RealtimeMetrics {
  totalCalls: number;
  completedCalls: number;
  failedCalls: number;
  escalatedCalls: number;
  activeCalls: number;
  avgDuration: number;
  completionRate: number;
  callsPerHour: number;
  toolExecutions: number;
  toolsRunning: number;
  hourlyData: Array<{ hour: string; calls: number }>;
  recentTools: Array<{
    id: string;
    eventType: string;
    tool: string;
    agentName: string;
    callerNumber: string;
    timestamp: string;
    status: string;
  }>;
}

interface OperationsAlert {
  id: string;
  type: string;
  severity: string;
  message: string;
  metadata: Record<string, unknown>;
  call_session_id: string | null;
  agent_id: string | null;
  acknowledged: boolean;
  created_at: string;
}

type TimeRange = '1h' | 'today' | '7d' | '30d';

const TIME_RANGES: { value: TimeRange; label: string }[] = [
  { value: '1h', label: 'Last Hour' },
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
];

function useSSEActiveCalls() {
  const [activeCalls, setActiveCalls] = useState<ActiveCall[]>([]);
  const [connected, setConnected] = useState(false);
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/calls/live', { withCredentials: true });
    esRef.current = es;

    es.addEventListener('active_calls', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as ActiveCall[];
        setActiveCalls(data);
        setConnected(true);
      } catch {}
    });

    const handleLifecycleEvent = () => {
      setConnected(true);
      queryClient.invalidateQueries({ queryKey: ['operations-metrics'] });
      queryClient.invalidateQueries({ queryKey: ['operations-alerts'] });
    };

    es.addEventListener('call_started', handleLifecycleEvent);
    es.addEventListener('call_connected', handleLifecycleEvent);
    es.addEventListener('call_completed', handleLifecycleEvent);
    es.addEventListener('call_failed', handleLifecycleEvent);
    es.addEventListener('call_escalated', handleLifecycleEvent);
    es.addEventListener('call_updated', handleLifecycleEvent);

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [queryClient]);

  return { activeCalls, connected };
}

function useCallSSE(callId: string | null) {
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [tools, setTools] = useState<ToolExecution[]>([]);
  const [callState, setCallState] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const msgCounter = useRef(0);
  const toolCounter = useRef(0);

  useEffect(() => {
    if (!callId) {
      setTranscript([]);
      setTools([]);
      setCallState(null);
      return;
    }

    const es = new EventSource(`/api/operations/calls/${callId}/live`, { withCredentials: true });
    esRef.current = es;

    es.addEventListener('call_state', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        setCallState(data.state);
      } catch {}
    });

    es.addEventListener('transcript', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        const msg: TranscriptMessage = {
          id: `msg-${++msgCounter.current}`,
          speaker: data.speaker,
          text: data.text,
          timestamp: data.timestamp,
        };
        setTranscript((prev) => [...prev, msg]);
      } catch {}
    });

    es.addEventListener('tool_start', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        const toolExec: ToolExecution = {
          id: data.invocationId ?? `tool-${++toolCounter.current}`,
          tool: data.tool,
          status: 'running',
          startedAt: data.timestamp,
        };
        setTools((prev) => [...prev, toolExec]);
      } catch {}
    });

    es.addEventListener('tool_end', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        const pairedId = data.pairedStartId;
        setTools((prev) =>
          prev.map((t) => {
            if (pairedId && t.id === pairedId && t.status === 'running') {
              return { ...t, status: 'completed' as const, completedAt: data.timestamp };
            }
            if (!pairedId && t.tool === data.tool && t.status === 'running') {
              return { ...t, status: 'completed' as const, completedAt: data.timestamp };
            }
            return t;
          }),
        );
      } catch {}
    });

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [callId]);

  return { transcript, tools, callState };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function LiveTimer({ startTime }: { startTime: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = new Date(startTime).getTime();
    const update = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  return <span className="font-mono text-sm">{formatDuration(elapsed)}</span>;
}

function stateLabel(state: string): string {
  const map: Record<string, string> = {
    CALL_CONNECTED: 'Connected',
    CALL_COMPLETED: 'Completed',
    CALL_STARTED: 'Ringing',
    CALL_RECEIVED: 'Received',
    CALL_FAILED: 'Failed',
    CALL_ESCALATED: 'Escalated',
    AGENT_CONNECTED: 'Agent Connected',
    ACTIVE_CONVERSATION: 'Active',
    ESCALATED: 'Escalated',
    SESSION_INITIALIZED: 'Initializing',
    TOOL_EXECUTION: 'Tool Running',
    WORKFLOW_EXECUTION: 'Workflow Running',
  };
  return map[state] ?? state.replace(/_/g, ' ').toLowerCase();
}

function stateColor(state: string): string {
  if (['CALL_CONNECTED', 'AGENT_CONNECTED', 'ACTIVE_CONVERSATION', 'active'].includes(state))
    return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  if (['CALL_COMPLETED'].includes(state))
    return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  if (['CALL_FAILED', 'WORKFLOW_FAILED', 'ESCALATION_FAILED'].includes(state))
    return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
  if (['ESCALATED', 'CALL_ESCALATED'].includes(state))
    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
  return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
}

function severityColor(severity: string): string {
  if (severity === 'critical') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
  if (severity === 'error') return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400';
  if (severity === 'warning') return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
  return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
}

function severityIcon(severity: string) {
  if (severity === 'critical') return XCircle;
  if (severity === 'error') return AlertCircle;
  return AlertTriangle;
}

function redactPhone(phone: string | null): string {
  if (!phone) return '***';
  if (phone.length <= 4) return '***';
  return '***' + phone.slice(-4);
}

function toolLabel(toolName: string): string {
  const map: Record<string, string> = {
    createServiceTicket: 'Create Ticket',
    createAfterHoursTicket: 'After-Hours Ticket',
    checkAvailability: 'Check Calendar',
    scheduleAppointment: 'Schedule Appt',
    lookupCustomer: 'CRM Lookup',
    searchCRM: 'CRM Search',
    sendSMS: 'Send SMS',
    triageEscalate: 'Triage Escalation',
    retrieve_knowledge: 'Knowledge Search',
    send_sms: 'Send SMS',
    create_ticket: 'Create Ticket',
  };
  return map[toolName] ?? toolName.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim();
}

function MetricCard({ icon: Icon, label, value, subtext, color }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  subtext?: string;
  color: string;
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg ${color}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-text-secondary truncate">{label}</p>
          <p className="text-xl font-bold text-text-primary">{value}</p>
          {subtext && <p className="text-[10px] text-text-secondary">{subtext}</p>}
        </div>
      </div>
    </div>
  );
}

function ActiveCallsPanel({ calls, selectedCallId, onSelectCall }: {
  calls: ActiveCall[];
  selectedCallId: string | null;
  onSelectCall: (id: string | null) => void;
}) {
  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
          </span>
          Active Calls
          {calls.length > 0 && (
            <span className="ml-2 text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 px-2 py-0.5 rounded-full">
              {calls.length}
            </span>
          )}
        </h2>
      </div>

      {calls.length === 0 ? (
        <div className="p-8 text-center">
          <Phone className="h-8 w-8 text-text-secondary/30 mx-auto mb-2" />
          <p className="text-sm text-text-secondary">No active calls right now</p>
        </div>
      ) : (
        <div className="divide-y divide-border max-h-96 overflow-y-auto">
          {calls.map((call) => (
            <div
              key={call.id}
              onClick={() => onSelectCall(selectedCallId === call.id ? null : call.id)}
              className={`px-5 py-3 flex items-center gap-4 cursor-pointer transition-colors ${
                selectedCallId === call.id
                  ? 'bg-primary/5 border-l-2 border-l-primary'
                  : 'hover:bg-surface-hover'
              }`}
            >
              <div className="p-2 rounded-lg bg-green-100 dark:bg-green-900/30">
                <Phone className="h-4 w-4 text-green-700 dark:text-green-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-text-primary">{call.agent_name || 'Agent'}</p>
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium ${stateColor(call.lifecycle_state)}`}>
                    {stateLabel(call.lifecycle_state)}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-text-secondary">{redactPhone(call.caller_number)}</span>
                  <span className="text-xs text-text-secondary">·</span>
                  <span className={`text-xs ${call.direction === 'inbound' ? 'text-blue-600 dark:text-blue-400' : 'text-amber-600 dark:text-amber-400'}`}>
                    {call.direction}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <LiveTimer startTime={call.start_time} />
                <Eye className="h-3.5 w-3.5 text-text-secondary" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LiveTranscriptPanel({ transcript, tools, callState, callId, onClose }: {
  transcript: TranscriptMessage[];
  tools: ToolExecution[];
  callState: string | null;
  callId: string;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<'transcript' | 'tools'>('transcript');

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript]);

  const isActive = callState && !['CALL_COMPLETED', 'CALL_FAILED', 'WORKFLOW_FAILED', 'ESCALATION_FAILED'].includes(callState);

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-text-primary">Live Call Monitor</h3>
          {isActive && (
            <span className="flex items-center gap-1 text-[10px] text-green-600 dark:text-green-400">
              <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
              Live
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-text-secondary font-mono">{callId.slice(0, 8)}...</span>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="border-b border-border">
        <div className="flex px-5">
          <button onClick={() => setTab('transcript')}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition ${tab === 'transcript' ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
            Transcript ({transcript.length})
          </button>
          <button onClick={() => setTab('tools')}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition ${tab === 'tools' ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
            Tools ({tools.length})
          </button>
        </div>
      </div>

      <div className="p-4">
        {tab === 'transcript' ? (
          <div ref={scrollRef} className="max-h-72 overflow-y-auto space-y-2 scroll-smooth">
            {transcript.length === 0 ? (
              <div className="text-center py-6">
                <Bot className="h-6 w-6 text-text-secondary/30 mx-auto mb-2" />
                <p className="text-xs text-text-secondary">
                  {isActive ? 'Waiting for conversation...' : 'No transcript available'}
                </p>
              </div>
            ) : (
              transcript.map((msg) => (
                <div key={msg.id} className={`flex gap-2 ${msg.speaker === 'agent' ? 'flex-row' : 'flex-row-reverse'}`}>
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                    msg.speaker === 'agent' ? 'bg-primary/10' : 'bg-surface-hover'
                  }`}>
                    {msg.speaker === 'agent'
                      ? <Bot className="h-3 w-3 text-primary" />
                      : <User className="h-3 w-3 text-text-secondary" />
                    }
                  </div>
                  <div className={`max-w-[80%] ${msg.speaker === 'agent' ? 'text-left' : 'text-right'}`}>
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-[10px] font-medium text-text-secondary uppercase">
                        {msg.speaker === 'agent' ? 'Agent' : 'Caller'}
                      </span>
                      <span className="text-[10px] text-text-secondary/50">
                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                    </div>
                    <div className={`inline-block px-3 py-1.5 rounded-xl text-xs leading-relaxed ${
                      msg.speaker === 'agent'
                        ? 'bg-primary-light text-text-primary rounded-tl-sm'
                        : 'bg-surface-hover text-text-primary rounded-tr-sm'
                    }`}>
                      {msg.text}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto space-y-2">
            {tools.length === 0 ? (
              <div className="text-center py-6">
                <Wrench className="h-6 w-6 text-text-secondary/30 mx-auto mb-2" />
                <p className="text-xs text-text-secondary">
                  {isActive ? 'Waiting for tool invocations...' : 'No tools executed'}
                </p>
              </div>
            ) : (
              tools.map((tool) => (
                <div key={tool.id} className={`flex items-center gap-3 px-3 py-2 rounded-lg border ${
                  tool.status === 'running'
                    ? 'border-amber-200 bg-amber-50 dark:border-amber-900/30 dark:bg-amber-900/10'
                    : 'border-border bg-surface-hover'
                }`}>
                  <Wrench className={`h-3.5 w-3.5 shrink-0 ${tool.status === 'running' ? 'text-amber-600' : 'text-text-secondary'}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-text-primary truncate">{toolLabel(tool.tool)}</p>
                    <p className="text-[10px] text-text-secondary">
                      {new Date(tool.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </p>
                  </div>
                  {tool.status === 'running' ? (
                    <div className="flex items-center gap-1 text-[10px] text-amber-600">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Running
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 text-[10px] text-green-600">
                      <Check className="h-3 w-3" />
                      Done
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolExecutionFeed({ tools, agentFilter, onAgentFilterChange }: {
  tools: RealtimeMetrics['recentTools'];
  agentFilter: string;
  onAgentFilterChange: (v: string) => void;
}) {
  const agents = [...new Set(tools.map(t => t.agentName))].filter(Boolean);
  const filtered = agentFilter ? tools.filter(t => t.agentName === agentFilter) : tools;

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
          <Wrench className="h-4 w-4 text-text-secondary" />
          Tool Execution Feed
        </h2>
        {agents.length > 1 && (
          <select
            value={agentFilter}
            onChange={(e) => onAgentFilterChange(e.target.value)}
            className="text-xs px-2 py-1 rounded-lg border border-border bg-surface text-text-primary"
          >
            <option value="">All Agents</option>
            {agents.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="p-6 text-center">
          <Wrench className="h-7 w-7 text-text-secondary/30 mx-auto mb-2" />
          <p className="text-sm text-text-secondary">No recent tool executions</p>
        </div>
      ) : (
        <div className="divide-y divide-border max-h-80 overflow-y-auto">
          {filtered.map((tool) => (
            <div key={tool.id} className="px-5 py-3 flex items-center gap-3">
              <div className={`p-1.5 rounded-lg ${tool.status === 'completed' ? 'bg-green-100 dark:bg-green-900/30' : 'bg-amber-100 dark:bg-amber-900/30'}`}>
                <Wrench className={`h-3.5 w-3.5 ${tool.status === 'completed' ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-text-primary">{toolLabel(tool.tool)}</p>
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                    tool.status === 'completed'
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                  }`}>
                    {tool.status === 'completed' ? 'Success' : 'Running'}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-text-secondary">{tool.agentName}</span>
                  <span className="text-xs text-text-secondary">·</span>
                  <span className="text-xs text-text-secondary">{tool.callerNumber}</span>
                </div>
              </div>
              <span className="text-[10px] text-text-secondary shrink-0">
                {formatDistanceToNow(new Date(tool.timestamp), { addSuffix: true })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AlertsPanel({ alerts, unacknowledgedCount, onAcknowledge, onAcknowledgeAll }: {
  alerts: OperationsAlert[];
  unacknowledgedCount: number;
  onAcknowledge: (id: string) => void;
  onAcknowledgeAll: () => void;
}) {
  const [showHistory, setShowHistory] = useState(false);

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
          <Bell className="h-4 w-4 text-text-secondary" />
          Alerts
          {unacknowledgedCount > 0 && (
            <span className="ml-1 inline-flex items-center justify-center w-5 h-5 text-[10px] font-bold text-white bg-red-500 rounded-full">
              {unacknowledgedCount > 99 ? '99+' : unacknowledgedCount}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {unacknowledgedCount > 0 && (
            <button
              onClick={onAcknowledgeAll}
              className="text-xs text-primary hover:text-primary-hover font-medium"
            >
              Dismiss All
            </button>
          )}
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="text-xs text-text-secondary hover:text-text-primary flex items-center gap-1"
          >
            {showHistory ? 'Active' : 'History'}
            {showHistory ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {alerts.length === 0 ? (
        <div className="p-6 text-center">
          <BellOff className="h-7 w-7 text-text-secondary/30 mx-auto mb-2" />
          <p className="text-sm text-text-secondary">
            {showHistory ? 'No alert history' : 'No active alerts — all clear!'}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border max-h-64 overflow-y-auto">
          {alerts.map((alert) => {
            const SeverityIcon = severityIcon(alert.severity);
            return (
              <div key={alert.id} className="px-5 py-3 flex items-start gap-3">
                <div className={`p-1.5 rounded-lg mt-0.5 ${severityColor(alert.severity)}`}>
                  <SeverityIcon className="h-3.5 w-3.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${severityColor(alert.severity)}`}>
                      {alert.severity}
                    </span>
                    <span className="text-[10px] text-text-secondary">
                      {alert.type.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <p className="text-sm text-text-primary mt-0.5 line-clamp-2">{alert.message}</p>
                  <p className="text-[10px] text-text-secondary mt-0.5">
                    {formatDistanceToNow(new Date(alert.created_at), { addSuffix: true })}
                  </p>
                </div>
                {!alert.acknowledged && (
                  <button
                    onClick={() => onAcknowledge(alert.id)}
                    className="text-xs text-text-secondary hover:text-text-primary shrink-0 mt-1"
                    title="Dismiss"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MiniSparkline({ data }: { data: Array<{ calls: number }> }) {
  if (data.length === 0) return null;
  const max = Math.max(1, ...data.map(d => d.calls));

  return (
    <div className="flex items-end gap-px h-8 w-24">
      {data.slice(-12).map((d, i) => (
        <div
          key={i}
          className="flex-1 bg-primary/30 rounded-t min-h-[1px]"
          style={{ height: `${(d.calls / max) * 100}%` }}
        />
      ))}
    </div>
  );
}

export default function Operations() {
  const [timeRange, setTimeRange] = useState<TimeRange>('1h');
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState('');
  const [showAlertHistory, setShowAlertHistory] = useState(false);

  const { activeCalls, connected } = useSSEActiveCalls();
  const { transcript, tools, callState } = useCallSSE(selectedCallId);

  const { data: metrics } = useQuery({
    queryKey: ['operations-metrics', timeRange],
    queryFn: () => api.get<RealtimeMetrics>(`/operations/realtime?range=${timeRange}`),
    refetchInterval: 10000,
  });

  const { data: alertsData, refetch: refetchAlerts } = useQuery({
    queryKey: ['operations-alerts', showAlertHistory],
    queryFn: () => api.get<{ alerts: OperationsAlert[]; unacknowledgedCount: number }>(
      `/operations/alerts?acknowledged=${showAlertHistory}`
    ),
    refetchInterval: 15000,
  });

  const acknowledgeMutation = useMutation({
    mutationFn: (alertId: string) => api.post(`/operations/alerts/${alertId}/acknowledge`),
    onSuccess: () => refetchAlerts(),
  });

  const acknowledgeAllMutation = useMutation({
    mutationFn: () => api.post('/operations/alerts/acknowledge-all'),
    onSuccess: () => refetchAlerts(),
  });

  const handleSelectCall = useCallback((id: string | null) => {
    setSelectedCallId(id);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Operations</h1>
          <p className="text-sm text-text-secondary mt-1">Real-time monitoring of agent activity and performance</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-1 bg-surface-secondary rounded-lg p-1">
            {TIME_RANGES.map((r) => (
              <button
                key={r.value}
                onClick={() => setTimeRange(r.value)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  timeRange === r.value
                    ? 'bg-surface shadow text-text-primary'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            {connected ? (
              <><Wifi className="h-3.5 w-3.5 text-green-500" /><span className="text-green-600 dark:text-green-400">Live</span></>
            ) : (
              <><WifiOff className="h-3.5 w-3.5 text-gray-400" /><span className="text-text-secondary">Connecting...</span></>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <MetricCard
          icon={PhoneCall}
          label="Active Calls"
          value={activeCalls.length}
          color="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
        />
        <MetricCard
          icon={TrendingUp}
          label="Calls/Hour"
          value={metrics?.callsPerHour ?? 0}
          color="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
        />
        <MetricCard
          icon={CheckCircle2}
          label="Completion Rate"
          value={`${metrics?.completionRate ?? 0}%`}
          color="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
        />
        <MetricCard
          icon={Clock}
          label="Avg Duration"
          value={metrics?.avgDuration ? formatDuration(metrics.avgDuration) : '--'}
          color="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
        />
        <MetricCard
          icon={Wrench}
          label="Tool Executions"
          value={metrics?.toolExecutions ?? 0}
          subtext={metrics?.toolsRunning ? `${metrics.toolsRunning} running` : undefined}
          color="bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"
        />
        <MetricCard
          icon={AlertTriangle}
          label="Failed Calls"
          value={metrics?.failedCalls ?? 0}
          color="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
        />
      </div>

      {metrics?.hourlyData && metrics.hourlyData.length > 0 && (
        <div className="bg-surface border border-border rounded-xl shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-text-primary">Call Volume Trend</h3>
            <span className="text-xs text-text-secondary">{metrics.totalCalls} total calls</span>
          </div>
          <div className="flex items-end gap-1 h-24">
            {metrics.hourlyData.map((d, i) => {
              const max = Math.max(1, ...metrics.hourlyData.map(h => h.calls));
              return (
                <div
                  key={i}
                  className="flex-1 bg-primary/40 hover:bg-primary/60 rounded-t min-h-[2px] transition-colors"
                  style={{ height: `${(d.calls / max) * 100}%` }}
                  title={`${new Date(d.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${d.calls} calls`}
                />
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <ActiveCallsPanel
            calls={activeCalls}
            selectedCallId={selectedCallId}
            onSelectCall={handleSelectCall}
          />

          {selectedCallId && (
            <LiveTranscriptPanel
              transcript={transcript}
              tools={tools}
              callState={callState}
              callId={selectedCallId}
              onClose={() => setSelectedCallId(null)}
            />
          )}
        </div>

        <div className="space-y-6">
          <AlertsPanel
            alerts={alertsData?.alerts ?? []}
            unacknowledgedCount={alertsData?.unacknowledgedCount ?? 0}
            onAcknowledge={(id) => acknowledgeMutation.mutate(id)}
            onAcknowledgeAll={() => acknowledgeAllMutation.mutate()}
          />

          <ToolExecutionFeed
            tools={metrics?.recentTools ?? []}
            agentFilter={agentFilter}
            onAgentFilterChange={setAgentFilter}
          />
        </div>
      </div>
    </div>
  );
}
