import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  Plug2, RefreshCw, CheckCircle2, XCircle, AlertCircle,
  Clock, RotateCcw, ChevronDown, ChevronRight, Loader2,
} from 'lucide-react';

interface WebhookDelivery {
  id: string;
  event_type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  payload: Record<string, unknown>;
  integration_name: string | null;
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

interface DiagnosticsData {
  webhooks: WebhookDelivery[];
  health: IntegrationHealth[];
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'delivered':
    case 'sent':
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case 'failed':
    case 'dead_letter':
      return <XCircle className="h-4 w-4 text-red-500" />;
    case 'pending':
    case 'processing':
      return <Clock className="h-4 w-4 text-amber-500" />;
    default:
      return <AlertCircle className="h-4 w-4 text-gray-400" />;
  }
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    delivered: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    sent: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    processing: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    dead_letter: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  };

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-600'}`}>
      <StatusIcon status={status} />
      {status === 'dead_letter' ? 'Dead Letter' : status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function HealthIndicator({ rate }: { rate: number }) {
  if (rate <= 5) return <span className="flex h-2.5 w-2.5 rounded-full bg-green-500" title="Healthy" />;
  if (rate <= 20) return <span className="flex h-2.5 w-2.5 rounded-full bg-amber-500" title="Degraded" />;
  return <span className="flex h-2.5 w-2.5 rounded-full bg-red-500" title="Unhealthy" />;
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
        <button className="shrink-0 text-muted">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-5 gap-2 items-center">
          <div className="truncate">
            <p className="text-sm font-medium text-text-primary truncate">{webhook.event_type}</p>
            <p className="text-xs text-muted truncate">{webhook.integration_name ?? 'Unknown'}</p>
          </div>
          <div>
            <StatusBadge status={webhook.status} />
          </div>
          <div className="text-sm text-muted">
            {webhook.attempts}/{webhook.max_attempts} attempts
          </div>
          <div className="text-xs text-muted">
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
            <div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 rounded-lg p-3">
              <p className="text-xs font-medium text-red-700 dark:text-red-400 mb-1">Last Error</p>
              <p className="text-xs text-red-600 dark:text-red-300 font-mono break-all">{webhook.last_error}</p>
            </div>
          )}
          <div>
            <p className="text-xs font-medium text-muted mb-1">Payload</p>
            <pre className="text-xs bg-surface-secondary rounded-lg p-3 overflow-x-auto max-h-48 font-mono">
              {JSON.stringify(webhook.payload, null, 2)}
            </pre>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
            <div>
              <span className="text-muted">ID</span>
              <p className="font-mono text-text-primary truncate">{webhook.id}</p>
            </div>
            <div>
              <span className="text-muted">Created</span>
              <p className="text-text-primary">{new Date(webhook.created_at).toLocaleString()}</p>
            </div>
            <div>
              <span className="text-muted">Delivered</span>
              <p className="text-text-primary">{webhook.delivered_at ? new Date(webhook.delivered_at).toLocaleString() : 'Not delivered'}</p>
            </div>
            <div>
              <span className="text-muted">Next Retry</span>
              <p className="text-text-primary">{webhook.next_attempt_at ? new Date(webhook.next_attempt_at).toLocaleString() : 'N/A'}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function IntegrationDiagnostics() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['integration-diagnostics', statusFilter],
    queryFn: () =>
      api.get<DiagnosticsData>(
        `/operations/integration-diagnostics${statusFilter !== 'all' ? `?status=${statusFilter}` : ''}`
      ),
    refetchInterval: 30_000,
  });

  const retryMutation = useMutation({
    mutationFn: (outboxId: string) =>
      api.post<{ success: boolean }>(`/operations/integration-diagnostics/${outboxId}/retry`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integration-diagnostics'] });
    },
  });

  const webhooks = data?.webhooks ?? [];
  const health = data?.health ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
            <Plug2 className="h-6 w-6 text-emerald-500" />
            Integration Diagnostics
          </h1>
          <p className="text-sm text-muted mt-1">
            Monitor webhook deliveries, API health, and retry failed integrations
          </p>
        </div>
        <button
          onClick={() => queryClient.invalidateQueries({ queryKey: ['integration-diagnostics'] })}
          className="flex items-center gap-2 px-3 py-2 text-sm font-medium border border-border rounded-lg hover:bg-surface-secondary transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
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
                  <th className="px-5 py-3 font-medium text-muted">Status</th>
                  <th className="px-5 py-3 font-medium text-muted">Integration</th>
                  <th className="px-5 py-3 font-medium text-muted">Provider</th>
                  <th className="px-5 py-3 font-medium text-muted">Type</th>
                  <th className="px-5 py-3 font-medium text-muted text-right">Total</th>
                  <th className="px-5 py-3 font-medium text-muted text-right">Success</th>
                  <th className="px-5 py-3 font-medium text-muted text-right">Failed</th>
                  <th className="px-5 py-3 font-medium text-muted text-right">Error Rate</th>
                  <th className="px-5 py-3 font-medium text-muted text-right">Avg Latency</th>
                  <th className="px-5 py-3 font-medium text-muted">Last Event</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {health.map((h) => (
                  <tr key={h.integration_id} className="hover:bg-surface-secondary/50 transition-colors">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <HealthIndicator rate={h.error_rate} />
                        <span className={`text-xs ${h.is_enabled ? 'text-green-600' : 'text-red-500'}`}>
                          {h.is_enabled ? 'Active' : 'Disabled'}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 font-medium text-text-primary">{h.name}</td>
                    <td className="px-5 py-3 text-muted">{h.provider}</td>
                    <td className="px-5 py-3">
                      <span className="px-2 py-0.5 rounded-full text-xs bg-surface-secondary text-muted">
                        {h.integration_type}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right font-mono">{h.total_events}</td>
                    <td className="px-5 py-3 text-right font-mono text-green-600">{h.successful_events}</td>
                    <td className="px-5 py-3 text-right font-mono text-red-600">{h.failed_events}</td>
                    <td className="px-5 py-3 text-right font-mono">
                      <span className={h.error_rate > 20 ? 'text-red-600' : h.error_rate > 5 ? 'text-amber-600' : 'text-green-600'}>
                        {h.error_rate.toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-muted">{h.avg_latency_ms}ms</td>
                    <td className="px-5 py-3 text-xs text-muted">
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
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-base font-semibold text-text-primary">
            Recent Webhook Deliveries
            {webhooks.length > 0 && (
              <span className="ml-2 text-xs font-normal text-muted">({webhooks.length})</span>
            )}
          </h2>
          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="text-xs border border-border rounded-lg px-2 py-1.5 bg-surface focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="all">All Status</option>
              <option value="pending">Pending</option>
              <option value="delivered">Delivered</option>
              <option value="failed">Failed</option>
              <option value="dead_letter">Dead Letter</option>
            </select>
          </div>
        </div>

        <div className="p-4 space-y-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted" />
            </div>
          ) : isError ? (
            <div className="text-center py-12">
              <AlertCircle className="h-8 w-8 text-red-400 mx-auto mb-2" />
              <p className="text-sm text-muted">Failed to load diagnostics data</p>
            </div>
          ) : webhooks.length === 0 ? (
            <div className="text-center py-12">
              <CheckCircle2 className="h-8 w-8 text-green-400 mx-auto mb-2" />
              <p className="text-sm text-muted">
                {statusFilter === 'all'
                  ? 'No webhook deliveries found'
                  : `No ${statusFilter} deliveries found`}
              </p>
            </div>
          ) : (
            webhooks.map((wh) => (
              <WebhookRow
                key={wh.id}
                webhook={wh}
                onRetry={(id) => retryMutation.mutate(id)}
                retrying={retryMutation.isPending && retryMutation.variables === wh.id}
              />
            ))
          )}
        </div>

        {retryMutation.isError && (
          <div className="px-5 pb-4">
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded">
              Retry failed: {(retryMutation.error as Error).message}
            </div>
          </div>
        )}

        {retryMutation.isSuccess && (
          <div className="px-5 pb-4">
            <div className="text-sm text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 p-2 rounded flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" /> Retry queued successfully
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
