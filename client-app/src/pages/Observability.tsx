import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState } from 'react';
import clsx from 'clsx';

interface DailyBreakdown {
  date: string;
  calls: number;
  avgDuration: number;
  errors: number;
}

interface MetricsResponse {
  window: string;
  totalCalls: number;
  avgDurationSeconds: number;
  errorCount: number;
  errorRate: number;
  dailyBreakdown: DailyBreakdown[];
}

interface ErrorEntry {
  id: string;
  severity: string;
  service: string | null;
  message: string;
  occurredAt: string;
}

interface ErrorsResponse {
  errors: ErrorEntry[];
}

interface ToolExecution {
  id: string;
  tenantId: string;
  callSessionId: string | null;
  agentId: string | null;
  agentSlug: string | null;
  toolName: string;
  parametersRedacted: Record<string, unknown>;
  result: unknown;
  status: 'pending' | 'running' | 'success' | 'failed' | 'timeout';
  errorMessage: string | null;
  recoveryAction: string | null;
  durationMs: number | null;
  invokedAt: string;
  completedAt: string | null;
}

interface ToolExecutionsResponse {
  executions: ToolExecution[];
  total: number;
  limit: number;
  page: number;
  totalPages: number;
}

interface ToolStatsResponse {
  window: string;
  totalExecutions: number;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
  topTools: Array<{ toolName: string; count: number; avgDuration: number }>;
  dailyBreakdown: Array<{ date: string; total: number; success: number; failed: number }>;
}

interface RegistryTool {
  name: string;
  description: string;
  category: string;
  inputSchema: unknown;
  rateLimit: { maxPerMinute: number; maxPerHour: number };
  hasRecoveryInstructions: boolean;
}

interface ToolRegistryResponse {
  tools: RegistryTool[];
}

const WINDOWS = ['24h', '7d', '30d'] as const;
const TABS = ['overview', 'tool-activity', 'tool-registry'] as const;
type Tab = typeof TABS[number];

export default function Observability() {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [window, setWindow] = useState<string>('7d');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Observability</h1>
        <div className="flex gap-1 bg-muted rounded-lg p-1">
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={clsx(
                'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                window === w
                  ? 'bg-background shadow text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-1 bg-muted rounded-lg p-1 w-fit">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={clsx(
              'px-4 py-2 text-sm font-medium rounded-md transition-colors capitalize',
              activeTab === tab
                ? 'bg-background shadow text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.replace('-', ' ')}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && <OverviewTab window={window} />}
      {activeTab === 'tool-activity' && <ToolActivityTab window={window} />}
      {activeTab === 'tool-registry' && <ToolRegistryTab />}
    </div>
  );
}

function OverviewTab({ window }: { window: string }) {
  const { data: metrics, isLoading: metricsLoading } = useQuery({
    queryKey: ['observability-metrics', window],
    queryFn: () => api.get<MetricsResponse>(`/observability/metrics?window=${window}`),
    refetchInterval: 60_000,
  });

  const { data: errorsData, isLoading: errorsLoading } = useQuery({
    queryKey: ['observability-errors'],
    queryFn: () => api.get<ErrorsResponse>('/observability/errors?limit=50'),
    refetchInterval: 60_000,
  });

  const maxCalls = Math.max(1, ...(metrics?.dailyBreakdown?.map((d) => d.calls) ?? [1]));

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard label="Total Calls" value={metricsLoading ? '—' : String(metrics?.totalCalls ?? 0)} />
        <StatCard label="Avg Duration" value={metricsLoading ? '—' : `${Math.round(metrics?.avgDurationSeconds ?? 0)}s`} />
        <StatCard label="Errors" value={metricsLoading ? '—' : String(metrics?.errorCount ?? 0)} />
        <StatCard label="Error Rate" value={metricsLoading ? '—' : `${((metrics?.errorRate ?? 0) * 100).toFixed(1)}%`} />
      </div>

      <div className="bg-card border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Call Volume</h2>
        {metricsLoading ? (
          <div className="h-48 flex items-center justify-center text-muted-foreground">Loading...</div>
        ) : !metrics?.dailyBreakdown?.length ? (
          <div className="h-48 flex items-center justify-center text-muted-foreground">No data for this period</div>
        ) : (
          <div className="flex items-end gap-1 h-48">
            {metrics.dailyBreakdown.map((day) => (
              <div key={day.date} className="flex-1 flex flex-col items-center gap-1">
                <div
                  className="w-full bg-blue-500 rounded-t min-h-[2px] transition-all"
                  style={{ height: `${(day.calls / maxCalls) * 100}%` }}
                  title={`${day.date}: ${day.calls} calls, avg ${Math.round(day.avgDuration)}s`}
                />
                <span className="text-[10px] text-muted-foreground truncate w-full text-center">
                  {day.date.slice(5)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-card border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Recent Errors</h2>
        {errorsLoading ? (
          <div className="text-muted-foreground">Loading...</div>
        ) : !errorsData?.errors?.length ? (
          <div className="text-muted-foreground">No errors recorded</div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {errorsData.errors.map((err) => (
              <div key={err.id} className="flex items-start gap-3 p-3 bg-muted/50 rounded-lg">
                <span
                  className={clsx(
                    'text-xs font-mono px-2 py-0.5 rounded shrink-0 mt-0.5',
                    err.severity === 'critical' && 'bg-red-500/20 text-red-400',
                    err.severity === 'error' && 'bg-orange-500/20 text-orange-400',
                    err.severity === 'warning' && 'bg-yellow-500/20 text-yellow-400',
                    !['critical', 'error', 'warning'].includes(err.severity) && 'bg-blue-500/20 text-blue-400',
                  )}
                >
                  {err.severity}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate">{err.message}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {err.service && <span className="mr-2">{err.service}</span>}
                    {new Date(err.occurredAt).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function ToolActivityTab({ window }: { window: string }) {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [toolFilter, setToolFilter] = useState<string>('');
  const [selectedExecution, setSelectedExecution] = useState<ToolExecution | null>(null);

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['tool-stats', window],
    queryFn: () => api.get<ToolStatsResponse>(`/tool-executions/stats?window=${window}`),
    refetchInterval: 60_000,
  });

  const queryParams = new URLSearchParams({ page: String(page), limit: '20' });
  if (statusFilter) queryParams.set('status', statusFilter);
  if (toolFilter) queryParams.set('toolName', toolFilter);

  const { data: executions, isLoading: execLoading } = useQuery({
    queryKey: ['tool-executions', page, statusFilter, toolFilter],
    queryFn: () => api.get<ToolExecutionsResponse>(`/tool-executions?${queryParams}`),
    refetchInterval: 30_000,
  });

  const replayMutation = useMutation({
    mutationFn: (id: string) => api.post(`/tool-executions/${id}/replay`, { dryRun: true }),
  });

  const successRate = stats && stats.totalExecutions > 0
    ? ((stats.successCount / stats.totalExecutions) * 100).toFixed(1)
    : '0.0';

  const maxDaily = Math.max(1, ...(stats?.dailyBreakdown?.map((d) => d.total) ?? [1]));

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard label="Total Executions" value={statsLoading ? '—' : String(stats?.totalExecutions ?? 0)} />
        <StatCard label="Success Rate" value={statsLoading ? '—' : `${successRate}%`} />
        <StatCard label="Failures" value={statsLoading ? '—' : String(stats?.failureCount ?? 0)} />
        <StatCard label="Avg Duration" value={statsLoading ? '—' : `${stats?.avgDurationMs ?? 0}ms`} />
      </div>

      {stats?.dailyBreakdown && stats.dailyBreakdown.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Tool Execution Volume</h2>
          <div className="flex items-end gap-1 h-40">
            {stats.dailyBreakdown.map((day) => (
              <div key={day.date} className="flex-1 flex flex-col items-center gap-1">
                <div className="w-full flex flex-col-reverse">
                  <div
                    className="w-full bg-green-500 rounded-t min-h-[1px]"
                    style={{ height: `${(day.success / maxDaily) * 140}px` }}
                  />
                  {day.failed > 0 && (
                    <div
                      className="w-full bg-red-500"
                      style={{ height: `${(day.failed / maxDaily) * 140}px` }}
                    />
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground truncate w-full text-center">
                  {day.date.slice(5)}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-2 h-2 bg-green-500 rounded-sm" /> Success</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 bg-red-500 rounded-sm" /> Failed</span>
          </div>
        </div>
      )}

      {stats?.topTools && stats.topTools.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Top Tools</h2>
          <div className="space-y-2">
            {stats.topTools.map((t) => (
              <div key={t.toolName} className="flex items-center justify-between p-2 bg-muted/50 rounded-lg">
                <span className="text-sm font-mono">{t.toolName}</span>
                <div className="flex gap-4 text-sm text-muted-foreground">
                  <span>{t.count} calls</span>
                  <span>{t.avgDuration}ms avg</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Execution History</h2>
          <div className="flex gap-2">
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
              className="text-sm bg-muted border border-border rounded-md px-2 py-1"
            >
              <option value="">All statuses</option>
              <option value="success">Success</option>
              <option value="failed">Failed</option>
              <option value="running">Running</option>
              <option value="timeout">Timeout</option>
            </select>
            <input
              type="text"
              placeholder="Filter by tool..."
              value={toolFilter}
              onChange={(e) => { setToolFilter(e.target.value); setPage(1); }}
              className="text-sm bg-muted border border-border rounded-md px-2 py-1 w-40"
            />
          </div>
        </div>

        {execLoading ? (
          <div className="text-muted-foreground">Loading...</div>
        ) : !executions?.executions?.length ? (
          <div className="text-muted-foreground">No tool executions recorded</div>
        ) : (
          <>
            <div className="space-y-1">
              {executions.executions.map((exec) => (
                <button
                  key={exec.id}
                  onClick={() => setSelectedExecution(selectedExecution?.id === exec.id ? null : exec)}
                  className="w-full text-left flex items-center gap-3 p-3 bg-muted/30 hover:bg-muted/60 rounded-lg transition-colors"
                >
                  <StatusBadge status={exec.status} />
                  <span className="text-sm font-mono flex-shrink-0">{exec.toolName}</span>
                  {exec.agentSlug && (
                    <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
                      {exec.agentSlug}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">
                    {exec.durationMs !== null ? `${exec.durationMs}ms` : '—'}
                  </span>
                  <span className="text-xs text-muted-foreground flex-shrink-0">
                    {new Date(exec.invokedAt).toLocaleString()}
                  </span>
                </button>
              ))}
            </div>

            {selectedExecution && (
              <ExecutionDetail
                execution={selectedExecution}
                onClose={() => setSelectedExecution(null)}
                onReplay={() => replayMutation.mutate(selectedExecution.id)}
                replayResult={replayMutation.data}
                replayLoading={replayMutation.isPending}
              />
            )}

            {executions.totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                <span className="text-sm text-muted-foreground">
                  Page {executions.page} of {executions.totalPages} ({executions.total} total)
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage(Math.max(1, page - 1))}
                    disabled={page <= 1}
                    className="px-3 py-1 text-sm bg-muted rounded-md disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setPage(Math.min(executions.totalPages, page + 1))}
                    disabled={page >= executions.totalPages}
                    className="px-3 py-1 text-sm bg-muted rounded-md disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ToolRegistryTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['tool-registry'],
    queryFn: () => api.get<ToolRegistryResponse>('/tools/registry'),
  });

  return (
    <div className="bg-card border border-border rounded-xl p-6">
      <h2 className="text-lg font-semibold mb-4">Tool Registry</h2>
      {isLoading ? (
        <div className="text-muted-foreground">Loading...</div>
      ) : !data?.tools?.length ? (
        <div className="text-muted-foreground">No tools registered</div>
      ) : (
        <div className="space-y-3">
          {data.tools.map((tool) => (
            <div key={tool.name} className="p-4 bg-muted/30 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono font-semibold">{tool.name}</span>
                  <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">
                    {tool.category}
                  </span>
                  {tool.hasRecoveryInstructions && (
                    <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded">
                      recovery
                    </span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {tool.rateLimit.maxPerMinute}/min, {tool.rateLimit.maxPerHour}/hr
                </span>
              </div>
              <p className="text-sm text-muted-foreground">{tool.description}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ExecutionDetail({
  execution,
  onClose,
  onReplay,
  replayResult,
  replayLoading,
}: {
  execution: ToolExecution;
  onClose: () => void;
  onReplay: () => void;
  replayResult: unknown;
  replayLoading: boolean;
}) {
  return (
    <div className="mt-4 p-4 bg-muted/20 border border-border rounded-lg">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Execution Detail</h3>
        <div className="flex gap-2">
          <button
            onClick={onReplay}
            disabled={replayLoading}
            className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-md disabled:opacity-50"
          >
            {replayLoading ? 'Replaying...' : 'Dry Run Replay'}
          </button>
          <button onClick={onClose} className="px-3 py-1 text-xs bg-muted hover:bg-muted/80 rounded-md">
            Close
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <span className="text-muted-foreground">ID:</span>{' '}
          <span className="font-mono text-xs">{execution.id}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Status:</span>{' '}
          <StatusBadge status={execution.status} />
        </div>
        <div>
          <span className="text-muted-foreground">Tool:</span>{' '}
          <span className="font-mono">{execution.toolName}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Duration:</span>{' '}
          {execution.durationMs !== null ? `${execution.durationMs}ms` : '—'}
        </div>
        <div>
          <span className="text-muted-foreground">Agent:</span>{' '}
          {execution.agentSlug ?? '—'}
        </div>
        <div>
          <span className="text-muted-foreground">Call Session:</span>{' '}
          <span className="font-mono text-xs">{execution.callSessionId ?? '—'}</span>
        </div>
      </div>

      {execution.errorMessage && (
        <div className="mt-3 p-2 bg-red-500/10 border border-red-500/20 rounded text-sm text-red-400">
          <span className="font-semibold">Error:</span> {execution.errorMessage}
        </div>
      )}

      {execution.recoveryAction && (
        <div className="mt-2 p-2 bg-yellow-500/10 border border-yellow-500/20 rounded text-sm text-yellow-400">
          <span className="font-semibold">Recovery:</span> {execution.recoveryAction}
        </div>
      )}

      {execution.parametersRedacted && Object.keys(execution.parametersRedacted).length > 0 && (
        <div className="mt-3">
          <span className="text-sm text-muted-foreground">Parameters (redacted):</span>
          <pre className="mt-1 p-2 bg-muted rounded text-xs overflow-x-auto">
            {JSON.stringify(execution.parametersRedacted, null, 2)}
          </pre>
        </div>
      )}

      {execution.result !== null && execution.result !== undefined && (
        <div className="mt-3">
          <span className="text-sm text-muted-foreground">Result:</span>
          <pre className="mt-1 p-2 bg-muted rounded text-xs overflow-x-auto max-h-40">
            {JSON.stringify(execution.result, null, 2)}
          </pre>
        </div>
      )}

      {replayResult && (
        <div className="mt-3">
          <span className="text-sm text-muted-foreground">Replay Result:</span>
          <pre className="mt-1 p-2 bg-blue-500/10 border border-blue-500/20 rounded text-xs overflow-x-auto max-h-40">
            {JSON.stringify(replayResult, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={clsx(
        'text-xs font-mono px-2 py-0.5 rounded shrink-0',
        status === 'success' && 'bg-green-500/20 text-green-400',
        status === 'failed' && 'bg-red-500/20 text-red-400',
        status === 'running' && 'bg-blue-500/20 text-blue-400',
        status === 'pending' && 'bg-gray-500/20 text-gray-400',
        status === 'timeout' && 'bg-orange-500/20 text-orange-400',
      )}
    >
      {status}
    </span>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}
