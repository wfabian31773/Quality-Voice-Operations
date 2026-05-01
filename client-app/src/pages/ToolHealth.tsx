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

  const fetchData = useCallback(async () => {
    setLoading(true);
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
    } catch {
      // silently handle fetch errors
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
        {isPlatformAdmin && (
          <button
            onClick={() => setTab('webhookSecurity')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === 'webhookSecurity' ? 'bg-primary text-white' : 'bg-surface border border-border text-muted hover:text-foreground'}`}
          >
            <ShieldAlert className="w-4 h-4 inline mr-1.5" />
            Webhook Security
            {webhookSecurity && Object.values(webhookSecurity.alertActive).some(Boolean) && (
              <span className="ml-2 inline-flex items-center justify-center w-2 h-2 rounded-full bg-red-500 animate-pulse" />
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
              <div
                className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
                data-testid="reliability-kpis"
              >
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

          <OnCallRosterPanel recipients={escalationRecipients} error={recipientsError} loading={loading} />

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
        <div className="flex items-center gap-2 text-sm text-foreground">
          <Users className="w-4 h-4 text-muted" />
          <span className="font-semibold">On-call roster</span>
        </div>
        <p className="text-sm text-muted mt-2">Could not load on-call roster: {error}</p>
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
            <h2 className="text-lg font-semibold text-foreground">On-call roster</h2>
          </div>
          <p className="text-xs text-muted mt-1">
            Tenant admins and owners who are paged when an escalation fires. Toggles reflect each
            teammate&apos;s current escalation notification preferences.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="px-2 py-1 rounded-md bg-green-500/10 text-green-500 font-medium">
            {reachable} reachable
          </span>
          {optedOut > 0 && (
            <span className="px-2 py-1 rounded-md bg-red-500/10 text-red-500 font-medium flex items-center gap-1">
              <BellOff className="w-3 h-3" />
              {optedOut} silenced
            </span>
          )}
        </div>
      </div>

      {list.length === 0 ? (
        <div className="p-6 text-center text-muted">
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
                  fullySilenced ? 'bg-red-500/5' : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground truncate">
                      {r.name ?? r.email}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted/15 text-muted">
                      {r.role}
                    </span>
                    {fullySilenced && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-500 font-semibold flex items-center gap-1">
                        <BellOff className="w-3 h-3" />
                        Will not be paged
                      </span>
                    )}
                    {partiallySilenced && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-500 font-medium flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        Partial coverage
                      </span>
                    )}
                  </div>
                  {r.name && <div className="text-xs text-muted truncate">{r.email}</div>}
                </div>

                <div className="flex items-center gap-2 shrink-0 text-xs">
                  <span
                    className={`flex items-center gap-1 px-2 py-1 rounded-md ${
                      inApp ? 'bg-green-500/10 text-green-500' : 'bg-muted/10 text-muted line-through'
                    }`}
                    title={inApp ? 'In-app escalation alerts on' : 'In-app escalation alerts muted'}
                  >
                    {inApp ? <BellRing className="w-3 h-3" /> : <BellOff className="w-3 h-3" />}
                    In-app
                  </span>
                  <span
                    className={`flex items-center gap-1 px-2 py-1 rounded-md ${
                      email ? 'bg-green-500/10 text-green-500' : 'bg-muted/10 text-muted line-through'
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
        <ServerCrash className="w-8 h-8 text-muted mx-auto mb-3" />
        <p className="text-foreground font-medium">Could not load webhook security metrics</p>
        <p className="text-sm text-muted mt-1">{error ?? 'Unknown error'}</p>
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
        <div className="bg-red-500/10 border border-red-500/40 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-red-500">Webhook spoofing alert is firing</p>
            <p className="text-xs text-muted mt-1">
              One or more rejection counters crossed their per-minute threshold within the last {cooldownMinutes} minutes.
              A critical entry has been written to error logs. Investigate the source IPs and check Twilio configuration.
            </p>
            <ul className="mt-2 space-y-0.5 text-xs">
              {REJECTION_REASONS.filter((r) => data.alertActive[r]).map((r) => (
                <li key={r} className="text-foreground">
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
              className={`bg-surface border rounded-xl p-4 ${breached ? 'border-red-500/60' : 'border-border'}`}
            >
              <div className="flex items-start justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <div className={`p-1.5 rounded-lg ${breached ? 'bg-red-500/15 text-red-500' : 'bg-muted/10 text-muted'}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <span className="text-sm font-semibold text-foreground">{REJECTION_LABELS[reason]}</span>
                </div>
                {breached && (
                  <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-500/15 text-red-500">
                    Alert
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted">Last 1m</div>
                  <div className={`text-2xl font-bold ${rate >= threshold ? 'text-red-500' : 'text-foreground'}`}>
                    {rate}
                    <span className="text-xs font-normal text-muted ml-1">/ {threshold}</span>
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted">Total since boot</div>
                  <div className="text-2xl font-bold text-foreground">{total.toLocaleString()}</div>
                </div>
              </div>

              <Sparkline values={reasonBuckets.map((b) => b.count)} highlight={breached} />

              <p className="text-[11px] text-muted mt-2 leading-snug">{REJECTION_DESCRIPTIONS[reason]}</p>
              <p className="text-[10px] text-muted mt-1">
                Last rejection: {formatRelativeFromNow(data.lastRejectionAt[reason])}
              </p>
            </div>
          );
        })}
      </div>

      <div className="bg-surface border border-border rounded-xl p-4 text-xs text-muted">
        <div className="flex items-center justify-between">
          <span>
            Rejection counters are in-process and reset on restart. Process started{' '}
            {formatRelativeFromNow(data.startedAt)} · last refreshed {formatRelativeFromNow(data.generatedAt)}.
          </span>
          <button
            onClick={onRefresh}
            className="px-2.5 py-1 bg-surface-hover border border-border rounded-md hover:bg-surface text-foreground"
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
          className={`flex-1 rounded-t min-h-[1px] ${highlight ? 'bg-red-500/60' : 'bg-primary/40'}`}
          style={{ height: `${(v / max) * 100}%` }}
          title={`${v}`}
        />
      ))}
    </div>
  );
}
