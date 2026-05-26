import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '../components/ui';
import {
  Activity, AlertTriangle, CheckCircle, XCircle, RefreshCw,
  Clock, Wrench, ArrowUpRight, Shield, ChevronDown, ChevronUp,
  Phone, Users, ShieldAlert, KeyRound, ServerCrash,
  BellOff, BellRing, Mail, MailX, UserX,
} from 'lucide-react';
import { useAuth } from '../lib/auth';

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

interface EscalationRecipient {
  id: string;
  email: string;
  name: string | null;
  // Mirrors EscalationRecipientRole on the server: legacy admin/owner plus
  // the canonical RBAC roles tenant_owner / operations_manager that come in
  // through the user_roles join.
  role: 'admin' | 'owner' | 'tenant_owner' | 'operations_manager';
  prefs: { inApp: boolean; email: boolean };
  optedOut: boolean;
}

type RejectionReason = 'missing_header' | 'invalid_signature' | 'validator_unavailable';

interface WebhookSecuritySnapshot {
  totals: Record<RejectionReason, number>;
  ratePerMinute: Record<RejectionReason, number>;
  buckets: Array<{ startedAt: string; counts: Record<RejectionReason, number> }>;
  thresholdsPerMinute: Record<RejectionReason, number>;
  lastRejectionAt: Record<RejectionReason, string | null>;
  lastAlertAt: Record<RejectionReason, string | null>;
  alertActive: Record<RejectionReason, boolean>;
  alertCooldownMs: number;
  startedAt: string;
  generatedAt: string;
}

const API_BASE = '/api';

const REJECTION_REASONS: RejectionReason[] = [
  'invalid_signature',
  'missing_header',
  'validator_unavailable',
];

const REJECTION_LABELS: Record<RejectionReason, string> = {
  invalid_signature: 'Invalid signature',
  missing_header: 'Missing signature header',
  validator_unavailable: 'Validator unavailable',
};

const REJECTION_DESCRIPTIONS: Record<RejectionReason, string> = {
  invalid_signature: 'Webhook hit our endpoint with a bad HMAC — almost certainly a spoof attempt or misconfigured proxy.',
  missing_header: 'Caller never sent the X-Twilio-Signature header — bots or unsigned probes.',
  validator_unavailable: 'Our process could not verify signatures (missing TWILIO_AUTH_TOKEN or SDK). Real Twilio traffic is being rejected.',
};

const REJECTION_ICONS: Record<RejectionReason, typeof Shield> = {
  invalid_signature: ShieldAlert,
  missing_header: KeyRound,
  validator_unavailable: ServerCrash,
};

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
    case 'critical': return 'text-danger bg-danger/10';
    case 'high': return 'text-warning bg-warning/10';
    case 'medium': return 'text-warning bg-warning/10';
    default: return 'text-info bg-info/10';
  }
}

function statusColor(s: string): string {
  switch (s) {
    case 'pending': return 'text-warning bg-warning/10';
    case 'assigned':
    case 'in_progress': return 'text-info bg-info/10';
    case 'completed': return 'text-success bg-success/10';
    case 'dismissed': return 'text-text-muted bg-muted/10';
    default: return 'text-text-muted bg-muted/10';
  }
}

function successRateColor(rate: number): string {
  if (rate >= 99) return 'text-success';
  if (rate >= 95) return 'text-warning';
  return 'text-danger';
}

export default function ToolHealth() {
  const { user } = useAuth();
  const isPlatformAdmin = user?.isPlatformAdmin ?? false;

  const [window, setWindow] = useState('7d');
  const [tab, setTab] = useState<'health' | 'escalations' | 'webhookSecurity'>('health');
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [escalationTasks, setEscalationTasks] = useState<EscalationTask[]>([]);
  const [escalationStats, setEscalationStats] = useState<EscalationStats | null>(null);
  const [escalationRecipients, setEscalationRecipients] = useState<EscalationRecipient[] | null>(null);
  const [recipientsError, setRecipientsError] = useState<string | null>(null);
  const [webhookSecurity, setWebhookSecurity] = useState<WebhookSecuritySnapshot | null>(null);
  const [webhookSecurityError, setWebhookSecurityError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  // Iron-out from console redesign audit (2026-05-24): the outer fetchData
  // try/catch used to swallow every error silently — when the health tab's
  // /tool-health/metrics call failed (or the escalations Promise.all rejected)
  // the page rendered blank with no banner, no retry, no console trace. Now
  // we capture the failure here and surface it as a banner above the tab
  // content. Per-action errors (handleUpdateTask) go to a separate slot so
  // the broader fetch banner doesn't get clobbered by a task-update failure.
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      if (tab === 'health') {
        const data = await apiFetch(`/tool-health/metrics?window=${window}`);
        setHealthData(data);
      } else if (tab === 'escalations') {
        const [tasksRes, statsRes] = await Promise.all([
          apiFetch('/escalation-tasks?limit=50'),
          apiFetch('/escalation-tasks/stats'),
        ]);
        setEscalationTasks(tasksRes.tasks);
        setEscalationStats(statsRes);
        try {
          const recipientsRes = await apiFetch('/escalation-tasks/recipients');
          setEscalationRecipients(recipientsRes.recipients ?? []);
          setRecipientsError(null);
        } catch (err) {
          setEscalationRecipients(null);
          setRecipientsError(err instanceof Error ? err.message : 'Failed to load on-call roster');
        }
      } else if (tab === 'webhookSecurity') {
        try {
          const data = await apiFetch('/observability/twilio-webhook-security');
          setWebhookSecurity(data);
          setWebhookSecurityError(null);
        } catch (err) {
          setWebhookSecurity(null);
          setWebhookSecurityError(err instanceof Error ? err.message : 'Failed to load');
        }
      }
    } catch (err) {
      // P0/6 from console redesign audit (2026-05-24): this used to be
      // `catch {}` — silent. Now surface to the user via the banner rendered
      // below PageHeader. The Refresh button in the page header re-runs
      // fetchData, which clears `fetchError` on entry.
      const message = err instanceof Error ? err.message : 'Failed to load tool health data';
      setFetchError(message);
      // Best-effort console trace so an operator with DevTools open can see
      // the full stack rather than just the prose message.
      console.error('[ToolHealth] fetchData failed', err);
    } finally {
      setLoading(false);
    }
  }, [window, tab]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (tab !== 'webhookSecurity') return;
    const t = setInterval(fetchData, 15000);
    return () => clearInterval(t);
  }, [tab, fetchData]);

  const handleUpdateTask = async (taskId: string, status: string) => {
    setActionError(null);
    try {
      await apiFetch(`/escalation-tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      fetchData();
    } catch (err) {
      // P0/6 audit follow-up: the previous `catch {}` here made
      // "mark resolved" buttons feel like dead clicks on failure. Now we
      // surface an inline error and trace to the console.
      const message = err instanceof Error ? err.message : 'Failed to update task';
      setActionError(`Couldn't update task ${taskId}: ${message}`);
      console.error('[ToolHealth] handleUpdateTask failed', { taskId, status, err });
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <PageHeader
        icon={<Shield className="w-5 h-5" />}
        title="Platform Reliability"
        description="Tool health monitoring, failure tracking, and escalation management"
        actions={
          <button
            onClick={fetchData}
            className="inline-flex items-center gap-2 px-3 py-2 bg-surface border border-border rounded-lg hover:bg-surface-hover transition-colors text-sm font-medium text-text-primary"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        }
      />

      {/*
        Failure banner. P0/6 from console redesign audit: previously a fetch
        error left the page blank with no banner / retry / trace. Now the
        outer fetchData catch sets `fetchError` and we render this slot above
        the tab content. The page-header Refresh button is the retry — it
        clears the error on the next fetchData entry.
      */}
      {fetchError && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 p-4 text-sm text-danger"
        >
          <ShieldAlert className="w-5 h-5 mt-0.5 shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <div className="font-medium">Couldn't load reliability data</div>
            <div className="mt-0.5 text-danger/80 break-words">{fetchError}</div>
          </div>
          <button
            onClick={fetchData}
            className="shrink-0 px-2.5 py-1 rounded-md border border-danger/40 hover:bg-danger/20 text-xs font-medium transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Per-action error (handleUpdateTask). Dismissible. */}
      {actionError && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning"
        >
          <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0 break-words">{actionError}</div>
          <button
            onClick={() => setActionError(null)}
            className="shrink-0 px-2 py-0.5 rounded-md hover:bg-warning/20 text-xs font-medium transition-colors"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => setTab('health')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === 'health' ? 'bg-primary text-white' : 'bg-surface border border-border text-text-muted hover:text-text-primary'}`}
        >
          <Activity className="w-4 h-4 inline mr-1.5" />
          Tool Health
        </button>
        <button
          onClick={() => setTab('escalations')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === 'escalations' ? 'bg-primary text-white' : 'bg-surface border border-border text-text-muted hover:text-text-primary'}`}
        >
          <Users className="w-4 h-4 inline mr-1.5" />
          Escalation Queue
        </button>
        {isPlatformAdmin && (
          <button
            onClick={() => setTab('webhookSecurity')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === 'webhookSecurity' ? 'bg-primary text-white' : 'bg-surface border border-border text-text-muted hover:text-text-primary'}`}
          >
            <ShieldAlert className="w-4 h-4 inline mr-1.5" />
            Webhook Security
            {webhookSecurity && Object.values(webhookSecurity.alertActive).some(Boolean) && (
              <span className="ml-2 inline-flex items-center justify-center w-2 h-2 rounded-full bg-danger animate-pulse" />
            )}
          </button>
        )}
      </div>

      {tab === 'health' && (
        <>
          <div className="flex gap-2">
            {['24h', '7d', '30d'].map((w) => (
              <button
                key={w}
                onClick={() => setWindow(w)}
                className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${window === w ? 'bg-primary text-white' : 'bg-surface border border-border text-text-muted hover:text-text-primary'}`}
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
              <div
                className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
                data-testid="reliability-kpis"
              >
                <div className="bg-surface border border-border rounded-xl p-4">
                  <div className="flex items-center gap-2 text-text-muted text-sm mb-1">
                    <Wrench className="w-4 h-4" />
                    Total Executions
                  </div>
                  <div className="text-2xl font-bold text-text-primary">{healthData.totalExecutions.toLocaleString()}</div>
                </div>
                <div className="bg-surface border border-border rounded-xl p-4">
                  <div className="flex items-center gap-2 text-text-muted text-sm mb-1">
                    <CheckCircle className="w-4 h-4 text-success" />
                    Tool Success Rate
                  </div>
                  <div className={`text-2xl font-bold ${successRateColor(healthData.overallSuccessRate)}`}>
                    {healthData.overallSuccessRate}%
                  </div>
                </div>
                <div className="bg-surface border border-border rounded-xl p-4">
                  <div className="flex items-center gap-2 text-text-muted text-sm mb-1">
                    <XCircle className="w-4 h-4 text-danger" />
                    Total Failures
                  </div>
                  <div className="text-2xl font-bold text-text-primary">{healthData.totalFailures.toLocaleString()}</div>
                </div>
                <div className="bg-surface border border-border rounded-xl p-4">
                  <div className="flex items-center gap-2 text-text-muted text-sm mb-1">
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
                  <h2 className="text-lg font-semibold text-text-primary">Per-Tool Health</h2>
                </div>
                {healthData.tools.length === 0 ? (
                  <div className="p-8 text-center text-text-muted">
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
                            <div className={`w-2 h-2 rounded-full ${tool.successRate >= 99 ? 'bg-success' : tool.successRate >= 95 ? 'bg-warning' : 'bg-danger'}`} />
                            <span className="font-mono text-sm text-text-primary">{tool.toolName}</span>
                          </div>
                          <div className="flex items-center gap-6 text-sm">
                            <div className="text-right">
                              <span className="text-text-muted mr-1">Executions:</span>
                              <span className="font-medium text-text-primary">{tool.totalExecutions}</span>
                            </div>
                            <div className="text-right">
                              <span className="text-text-muted mr-1">Success:</span>
                              <span className={`font-medium ${successRateColor(tool.successRate)}`}>{tool.successRate}%</span>
                            </div>
                            <div className="text-right">
                              <span className="text-text-muted mr-1">Retries:</span>
                              <span className="font-medium text-text-primary">{tool.retryCount}</span>
                            </div>
                            <div className="text-right">
                              <span className="text-text-muted mr-1">Avg:</span>
                              <span className="font-medium text-text-primary">{formatDuration(tool.avgDurationMs)}</span>
                            </div>
                            {expandedTool === tool.toolName ? <ChevronUp className="w-4 h-4 text-text-muted" /> : <ChevronDown className="w-4 h-4 text-text-muted" />}
                          </div>
                        </button>

                        {expandedTool === tool.toolName && tool.recentFailures.length > 0 && (
                          <div className="px-4 pb-3 bg-surface-hover/50">
                            <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2 pt-2">Recent Failures</h4>
                            <div className="space-y-2">
                              {tool.recentFailures.map((f) => (
                                <div key={f.id} className="bg-surface border border-border rounded-lg p-3 text-sm">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2 mb-1">
                                        <AlertTriangle className="w-3.5 h-3.5 text-danger shrink-0" />
                                        <span className="text-text-primary font-medium truncate">{f.error.substring(0, 100)}</span>
                                      </div>
                                      <div className="flex items-center gap-3 text-xs text-text-muted">
                                        <span>Session: {f.callSessionId.substring(0, 8)}…</span>
                                        <span>Retries: {f.retryCount}</span>
                                        {f.fallbackAttempted && (
                                          <span className={f.fallbackSuccess ? 'text-success' : 'text-danger'}>
                                            Fallback: {f.fallbackSuccess ? 'OK' : 'Failed'}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    <span className="text-xs text-text-muted whitespace-nowrap">
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
                            <p className="text-sm text-text-muted py-2 flex items-center gap-2">
                              <CheckCircle className="w-4 h-4 text-success" />
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

      {tab === 'webhookSecurity' && isPlatformAdmin && (
        <WebhookSecuritySection
          loading={loading}
          data={webhookSecurity}
          error={webhookSecurityError}
          onRefresh={fetchData}
        />
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
                <div className="text-text-muted text-sm mb-1">Total Tasks</div>
                <div className="text-2xl font-bold text-text-primary">{escalationStats.total}</div>
              </div>
              <div className="bg-surface border border-border rounded-xl p-4">
                <div className="text-text-muted text-sm mb-1 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 text-warning" /> Pending
                </div>
                <div className="text-2xl font-bold text-warning">{escalationStats.pending}</div>
              </div>
              <div className="bg-surface border border-border rounded-xl p-4">
                <div className="text-text-muted text-sm mb-1 flex items-center gap-1">
                  <ArrowUpRight className="w-3.5 h-3.5 text-info" /> In Progress
                </div>
                <div className="text-2xl font-bold text-info">{escalationStats.inProgress}</div>
              </div>
              <div className="bg-surface border border-border rounded-xl p-4">
                <div className="text-text-muted text-sm mb-1 flex items-center gap-1">
                  <CheckCircle className="w-3.5 h-3.5 text-success" /> Completed
                </div>
                <div className="text-2xl font-bold text-success">{escalationStats.completed}</div>
              </div>
            </div>
          )}

          <OnCallRosterPanel recipients={escalationRecipients} error={recipientsError} loading={loading} />

          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <div className="p-4 border-b border-border">
              <h2 className="text-lg font-semibold text-text-primary">Escalation Queue</h2>
            </div>
            {escalationTasks.length === 0 ? (
              <div className="p-8 text-center text-text-muted">
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
                            <span className="text-xs font-mono text-text-muted bg-muted/10 px-1.5 py-0.5 rounded">
                              {task.toolName}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-text-primary">{task.reason}</p>
                        <div className="flex items-center gap-3 mt-1 text-xs text-text-muted">
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
                              className="px-2.5 py-1 text-xs bg-info/10 text-info rounded-md hover:bg-info/20 transition-colors"
                            >
                              Start
                            </button>
                            <button
                              onClick={() => handleUpdateTask(task.id, 'dismissed')}
                              className="px-2.5 py-1 text-xs bg-muted/10 text-text-muted rounded-md hover:bg-muted/20 transition-colors"
                            >
                              Dismiss
                            </button>
                          </>
                        )}
                        {(task.status === 'assigned' || task.status === 'in_progress') && (
                          <button
                            onClick={() => handleUpdateTask(task.id, 'completed')}
                            className="px-2.5 py-1 text-xs bg-success/10 text-success rounded-md hover:bg-success/20 transition-colors"
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

function formatRelativeFromNow(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function OnCallRosterPanel({
  recipients,
  error,
  loading,
}: {
  recipients: EscalationRecipient[] | null;
  error: string | null;
  loading: boolean;
}) {
  if (loading && recipients === null && !error) {
    return (
      <div className="bg-surface border border-border rounded-xl p-4">
        <div className="h-5 w-40 bg-border/40 rounded animate-pulse mb-3" />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 bg-border/30 rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-surface border border-border rounded-xl p-4">
        <div className="flex items-center gap-2 text-sm text-text-primary">
          <Users className="w-4 h-4 text-text-muted" />
          <span className="font-semibold">On-call roster</span>
        </div>
        <p className="text-sm text-text-muted mt-2">Could not load on-call roster: {error}</p>
      </div>
    );
  }

  const list = recipients ?? [];
  const reachable = list.filter((r) => !r.optedOut).length;
  const optedOut = list.length - reachable;

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-primary" />
            <h2 className="text-lg font-semibold text-text-primary">On-call roster</h2>
          </div>
          <p className="text-xs text-text-muted mt-1">
            Tenant admins and owners who are paged when an escalation fires. Toggles reflect each
            teammate&apos;s current escalation notification preferences.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="px-2 py-1 rounded-md bg-success/10 text-success font-medium">
            {reachable} reachable
          </span>
          {optedOut > 0 && (
            <span className="px-2 py-1 rounded-md bg-danger/10 text-danger font-medium flex items-center gap-1">
              <BellOff className="w-3 h-3" />
              {optedOut} silenced
            </span>
          )}
        </div>
      </div>

      {list.length === 0 ? (
        <div className="p-6 text-center text-text-muted">
          <UserX className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No tenant admin or owner accounts found.</p>
          <p className="text-xs mt-1">Invite at least one admin so escalations have a human to reach.</p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((r) => {
            const inApp = r.prefs.inApp;
            const email = r.prefs.email;
            const fullySilenced = r.optedOut;
            const partiallySilenced = !fullySilenced && (!inApp || !email);

            return (
              <li
                key={r.id}
                className={`px-4 py-3 flex items-center justify-between gap-3 ${
                  fullySilenced ? 'bg-danger/5' : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-text-primary truncate">
                      {r.name ?? r.email}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted/15 text-text-muted">
                      {r.role}
                    </span>
                    {fullySilenced && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-danger/15 text-danger font-semibold flex items-center gap-1">
                        <BellOff className="w-3 h-3" />
                        Will not be paged
                      </span>
                    )}
                    {partiallySilenced && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-warning/15 text-warning font-medium flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        Partial coverage
                      </span>
                    )}
                  </div>
                  {r.name && <div className="text-xs text-text-muted truncate">{r.email}</div>}
                </div>

                <div className="flex items-center gap-2 shrink-0 text-xs">
                  <span
                    className={`flex items-center gap-1 px-2 py-1 rounded-md ${
                      inApp ? 'bg-success/10 text-success' : 'bg-muted/10 text-text-muted line-through'
                    }`}
                    title={inApp ? 'In-app escalation alerts on' : 'In-app escalation alerts muted'}
                  >
                    {inApp ? <BellRing className="w-3 h-3" /> : <BellOff className="w-3 h-3" />}
                    In-app
                  </span>
                  <span
                    className={`flex items-center gap-1 px-2 py-1 rounded-md ${
                      email ? 'bg-success/10 text-success' : 'bg-muted/10 text-text-muted line-through'
                    }`}
                    title={email ? 'Email escalation alerts on' : 'Email escalation alerts muted'}
                  >
                    {email ? <Mail className="w-3 h-3" /> : <MailX className="w-3 h-3" />}
                    Email
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function WebhookSecuritySection({
  loading,
  data,
  error,
  onRefresh,
}: {
  loading: boolean;
  data: WebhookSecuritySnapshot | null;
  error: string | null;
  onRefresh: () => void;
}) {
  if (loading && !data) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-40 bg-surface border border-border rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center">
        <ServerCrash className="w-8 h-8 text-text-muted mx-auto mb-3" />
        <p className="text-text-primary font-medium">Could not load webhook security metrics</p>
        <p className="text-sm text-text-muted mt-1">{error ?? 'Unknown error'}</p>
        <button
          onClick={onRefresh}
          className="mt-4 px-3 py-1.5 text-xs bg-primary text-white rounded-md hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  const anyAlertActive = Object.values(data.alertActive).some(Boolean);
  const cooldownMinutes = Math.round(data.alertCooldownMs / 60_000);

  return (
    <>
      {anyAlertActive && (
        <div className="bg-danger/10 border border-danger/40 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-danger shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-danger">Webhook spoofing alert is firing</p>
            <p className="text-xs text-text-muted mt-1">
              One or more rejection counters crossed their per-minute threshold within the last {cooldownMinutes} minutes.
              A critical entry has been written to error logs. Investigate the source IPs and check Twilio configuration.
            </p>
            <ul className="mt-2 space-y-0.5 text-xs">
              {REJECTION_REASONS.filter((r) => data.alertActive[r]).map((r) => (
                <li key={r} className="text-text-primary">
                  <span className="font-mono">{r}</span> · last fired {formatRelativeFromNow(data.lastAlertAt[r])}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {REJECTION_REASONS.map((reason) => {
          const Icon = REJECTION_ICONS[reason];
          const total = data.totals[reason];
          const rate = data.ratePerMinute[reason];
          const threshold = data.thresholdsPerMinute[reason];
          const breached = data.alertActive[reason];
          const reasonBuckets = data.buckets.map((b) => ({ count: b.counts[reason] }));

          return (
            <div
              key={reason}
              className={`bg-surface border rounded-xl p-4 ${breached ? 'border-danger/60' : 'border-border'}`}
            >
              <div className="flex items-start justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <div className={`p-1.5 rounded-lg ${breached ? 'bg-danger/15 text-danger' : 'bg-muted/10 text-text-muted'}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <span className="text-sm font-semibold text-text-primary">{REJECTION_LABELS[reason]}</span>
                </div>
                {breached && (
                  <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-danger/15 text-danger">
                    Alert
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-text-muted">Last 1m</div>
                  <div className={`text-2xl font-bold ${rate >= threshold ? 'text-danger' : 'text-text-primary'}`}>
                    {rate}
                    <span className="text-xs font-normal text-text-muted ml-1">/ {threshold}</span>
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-text-muted">Total since boot</div>
                  <div className="text-2xl font-bold text-text-primary">{total.toLocaleString()}</div>
                </div>
              </div>

              <Sparkline values={reasonBuckets.map((b) => b.count)} highlight={breached} />

              <p className="text-[11px] text-text-muted mt-2 leading-snug">{REJECTION_DESCRIPTIONS[reason]}</p>
              <p className="text-[10px] text-text-muted mt-1">
                Last rejection: {formatRelativeFromNow(data.lastRejectionAt[reason])}
              </p>
            </div>
          );
        })}
      </div>

      <div className="bg-surface border border-border rounded-xl p-4 text-xs text-text-muted">
        <div className="flex items-center justify-between">
          <span>
            Rejection counters are in-process and reset on restart. Process started{' '}
            {formatRelativeFromNow(data.startedAt)} · last refreshed {formatRelativeFromNow(data.generatedAt)}.
          </span>
          <button
            onClick={onRefresh}
            className="px-2.5 py-1 bg-surface-hover border border-border rounded-md hover:bg-surface text-text-primary"
          >
            <RefreshCw className="w-3 h-3 inline mr-1" /> Refresh
          </button>
        </div>
        <p className="mt-2">
          When per-minute rejections cross their threshold, a critical entry is written to error logs (errorCode{' '}
          <span className="font-mono">twilio_signature_*_spike</span>) at most once per {cooldownMinutes}-minute cooldown.
        </p>
      </div>
    </>
  );
}

function Sparkline({ values, highlight }: { values: number[]; highlight: boolean }) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex items-end gap-px h-10 w-full">
      {values.slice(-60).map((v, i) => (
        <div
          key={i}
          className={`flex-1 rounded-t min-h-[1px] ${highlight ? 'bg-danger/60' : 'bg-primary/40'}`}
          style={{ height: `${(v / max) * 100}%` }}
          title={`${v}`}
        />
      ))}
    </div>
  );
}
