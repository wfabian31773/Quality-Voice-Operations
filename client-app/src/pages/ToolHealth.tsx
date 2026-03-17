import { useState, useEffect, useCallback } from 'react';
import {
  Activity, AlertTriangle, CheckCircle, XCircle, RefreshCw,
  Clock, Wrench, ArrowUpRight, Shield, ChevronDown, ChevronUp,
  Phone, Users,
} from 'lucide-react';

interface ToolMetric {
  toolName: string;
  totalExecutions: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  retryCount: number;
  avgDurationMs: number;
  recentFailures: Array<{
    id: string;
    error: string;
    callSessionId: string;
    retryCount: number;
    fallbackAttempted: boolean;
    fallbackSuccess: boolean;
    createdAt: string;
  }>;
}

interface EscalationTask {
  id: string;
  callSessionId: string;
  agentSlug: string | null;
  callerPhone: string | null;
  reason: string;
  priority: string;
  status: string;
  assignedTo: string | null;
  notes: string | null;
  toolName: string | null;
  createdAt: string;
}

interface HealthData {
  tools: ToolMetric[];
  overallSuccessRate: number;
  totalExecutions: number;
  totalFailures: number;
  callCompletionRate: number;
}

interface EscalationStats {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
}

const API_BASE = '/api';

async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...options });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function priorityColor(p: string): string {
  switch (p) {
    case 'critical': return 'text-red-500 bg-red-500/10';
    case 'high': return 'text-orange-500 bg-orange-500/10';
    case 'medium': return 'text-yellow-500 bg-yellow-500/10';
    default: return 'text-blue-500 bg-blue-500/10';
  }
}

function statusColor(s: string): string {
  switch (s) {
    case 'pending': return 'text-yellow-500 bg-yellow-500/10';
    case 'assigned':
    case 'in_progress': return 'text-blue-500 bg-blue-500/10';
    case 'completed': return 'text-green-500 bg-green-500/10';
    case 'dismissed': return 'text-muted bg-muted/10';
    default: return 'text-muted bg-muted/10';
  }
}

function successRateColor(rate: number): string {
  if (rate >= 99) return 'text-green-500';
  if (rate >= 95) return 'text-yellow-500';
  return 'text-red-500';
}

export default function ToolHealth() {
  const [window, setWindow] = useState('7d');
  const [tab, setTab] = useState<'health' | 'escalations'>('health');
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [escalationTasks, setEscalationTasks] = useState<EscalationTask[]>([]);
  const [escalationStats, setEscalationStats] = useState<EscalationStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedTool, setExpandedTool] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === 'health') {
        const data = await apiFetch(`/tool-health/metrics?window=${window}`);
        setHealthData(data);
      } else {
        const [tasksRes, statsRes] = await Promise.all([
          apiFetch('/escalation-tasks?limit=50'),
          apiFetch('/escalation-tasks/stats'),
        ]);
        setEscalationTasks(tasksRes.tasks);
        setEscalationStats(statsRes);
      }
    } catch {
      // silently handle fetch errors
    } finally {
      setLoading(false);
    }
  }, [window, tab]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleUpdateTask = async (taskId: string, status: string) => {
    try {
      await apiFetch(`/escalation-tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      fetchData();
    } catch {
      // silently handle
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Shield className="w-7 h-7 text-primary" />
            Platform Reliability
          </h1>
          <p className="text-muted mt-1">Tool health monitoring, failure tracking, and escalation management</p>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-2 px-4 py-2 bg-surface border border-border rounded-lg hover:bg-surface-hover transition-colors text-sm"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => setTab('health')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === 'health' ? 'bg-primary text-white' : 'bg-surface border border-border text-muted hover:text-foreground'}`}
        >
          <Activity className="w-4 h-4 inline mr-1.5" />
          Tool Health
        </button>
        <button
          onClick={() => setTab('escalations')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === 'escalations' ? 'bg-primary text-white' : 'bg-surface border border-border text-muted hover:text-foreground'}`}
        >
          <Users className="w-4 h-4 inline mr-1.5" />
          Escalation Queue
        </button>
      </div>

      {tab === 'health' && (
        <>
          <div className="flex gap-2">
            {['24h', '7d', '30d'].map((w) => (
              <button
                key={w}
                onClick={() => setWindow(w)}
                className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${window === w ? 'bg-primary text-white' : 'bg-surface border border-border text-muted hover:text-foreground'}`}
              >
                {w === '24h' ? 'Last 24h' : w === '7d' ? 'Last 7 days' : 'Last 30 days'}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="grid grid-cols-4 gap-4">
              {[1,2,3,4].map(i => <div key={i} className="h-24 bg-surface border border-border rounded-xl animate-pulse" />)}
            </div>
          ) : healthData && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-surface border border-border rounded-xl p-4">
                  <div className="flex items-center gap-2 text-muted text-sm mb-1">
                    <Wrench className="w-4 h-4" />
                    Total Executions
                  </div>
                  <div className="text-2xl font-bold text-foreground">{healthData.totalExecutions.toLocaleString()}</div>
                </div>
                <div className="bg-surface border border-border rounded-xl p-4">
                  <div className="flex items-center gap-2 text-muted text-sm mb-1">
                    <CheckCircle className="w-4 h-4 text-green-500" />
                    Tool Success Rate
                  </div>
                  <div className={`text-2xl font-bold ${successRateColor(healthData.overallSuccessRate)}`}>
                    {healthData.overallSuccessRate}%
                  </div>
                </div>
                <div className="bg-surface border border-border rounded-xl p-4">
                  <div className="flex items-center gap-2 text-muted text-sm mb-1">
                    <XCircle className="w-4 h-4 text-red-500" />
                    Total Failures
                  </div>
                  <div className="text-2xl font-bold text-foreground">{healthData.totalFailures.toLocaleString()}</div>
                </div>
                <div className="bg-surface border border-border rounded-xl p-4">
                  <div className="flex items-center gap-2 text-muted text-sm mb-1">
                    <Phone className="w-4 h-4 text-primary" />
                    Call Completion Rate
                  </div>
                  <div className={`text-2xl font-bold ${successRateColor(healthData.callCompletionRate)}`}>
                    {healthData.callCompletionRate}%
                  </div>
                </div>
              </div>

              <div className="bg-surface border border-border rounded-xl overflow-hidden">
                <div className="p-4 border-b border-border">
                  <h2 className="text-lg font-semibold text-foreground">Per-Tool Health</h2>
                </div>
                {healthData.tools.length === 0 ? (
                  <div className="p-8 text-center text-muted">
                    <Wrench className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p>No tool executions in this time window</p>
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {healthData.tools.map((tool) => (
                      <div key={tool.toolName}>
                        <button
                          onClick={() => setExpandedTool(expandedTool === tool.toolName ? null : tool.toolName)}
                          className="w-full px-4 py-3 flex items-center justify-between hover:bg-surface-hover transition-colors"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className={`w-2 h-2 rounded-full ${tool.successRate >= 99 ? 'bg-green-500' : tool.successRate >= 95 ? 'bg-yellow-500' : 'bg-red-500'}`} />
                            <span className="font-mono text-sm text-foreground">{tool.toolName}</span>
                          </div>
                          <div className="flex items-center gap-6 text-sm">
                            <div className="text-right">
                              <span className="text-muted mr-1">Executions:</span>
                              <span className="font-medium text-foreground">{tool.totalExecutions}</span>
                            </div>
                            <div className="text-right">
                              <span className="text-muted mr-1">Success:</span>
                              <span className={`font-medium ${successRateColor(tool.successRate)}`}>{tool.successRate}%</span>
                            </div>
                            <div className="text-right">
                              <span className="text-muted mr-1">Retries:</span>
                              <span className="font-medium text-foreground">{tool.retryCount}</span>
                            </div>
                            <div className="text-right">
                              <span className="text-muted mr-1">Avg:</span>
                              <span className="font-medium text-foreground">{formatDuration(tool.avgDurationMs)}</span>
                            </div>
                            {expandedTool === tool.toolName ? <ChevronUp className="w-4 h-4 text-muted" /> : <ChevronDown className="w-4 h-4 text-muted" />}
                          </div>
                        </button>

                        {expandedTool === tool.toolName && tool.recentFailures.length > 0 && (
                          <div className="px-4 pb-3 bg-surface-hover/50">
                            <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2 pt-2">Recent Failures</h4>
                            <div className="space-y-2">
                              {tool.recentFailures.map((f) => (
                                <div key={f.id} className="bg-surface border border-border rounded-lg p-3 text-sm">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2 mb-1">
                                        <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                                        <span className="text-foreground font-medium truncate">{f.error.substring(0, 100)}</span>
                                      </div>
                                      <div className="flex items-center gap-3 text-xs text-muted">
                                        <span>Session: {f.callSessionId.substring(0, 8)}…</span>
                                        <span>Retries: {f.retryCount}</span>
                                        {f.fallbackAttempted && (
                                          <span className={f.fallbackSuccess ? 'text-green-500' : 'text-red-500'}>
                                            Fallback: {f.fallbackSuccess ? 'OK' : 'Failed'}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    <span className="text-xs text-muted whitespace-nowrap">
                                      <Clock className="w-3 h-3 inline mr-0.5" />
                                      {formatDate(f.createdAt)}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {expandedTool === tool.toolName && tool.recentFailures.length === 0 && (
                          <div className="px-4 pb-3 bg-surface-hover/50">
                            <p className="text-sm text-muted py-2 flex items-center gap-2">
                              <CheckCircle className="w-4 h-4 text-green-500" />
                              No recent failures for this tool
                            </p>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {tab === 'escalations' && (
        <>
          {loading ? (
            <div className="grid grid-cols-4 gap-4">
              {[1,2,3,4].map(i => <div key={i} className="h-24 bg-surface border border-border rounded-xl animate-pulse" />)}
            </div>
          ) : escalationStats && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-surface border border-border rounded-xl p-4">
                <div className="text-muted text-sm mb-1">Total Tasks</div>
                <div className="text-2xl font-bold text-foreground">{escalationStats.total}</div>
              </div>
              <div className="bg-surface border border-border rounded-xl p-4">
                <div className="text-muted text-sm mb-1 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 text-yellow-500" /> Pending
                </div>
                <div className="text-2xl font-bold text-yellow-500">{escalationStats.pending}</div>
              </div>
              <div className="bg-surface border border-border rounded-xl p-4">
                <div className="text-muted text-sm mb-1 flex items-center gap-1">
                  <ArrowUpRight className="w-3.5 h-3.5 text-blue-500" /> In Progress
                </div>
                <div className="text-2xl font-bold text-blue-500">{escalationStats.inProgress}</div>
              </div>
              <div className="bg-surface border border-border rounded-xl p-4">
                <div className="text-muted text-sm mb-1 flex items-center gap-1">
                  <CheckCircle className="w-3.5 h-3.5 text-green-500" /> Completed
                </div>
                <div className="text-2xl font-bold text-green-500">{escalationStats.completed}</div>
              </div>
            </div>
          )}

          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <div className="p-4 border-b border-border">
              <h2 className="text-lg font-semibold text-foreground">Escalation Queue</h2>
            </div>
            {escalationTasks.length === 0 ? (
              <div className="p-8 text-center text-muted">
                <CheckCircle className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p>No escalation tasks in the queue</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {escalationTasks.map((task) => (
                  <div key={task.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${priorityColor(task.priority)}`}>
                            {task.priority.toUpperCase()}
                          </span>
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColor(task.status)}`}>
                            {task.status.replace('_', ' ')}
                          </span>
                          {task.toolName && (
                            <span className="text-xs font-mono text-muted bg-muted/10 px-1.5 py-0.5 rounded">
                              {task.toolName}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-foreground">{task.reason}</p>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted">
                          <span>Session: {task.callSessionId.substring(0, 8)}…</span>
                          {task.callerPhone && <span>Caller: {task.callerPhone}</span>}
                          {task.agentSlug && <span>Agent: {task.agentSlug}</span>}
                          <span>{formatDate(task.createdAt)}</span>
                        </div>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        {task.status === 'pending' && (
                          <>
                            <button
                              onClick={() => handleUpdateTask(task.id, 'in_progress')}
                              className="px-2.5 py-1 text-xs bg-blue-500/10 text-blue-500 rounded-md hover:bg-blue-500/20 transition-colors"
                            >
                              Start
                            </button>
                            <button
                              onClick={() => handleUpdateTask(task.id, 'dismissed')}
                              className="px-2.5 py-1 text-xs bg-muted/10 text-muted rounded-md hover:bg-muted/20 transition-colors"
                            >
                              Dismiss
                            </button>
                          </>
                        )}
                        {(task.status === 'assigned' || task.status === 'in_progress') && (
                          <button
                            onClick={() => handleUpdateTask(task.id, 'completed')}
                            className="px-2.5 py-1 text-xs bg-green-500/10 text-green-500 rounded-md hover:bg-green-500/20 transition-colors"
                          >
                            Complete
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
