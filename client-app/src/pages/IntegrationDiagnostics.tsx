import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  Plug2, RefreshCw, CheckCircle2, XCircle, AlertCircle,
  Clock, RotateCcw, ChevronDown, ChevronRight, Loader2, Activity, Inbox,
} from 'lucide-react';
import { PageHeader } from '../components/ui';

interface WebhookDelivery {
  id: string;
  event_type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  payload: Record<string, unknown>;
  integration_name: string | null;
  integration_provider: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
  next_attempt_at: string | null;
}

interface IntegrationHealth {
  integration_id: string;
  name: string;
  provider: string;
  integration_type: string;
  is_enabled: boolean;
  total_events: number;
  successful_events: number;
  failed_events: number;
  avg_latency_ms: number;
  error_rate: number;
  last_event_at: string | null;
}

interface ConnectorDispatch {
  id: string;
  eventType: string;
  serviceName: string;
  connectorType: string | null;
  provider: string | null;
  status: 'success' | 'error';
  responseStatus: number | null;
  errorMessage: string | null;
  latencyMs: number | null;
  callSessionId: string | null;
  createdAt: string;
}

interface OutboxSummary {
  pending: number;
  processing: number;
  failed: number;
  dead_letter: number;
  delivered_24h: number;
  oldest_unresolved_at: string | null;
}

interface OutboxProviderRow {
  provider: string;
  integration_name: string;
  failed: number;
  dead_letter: number;
  pending: number;
  last_failure_at: string | null;
}

type SparklineSeries = Record<string, Array<{ bucket: string; count: number }>>;

interface DiagnosticsData {
  webhooks: WebhookDelivery[];
  health: IntegrationHealth[];
  connectorDispatches?: ConnectorDispatch[];
  dispatchProviders?: string[];
  outboxSummary?: OutboxSummary;
  outboxSparklines?: SparklineSeries;
  outboxProviderBreakdown?: OutboxProviderRow[];
  outboxProviders?: string[];
}

const AUTH_ERROR_REGEX = /\b(401|403|unauthorized|forbidden|invalid[_ -]?(grant|token|credential|auth)|expired|refresh.*(failed|token)|token.*expired|auth(entication)?[ _-]?(failed|error)|missing.*(token|credential)|not_authed|token_revoked|account_inactive)\b/i;

function isAuthError(message: string | null | undefined): boolean {
  if (!message) return false;
  return AUTH_ERROR_REGEX.test(message);
}

function formatProviderLabel(provider: string): string {
  return provider
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'delivered':
    case 'sent':
      return <CheckCircle2 className="h-4 w-4 text-success" />;
    case 'failed':
    case 'dead_letter':
      return <XCircle className="h-4 w-4 text-danger" />;
    case 'pending':
    case 'processing':
      return <Clock className="h-4 w-4 text-warning" />;
    default:
      return <AlertCircle className="h-4 w-4 text-text-muted" />;
  }
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    delivered: 'bg-success-light text-success',
    sent: 'bg-success-light text-success',
    pending: 'bg-warning-light text-warning',
    processing: 'bg-info-light text-info',
    failed: 'bg-danger-light text-danger',
    dead_letter: 'bg-danger-light text-danger',
  };

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-surface-hover text-text-secondary'}`}>
      <StatusIcon status={status} />
      {status === 'dead_letter' ? 'Dead Letter' : status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function HealthIndicator({ rate }: { rate: number }) {
  if (rate <= 5) return <span className="flex h-2.5 w-2.5 rounded-full bg-success" title="Healthy" />;
  if (rate <= 20) return <span className="flex h-2.5 w-2.5 rounded-full bg-warning" title="Degraded" />;
  return <span className="flex h-2.5 w-2.5 rounded-full bg-danger" title="Unhealthy" />;
}

// Bin a series of (bucket -> count) points returned from the API into a
// fixed 24-slot vector keyed by hour-offset. The API only returns hours that
// have data, so we synthesize zero-count entries for gaps so the sparkline
// always renders 24 hours wide regardless of activity volume.
function buildHourBuckets(
  series: Array<{ bucket: string; count: number }> | undefined,
): number[] {
  const slots = new Array<number>(24).fill(0);
  if (!series || series.length === 0) return slots;
  const now = Date.now();
  for (const point of series) {
    const t = new Date(point.bucket).getTime();
    if (Number.isNaN(t)) continue;
    const hoursAgo = Math.floor((now - t) / (60 * 60 * 1000));
    const idx = 23 - hoursAgo;
    if (idx >= 0 && idx < 24) slots[idx] += point.count;
  }
  return slots;
}

function Sparkline({
  values,
  colorClass,
  ariaLabel,
}: {
  values: number[];
  colorClass: string;
  ariaLabel: string;
}) {
  const max = Math.max(1, ...values);
  const width = 96;
  const height = 28;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = (i * stepX).toFixed(2);
      const y = (height - (v / max) * (height - 2) - 1).toFixed(2);
      return `${x},${y}`;
    })
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-label={ariaLabel}
      role="img"
      className={`overflow-visible ${colorClass}`}
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
      />
    </svg>
  );
}

function formatRelativeAge(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diffMs = Date.now() - t;
  if (diffMs < 0) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function OutboxStatCard({
  label,
  value,
  hint,
  series,
  tone,
}: {
  label: string;
  value: number;
  hint?: string;
  series: Array<{ bucket: string; count: number }> | undefined;
  tone: 'pending' | 'processing' | 'failed' | 'dead_letter' | 'delivered';
}) {
  const buckets = useMemo(() => buildHourBuckets(series), [series]);
  const TONES: Record<typeof tone, { value: string; spark: string }> = {
    pending: { value: 'text-warning', spark: 'text-warning' },
    processing: { value: 'text-info', spark: 'text-info' },
    failed: { value: 'text-danger', spark: 'text-danger' },
    dead_letter: { value: 'text-danger', spark: 'text-danger' },
    delivered: { value: 'text-success', spark: 'text-success' },
  };
  return (
    <div className="bg-surface border border-border rounded-xl p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-text-muted">{label}</p>
        <span title="Hourly activity for this status over the last 24 hours (event volume per hour, not historical queue depth).">
          <Sparkline
            values={buckets}
            colorClass={TONES[tone].spark}
            ariaLabel={`${label} hourly activity over the last 24 hours`}
          />
        </span>
      </div>
      <p className={`text-2xl font-semibold tabular-nums ${TONES[tone].value}`}>
        {value.toLocaleString()}
      </p>
      {hint && <p className="text-xs text-text-muted">{hint}</p>}
    </div>
  );
}

function WebhookRow({ webhook, onRetry, retrying }: {
  webhook: WebhookDelivery;
  onRetry: (id: string) => void;
  retrying: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const canRetry = ['failed', 'dead_letter'].includes(webhook.status);

  return (
    <div className="border border-border rounded-lg bg-surface">
      <div
        className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-surface-secondary/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <button aria-label={expanded ? 'Collapse details' : 'Expand details'} aria-expanded={expanded} className="shrink-0 text-text-muted">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-5 gap-2 items-center">
          <div className="truncate">
            <p className="text-sm font-medium text-text-primary truncate">{webhook.event_type}</p>
            <p className="text-xs text-text-muted truncate">
              {webhook.integration_name ?? 'Unknown'}
              {webhook.integration_provider && (
                <span className="ml-1 text-text-muted">· {formatProviderLabel(webhook.integration_provider)}</span>
              )}
            </p>
          </div>
          <div>
            <StatusBadge status={webhook.status} />
          </div>
          <div className="text-sm text-text-muted">
            {webhook.attempts}/{webhook.max_attempts} attempts
          </div>
          <div className="text-xs text-text-muted">
            {new Date(webhook.created_at).toLocaleString()}
          </div>
          <div className="flex justify-end">
            {canRetry && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry(webhook.id);
                }}
                disabled={retrying}
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 rounded transition-colors disabled:opacity-50"
              >
                {retrying ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                Retry
              </button>
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 border-t border-border pt-3 space-y-3">
          {webhook.last_error && (
            <div className="bg-danger-light border border-danger rounded-lg p-3">
              <p className="text-xs font-medium text-danger mb-1">Last Error</p>
              <p className="text-xs text-danger font-mono break-all">{webhook.last_error}</p>
            </div>
          )}
          <div>
            <p className="text-xs font-medium text-text-muted mb-1">Payload</p>
            <pre className="text-xs bg-surface-secondary rounded-lg p-3 overflow-x-auto max-h-48 font-mono">
              {JSON.stringify(webhook.payload, null, 2)}
            </pre>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
            <div>
              <span className="text-text-muted">ID</span>
              <p className="font-mono text-text-primary truncate">{webhook.id}</p>
            </div>
            <div>
              <span className="text-text-muted">Created</span>
              <p className="text-text-primary">{new Date(webhook.created_at).toLocaleString()}</p>
            </div>
            <div>
              <span className="text-text-muted">Delivered</span>
              <p className="text-text-primary">{webhook.delivered_at ? new Date(webhook.delivered_at).toLocaleString() : 'Not delivered'}</p>
            </div>
            <div>
              <span className="text-text-muted">Next Retry</span>
              <p className="text-text-primary">{webhook.next_attempt_at ? new Date(webhook.next_attempt_at).toLocaleString() : 'N/A'}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function IntegrationDiagnostics() {
  const { t: adminT } = useTranslation('admin');
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [outboxProviderFilter, setOutboxProviderFilter] = useState<string>('all');
  const [bulkFeedback, setBulkFeedback] = useState<
    | { kind: 'success'; message: string }
    | { kind: 'error'; message: string }
    | null
  >(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['integration-diagnostics', statusFilter, providerFilter, outboxProviderFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (providerFilter !== 'all') params.set('provider', providerFilter);
      if (outboxProviderFilter !== 'all') params.set('outboxProvider', outboxProviderFilter);
      const qs = params.toString();
      return api.get<DiagnosticsData>(
        `/operations/integration-diagnostics${qs ? `?${qs}` : ''}`,
      );
    },
    refetchInterval: 30_000,
  });

  const retryMutation = useMutation({
    mutationFn: (outboxId: string) =>
      api.post<{ success: boolean }>(`/operations/integration-diagnostics/${outboxId}/retry`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integration-diagnostics'] });
    },
  });

  const bulkRetryMutation = useMutation({
    mutationFn: (vars: { status: 'failed' | 'dead_letter' | 'all'; provider: string | null }) =>
      api.post<{ success: boolean; requeued: number }>(
        '/operations/integration-diagnostics/bulk-retry',
        { status: vars.status, provider: vars.provider ?? undefined },
      ),
    onSuccess: (resp) => {
      const count = resp?.requeued ?? 0;
      setBulkFeedback({
        kind: 'success',
        message:
          count === 0
            ? 'No matching outbox events to retry.'
            : `Requeued ${count} outbox event${count === 1 ? '' : 's'}. The drain worker will pick them up on the next cycle.`,
      });
      queryClient.invalidateQueries({ queryKey: ['integration-diagnostics'] });
    },
    onError: (err) => {
      setBulkFeedback({
        kind: 'error',
        message: (err as Error).message ?? 'Bulk retry failed.',
      });
    },
  });

  const webhooks = data?.webhooks ?? [];
  const health = data?.health ?? [];
  const connectorDispatches = data?.connectorDispatches ?? [];
  const dispatchProviders = data?.dispatchProviders ?? [];
  const outboxSummary = data?.outboxSummary;
  const outboxSparklines = data?.outboxSparklines;
  const outboxProviderBreakdown = data?.outboxProviderBreakdown ?? [];
  const outboxProviders = data?.outboxProviders ?? [];

  const bulkRetryStatus: 'failed' | 'dead_letter' | 'all' =
    statusFilter === 'failed' || statusFilter === 'dead_letter' ? statusFilter : 'all';
  const bulkRetryEligible = (() => {
    if (!outboxSummary) return 0;
    if (bulkRetryStatus === 'failed') return outboxSummary.failed;
    if (bulkRetryStatus === 'dead_letter') return outboxSummary.dead_letter;
    return outboxSummary.failed + outboxSummary.dead_letter;
  })();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integration Diagnostics"
        description="Monitor webhook deliveries, API health, and retry failed integrations."
        icon={<Plug2 className="h-5 w-5" />}
        actions={
          <button
            onClick={() => queryClient.invalidateQueries({ queryKey: ['integration-diagnostics'] })}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        }
      />

      <div className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-5 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
              <Inbox className="h-4 w-4 text-success" />
              Outbox Health
            </h2>
            <p className="text-xs text-text-muted mt-1">
              Live counts and 24h trend for the integrations outbox. Filter by provider to focus on a single connector.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-text-muted">Provider</label>
            <select
              value={outboxProviderFilter}
              onChange={(e) => setOutboxProviderFilter(e.target.value)}
              className="text-xs border border-border rounded-lg px-2 py-1.5 bg-surface focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="all">All providers</option>
              {outboxProviders.map((p) => (
                <option key={p} value={p}>{formatProviderLabel(p)}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <OutboxStatCard
            label="Pending"
            value={outboxSummary?.pending ?? 0}
            hint={
              outboxSummary?.oldest_unresolved_at
                ? `Oldest unresolved row: ${formatRelativeAge(outboxSummary.oldest_unresolved_at)} ago`
                : 'Nothing waiting in the queue'
            }
            series={outboxSparklines?.pending}
            tone="pending"
          />
          <OutboxStatCard
            label="Processing"
            value={outboxSummary?.processing ?? 0}
            hint="Currently leased by the drain worker"
            series={outboxSparklines?.processing}
            tone="processing"
          />
          <OutboxStatCard
            label="Failed"
            value={outboxSummary?.failed ?? 0}
            hint="Will auto-retry with backoff"
            series={outboxSparklines?.failed}
            tone="failed"
          />
          <OutboxStatCard
            label="Dead letter"
            value={outboxSummary?.dead_letter ?? 0}
            hint="Hit max attempts — manual retry required"
            series={outboxSparklines?.dead_letter}
            tone="dead_letter"
          />
          <OutboxStatCard
            label="Delivered (24h)"
            value={outboxSummary?.delivered_24h ?? 0}
            hint="Successful deliveries in the last 24h"
            series={outboxSparklines?.delivered}
            tone="delivered"
          />
        </div>
        {outboxProviderBreakdown.length > 0 && (
          <div className="border-t border-border">
            <div className="px-5 py-3 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted flex items-center gap-2">
                <Activity className="h-3.5 w-3.5" />
                Stuck rows by provider
              </h3>
              <span className="text-[11px] text-text-muted normal-case font-normal">
                Always shows every provider so you can compare — not affected by the provider filter above.
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="px-5 py-2 font-medium text-text-muted">Provider</th>
                    <th className="px-5 py-2 font-medium text-text-muted">Integration</th>
                    <th className="px-5 py-2 font-medium text-text-muted text-right">Pending</th>
                    <th className="px-5 py-2 font-medium text-text-muted text-right">Failed</th>
                    <th className="px-5 py-2 font-medium text-text-muted text-right">Dead Letter</th>
                    <th className="px-5 py-2 font-medium text-text-muted text-right">Last Failure</th>
                    <th className="px-5 py-2 font-medium text-text-muted text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {outboxProviderBreakdown.map((row) => {
                    const retryable = row.failed + row.dead_letter;
                    // 'unknown' is a synthetic placeholder for rows with no
                    // integration_provider — bulk retry can't scope to it.
                    const syntheticProvider = row.provider === 'unknown';
                    const buttonDisabled =
                      retryable === 0 || syntheticProvider || bulkRetryMutation.isPending;
                    return (
                      <tr key={`${row.provider}-${row.integration_name}`} className="hover:bg-surface-secondary/50 transition-colors">
                        <td className="px-5 py-2 text-text-primary">{formatProviderLabel(row.provider)}</td>
                        <td className="px-5 py-2 text-text-muted">{row.integration_name}</td>
                        <td className="px-5 py-2 text-right font-mono text-warning">{row.pending}</td>
                        <td className="px-5 py-2 text-right font-mono text-danger">{row.failed}</td>
                        <td className="px-5 py-2 text-right font-mono text-danger">{row.dead_letter}</td>
                        <td className="px-5 py-2 text-right text-xs text-text-muted">
                          {row.last_failure_at ? formatRelativeAge(row.last_failure_at) + ' ago' : '—'}
                        </td>
                        <td className="px-5 py-2 text-right">
                          <button
                            disabled={buttonDisabled}
                            onClick={() => {
                              if (syntheticProvider) return;
                              setBulkFeedback(null);
                              bulkRetryMutation.mutate({ status: 'all', provider: row.provider });
                            }}
                            title={
                              syntheticProvider
                                ? 'These rows are not tied to a known provider — open them individually to retry.'
                                : retryable === 0
                                  ? 'Nothing to retry'
                                  : `Requeue ${retryable} stuck row${retryable === 1 ? '' : 's'} for ${formatProviderLabel(row.provider)}`
                            }
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <RotateCcw className="h-3 w-3" />
                            Retry {retryable > 0 && !syntheticProvider ? retryable : ''}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {health.length > 0 && (
        <div className="bg-surface border border-border rounded-xl shadow-sm">
          <div className="px-5 py-4 border-b border-border">
            <h2 className="text-base font-semibold text-text-primary">Integration Health</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-5 py-3 font-medium text-text-muted">Status</th>
                  <th className="px-5 py-3 font-medium text-text-muted">Integration</th>
                  <th className="px-5 py-3 font-medium text-text-muted">Provider</th>
                  <th className="px-5 py-3 font-medium text-text-muted">Type</th>
                  <th className="px-5 py-3 font-medium text-text-muted text-right">Total</th>
                  <th className="px-5 py-3 font-medium text-text-muted text-right">Success</th>
                  <th className="px-5 py-3 font-medium text-text-muted text-right">Failed</th>
                  <th className="px-5 py-3 font-medium text-text-muted text-right">Error Rate</th>
                  <th className="px-5 py-3 font-medium text-text-muted text-right">Avg Latency</th>
                  <th className="px-5 py-3 font-medium text-text-muted">Last Event</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {health.map((h) => (
                  <tr key={h.integration_id} className="hover:bg-surface-secondary/50 transition-colors">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <HealthIndicator rate={h.error_rate} />
                        <span className={`text-xs ${h.is_enabled ? 'text-success' : 'text-danger'}`}>
                          {h.is_enabled ? 'Active' : 'Disabled'}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 font-medium text-text-primary">{h.name}</td>
                    <td className="px-5 py-3 text-text-muted">{h.provider}</td>
                    <td className="px-5 py-3">
                      <span className="px-2 py-0.5 rounded-full text-xs bg-surface-secondary text-text-muted">
                        {h.integration_type}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right font-mono">{h.total_events}</td>
                    <td className="px-5 py-3 text-right font-mono text-success">{h.successful_events}</td>
                    <td className="px-5 py-3 text-right font-mono text-danger">{h.failed_events}</td>
                    <td className="px-5 py-3 text-right font-mono">
                      <span className={h.error_rate > 20 ? 'text-danger' : h.error_rate > 5 ? 'text-warning' : 'text-success'}>
                        {h.error_rate.toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-text-muted">{h.avg_latency_ms}ms</td>
                    <td className="px-5 py-3 text-xs text-text-muted">
                      {h.last_event_at ? new Date(h.last_event_at).toLocaleString() : 'Never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-5 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-text-primary">
              Connector Dispatches
              {connectorDispatches.length > 0 && (
                <span className="ml-2 text-xs font-normal text-text-muted">({connectorDispatches.length})</span>
              )}
            </h2>
            <p className="text-xs text-text-muted mt-1">
              Per-event sync attempts to CRM, calendar, and messaging connectors from the last 7 days.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-text-muted">Provider</label>
            <select
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value)}
              className="text-xs border border-border rounded-lg px-2 py-1.5 bg-surface focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="all">All providers</option>
              {dispatchProviders.map((p) => (
                <option key={p} value={p}>{formatProviderLabel(p)}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          {connectorDispatches.length === 0 ? (
            <div className="text-center py-10 text-sm text-text-muted">
              {providerFilter === 'all'
                ? 'No connector dispatches in the last 7 days.'
                : `No ${formatProviderLabel(providerFilter)} dispatches in the last 7 days.`}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-5 py-3 font-medium text-text-muted">Status</th>
                  <th className="px-5 py-3 font-medium text-text-muted">Provider</th>
                  <th className="px-5 py-3 font-medium text-text-muted">Event</th>
                  <th className="px-5 py-3 font-medium text-text-muted">HTTP</th>
                  <th className="px-5 py-3 font-medium text-text-muted">Error</th>
                  <th className="px-5 py-3 font-medium text-text-muted text-right">Latency</th>
                  <th className="px-5 py-3 font-medium text-text-muted">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {connectorDispatches.map((d) => {
                  const authError = d.status === 'error' && isAuthError(d.errorMessage);
                  return (
                    <tr key={d.id} className="hover:bg-surface-secondary/50 transition-colors">
                      <td className="px-5 py-3">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                            d.status === 'success'
                              ? 'bg-success-light text-success'
                              : authError
                                ? 'bg-warning-light text-warning'
                                : 'bg-danger-light text-danger'
                          }`}
                        >
                          {d.status === 'success' ? (
                            <CheckCircle2 className="h-3 w-3" />
                          ) : authError ? (
                            <AlertCircle className="h-3 w-3" />
                          ) : (
                            <XCircle className="h-3 w-3" />
                          )}
                          {d.status === 'success' ? 'Success' : authError ? 'Reconnect' : 'Failed'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-text-primary">
                        {d.provider ? formatProviderLabel(d.provider) : '—'}
                        {d.connectorType && (
                          <span className="ml-1 text-xs text-text-muted">({d.connectorType})</span>
                        )}
                      </td>
                      <td className="px-5 py-3 font-medium text-text-primary">{d.eventType}</td>
                      <td className="px-5 py-3 text-text-muted font-mono text-xs">
                        {d.responseStatus ?? '—'}
                      </td>
                      <td
                        className="px-5 py-3 text-xs text-danger max-w-[320px] truncate"
                        title={d.errorMessage ?? ''}
                      >
                        {d.errorMessage ?? '—'}
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-text-muted text-xs">
                        {d.latencyMs !== null ? `${d.latencyMs}ms` : '—'}
                      </td>
                      <td className="px-5 py-3 text-xs text-text-muted whitespace-nowrap">
                        {new Date(d.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-5 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-text-primary">
              Recent Outbox Events
              {webhooks.length > 0 && (
                <span className="ml-2 text-xs font-normal text-text-muted">({webhooks.length})</span>
              )}
            </h2>
            <p className="text-xs text-text-muted mt-1">
              Click any row to inspect the redacted payload, attempt count, last error, and next retry time.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (bulkRetryEligible === 0) return;
                const providerLabel =
                  outboxProviderFilter === 'all'
                    ? adminT('platform_admin.integration_diagnostics.bulk_retry_provider_all')
                    : adminT('platform_admin.integration_diagnostics.bulk_retry_provider_specific', {
                        provider: formatProviderLabel(outboxProviderFilter),
                      });
                const statusLabel =
                  bulkRetryStatus === 'failed'
                    ? adminT('platform_admin.integration_diagnostics.bulk_retry_status_failed')
                    : bulkRetryStatus === 'dead_letter'
                      ? adminT('platform_admin.integration_diagnostics.bulk_retry_status_dead_letter')
                      : adminT('platform_admin.integration_diagnostics.bulk_retry_status_all');
                if (
                  window.confirm(
                    adminT('platform_admin.integration_diagnostics.bulk_retry_confirm', {
                      count: bulkRetryEligible,
                      statusLabel,
                      providerLabel,
                    }),
                  )
                ) {
                  setBulkFeedback(null);
                  bulkRetryMutation.mutate({
                    status: bulkRetryStatus,
                    provider: outboxProviderFilter === 'all' ? null : outboxProviderFilter,
                  });
                }
              }}
              disabled={bulkRetryEligible === 0 || bulkRetryMutation.isPending}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-surface-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {bulkRetryMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RotateCcw className="h-3 w-3" />
              )}
              Retry {bulkRetryEligible > 0 ? `${bulkRetryEligible} ` : ''}
              {bulkRetryStatus === 'failed'
                ? 'failed'
                : bulkRetryStatus === 'dead_letter'
                  ? 'dead-letter'
                  : 'stuck'}
            </button>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="text-xs border border-border rounded-lg px-2 py-1.5 bg-surface focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="all">All Status</option>
              <option value="pending">Pending</option>
              <option value="processing">Processing</option>
              <option value="delivered">Delivered</option>
              <option value="failed">Failed</option>
              <option value="dead_letter">Dead Letter</option>
            </select>
          </div>
        </div>

        {bulkFeedback && (
          <div className="px-5 pt-3">
            <div
              className={`text-sm flex items-center gap-2 p-2 rounded ${
                bulkFeedback.kind === 'success'
                  ? 'text-success bg-success-light'
                  : 'text-danger bg-danger-light'
              }`}
            >
              {bulkFeedback.kind === 'success' ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <XCircle className="h-4 w-4" />
              )}
              {bulkFeedback.message}
            </div>
          </div>
        )}

        <div className="p-4 space-y-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
            </div>
          ) : isError ? (
            <div className="text-center py-12">
              <AlertCircle className="h-8 w-8 text-danger mx-auto mb-2" />
              <p className="text-sm text-text-muted">Failed to load diagnostics data</p>
            </div>
          ) : webhooks.length === 0 ? (
            <div className="text-center py-12" data-testid="integration-webhooks-loaded">
              <CheckCircle2 className="h-8 w-8 text-success mx-auto mb-2" />
              <p className="text-sm text-text-muted">
                {statusFilter === 'all' && outboxProviderFilter === 'all'
                  ? 'No outbox events found'
                  : `No matching outbox events found`}
              </p>
            </div>
          ) : (
            <div data-testid="integration-webhooks-loaded" className="space-y-2">
              {webhooks.map((wh) => (
                <WebhookRow
                  key={wh.id}
                  webhook={wh}
                  onRetry={(id) => retryMutation.mutate(id)}
                  retrying={retryMutation.isPending && retryMutation.variables === wh.id}
                />
              ))}
            </div>
          )}
        </div>

        {retryMutation.isError && (
          <div className="px-5 pb-4">
            <div className="text-sm text-danger bg-danger-light p-2 rounded">
              Retry failed: {(retryMutation.error as Error).message}
            </div>
          </div>
        )}

        {retryMutation.isSuccess && (
          <div className="px-5 pb-4">
            <div className="text-sm text-success bg-success-light p-2 rounded flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" /> Retry queued successfully
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
