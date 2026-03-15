import { useQuery } from '@tanstack/react-query';
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

const WINDOWS = ['24h', '7d', '30d'] as const;

export default function Observability() {
  const [window, setWindow] = useState<string>('7d');

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

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
          label="Total Calls"
          value={metricsLoading ? '—' : String(metrics?.totalCalls ?? 0)}
        />
        <StatCard
          label="Avg Duration"
          value={metricsLoading ? '—' : `${Math.round(metrics?.avgDurationSeconds ?? 0)}s`}
        />
        <StatCard
          label="Errors"
          value={metricsLoading ? '—' : String(metrics?.errorCount ?? 0)}
        />
        <StatCard
          label="Error Rate"
          value={metricsLoading ? '—' : `${((metrics?.errorRate ?? 0) * 100).toFixed(1)}%`}
        />
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
    </div>
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
