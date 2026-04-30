import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import {
  ArrowLeft, BarChart3, Clock, TrendingUp, AlertTriangle, Users,
  Calendar, RefreshCw, Target, RotateCcw, Timer, Filter,
} from 'lucide-react';
import { PageHeader } from '../components/ui';
import { EmptyState, PageSkeleton } from '../components/state';

interface TeamMember { id: string; email: string; }

interface TimeStats {
  avg_response_seconds: string | null;
  median_response_seconds: string | null;
  min_response_seconds: string | null;
  max_response_seconds: string | null;
  sample_count: string;
}
interface ResTimeStats {
  avg_resolution_seconds: string | null;
  median_resolution_seconds: string | null;
  min_resolution_seconds: string | null;
  max_resolution_seconds: string | null;
  sample_count: string;
}
interface TimePriority {
  priority: string;
  avg_response_seconds?: string;
  avg_resolution_seconds?: string;
  sample_count: string;
}
interface TimeAgent {
  email: string;
  avg_response_seconds: string;
  sample_count: string;
}

interface ReportingData {
  dailyCreated: { date: string; count: string }[];
  dailyResolved: { date: string; count: string }[];
  byPriority: { priority: string; count: string }[];
  byCategory: { category: string; count: string }[];
  agentWorkload: { email: string; open_count: string; resolved_count: string }[];
  slaAttainment: { total: string; response_met_count: string; resolution_met_count: string };
  reopenRate: { total: string; reopened: string };
  backlogAging: { today: string; this_week: string; this_month: string; older: string };
  responseTime: TimeStats;
  resolutionTime: ResTimeStats;
  responseTimeByPriority: TimePriority[];
  resolutionTimeByPriority: TimePriority[];
  responseTimeByAgent: TimeAgent[];
}

const PRIORITY_COLORS: Record<string, string> = {
  low: '#94a3b8',
  medium: '#3b82f6',
  high: '#f97316',
  urgent: '#ef4444',
};

function formatDuration(seconds: number | null): string {
  if (seconds === null || isNaN(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function BarChartSimple({ data, maxVal, color, emptyTitle }: { data: { label: string; value: number }[]; maxVal: number; color?: string; emptyTitle?: string }) {
  if (data.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title={emptyTitle ?? 'No data in this window'}
        variant="compact"
      />
    );
  }
  return (
    <div className="space-y-1.5">
      {data.map((d, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-[10px] text-muted w-20 truncate text-right">{d.label}</span>
          <div className="flex-1 h-5 bg-surface-hover rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${maxVal > 0 ? (d.value / maxVal) * 100 : 0}%`, backgroundColor: color || '#6366f1' }}
            />
          </div>
          <span className="text-xs text-heading font-medium w-8 text-right">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

function MiniLineChart({ data }: { data: { date: string; value: number }[] }) {
  if (data.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No data in this window"
        variant="compact"
      />
    );
  }
  const max = Math.max(...data.map(d => d.value), 1);
  const points = data.map((d, i) => ({
    x: (i / Math.max(data.length - 1, 1)) * 100,
    y: 100 - (d.value / max) * 80 - 10,
  }));
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

  return (
    <div className="relative">
      <svg viewBox="0 0 100 100" className="w-full h-32" preserveAspectRatio="none">
        <path d={pathD} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary" />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="1.5" className="fill-primary" />
        ))}
      </svg>
      <div className="flex justify-between mt-1">
        <span className="text-[9px] text-muted">{data[0]?.date}</span>
        <span className="text-[9px] text-muted">{data[data.length - 1]?.date}</span>
      </div>
    </div>
  );
}

export default function TicketReporting() {
  const navigate = useNavigate();
  const [data, setData] = useState<ReportingData | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [filterAssignee, setFilterAssignee] = useState('');
  const [filterDepartment, setFilterDepartment] = useState('');
  const [filterPriority, setFilterPriority] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    api.get<TeamMember[]>('/team').then(setTeamMembers).catch(() => {});
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (dateFrom && dateTo) {
        params.set('date_from', dateFrom);
        params.set('date_to', dateTo);
      } else {
        params.set('days', String(days));
      }
      if (filterAssignee) params.set('assignee', filterAssignee);
      if (filterDepartment) params.set('department', filterDepartment);
      if (filterPriority) params.set('priority', filterPriority);
      const d = await api.get<ReportingData>(`/tickets/reporting?${params.toString()}`);
      setData(d);
    } catch {
      setError('Failed to load reporting data');
    } finally {
      setLoading(false);
    }
  }, [days, filterAssignee, filterDepartment, filterPriority, dateFrom, dateTo]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const clearFilters = () => {
    setFilterAssignee('');
    setFilterDepartment('');
    setFilterPriority('');
    setDateFrom('');
    setDateTo('');
    setDays(30);
  };

  const hasActiveFilters = filterAssignee || filterDepartment || filterPriority || dateFrom || dateTo;

  if (loading) {
    return <PageSkeleton />;
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        <PageHeader
          icon={<BarChart3 className="h-5 w-5" />}
          title="Ticket Reports"
          description="Performance metrics and analytics"
          breadcrumbs={(
            <button onClick={() => navigate('/tickets')} className="inline-flex items-center gap-1 hover:text-text-primary">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to tickets
            </button>
          )}
        />
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-sm text-red-700 dark:text-red-300">
          {error || 'No reporting data available'}
          <button onClick={fetchData} className="ml-3 underline">Retry</button>
        </div>
      </div>
    );
  }

  const slaTotal = parseInt(data.slaAttainment?.total) || 1;
  const slaResponsePct = Math.round((parseInt(data.slaAttainment?.response_met_count) / slaTotal) * 100);
  const slaResolutionPct = Math.round((parseInt(data.slaAttainment?.resolution_met_count) / slaTotal) * 100);
  const reopenTotal = parseInt(data.reopenRate?.total) || 1;
  const reopenPct = Math.round((parseInt(data.reopenRate?.reopened) / reopenTotal) * 100);

  const avgResponse = data.responseTime?.avg_response_seconds ? parseFloat(data.responseTime.avg_response_seconds) : null;
  const avgResolution = data.resolutionTime?.avg_resolution_seconds ? parseFloat(data.resolutionTime.avg_resolution_seconds) : null;

  const createdChartData = data.dailyCreated.map(d => ({ date: new Date(d.date).toLocaleDateString('en', { month: 'short', day: 'numeric' }), value: parseInt(d.count) }));
  const resolvedChartData = data.dailyResolved.map(d => ({ date: new Date(d.date).toLocaleDateString('en', { month: 'short', day: 'numeric' }), value: parseInt(d.count) }));

  const priorityMax = Math.max(...data.byPriority.map(d => parseInt(d.count)), 1);
  const categoryMax = Math.max(...data.byCategory.map(d => parseInt(d.count)), 1);
  const workloadMax = Math.max(...data.agentWorkload.map(d => parseInt(d.open_count) + parseInt(d.resolved_count)), 1);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<BarChart3 className="h-5 w-5" />}
        title="Ticket Reports"
        description="Performance metrics and analytics"
        breadcrumbs={(
          <button onClick={() => navigate('/tickets')} className="inline-flex items-center gap-1 hover:text-text-primary">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to tickets
          </button>
        )}
        actions={(
          <>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`px-3 py-1.5 rounded-lg border text-sm flex items-center gap-1.5 ${hasActiveFilters ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface text-muted hover:text-heading'}`}
            >
              <Filter className="h-3.5 w-3.5" />
              Filters {hasActiveFilters && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
            </button>
            <select value={days} onChange={e => setDays(parseInt(e.target.value))} className="px-3 py-1.5 rounded-lg border border-border bg-surface text-heading text-sm">
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
            <button onClick={fetchData} aria-label="Refresh" className="p-2 rounded-lg hover:bg-surface-secondary text-muted">
              <RefreshCw className="h-4 w-4" />
            </button>
          </>
        )}
      />

      {showFilters && (
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-[10px] font-medium text-muted mb-1 uppercase">Assignee</label>
              <select value={filterAssignee} onChange={e => setFilterAssignee(e.target.value)} className="px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-sm min-w-[140px]">
                <option value="">All</option>
                {teamMembers.map(m => <option key={m.id} value={m.id}>{m.email}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-muted mb-1 uppercase">Department</label>
              <input value={filterDepartment} onChange={e => setFilterDepartment(e.target.value)} placeholder="Any" className="px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-sm w-32" />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-muted mb-1 uppercase">Priority</label>
              <select value={filterPriority} onChange={e => setFilterPriority(e.target.value)} className="px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-sm">
                <option value="">All</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-muted mb-1 uppercase">From</label>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-sm" />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-muted mb-1 uppercase">To</label>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-sm" />
            </div>
            {hasActiveFilters && (
              <button onClick={clearFilters} className="px-3 py-1.5 text-xs text-muted hover:text-heading underline">Clear all</button>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Target className="h-4 w-4 text-green-500" />
            <span className="text-xs text-muted">SLA Response</span>
          </div>
          <div className="text-2xl font-bold text-heading">{slaResponsePct}%</div>
          <div className="text-[10px] text-muted">{data.slaAttainment?.response_met_count || 0} of {data.slaAttainment?.total || 0}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Target className="h-4 w-4 text-blue-500" />
            <span className="text-xs text-muted">SLA Resolution</span>
          </div>
          <div className="text-2xl font-bold text-heading">{slaResolutionPct}%</div>
          <div className="text-[10px] text-muted">{data.slaAttainment?.resolution_met_count || 0} of {data.slaAttainment?.total || 0}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Timer className="h-4 w-4 text-cyan-500" />
            <span className="text-xs text-muted">Avg Response</span>
          </div>
          <div className="text-2xl font-bold text-heading">{formatDuration(avgResponse)}</div>
          <div className="text-[10px] text-muted">{data.responseTime?.sample_count || 0} tickets</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Timer className="h-4 w-4 text-teal-500" />
            <span className="text-xs text-muted">Avg Resolution</span>
          </div>
          <div className="text-2xl font-bold text-heading">{formatDuration(avgResolution)}</div>
          <div className="text-[10px] text-muted">{data.resolutionTime?.sample_count || 0} tickets</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <RotateCcw className="h-4 w-4 text-orange-500" />
            <span className="text-xs text-muted">Reopen Rate</span>
          </div>
          <div className="text-2xl font-bold text-heading">{reopenPct}%</div>
          <div className="text-[10px] text-muted">{data.reopenRate?.reopened || 0} of {data.reopenRate?.total || 0}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="h-4 w-4 text-purple-500" />
            <span className="text-xs text-muted">Backlog</span>
          </div>
          <div className="text-2xl font-bold text-heading">
            {parseInt(data.backlogAging?.today || '0') + parseInt(data.backlogAging?.this_week || '0') + parseInt(data.backlogAging?.this_month || '0') + parseInt(data.backlogAging?.older || '0')}
          </div>
          <div className="text-[10px] text-muted">{data.backlogAging?.older || 0} older than 30d</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-medium text-heading mb-3 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" /> Tickets Created
          </h3>
          <MiniLineChart data={createdChartData} />
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-medium text-heading mb-3 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-green-500" /> Tickets Resolved
          </h3>
          <MiniLineChart data={resolvedChartData} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-medium text-heading mb-3 flex items-center gap-2">
            <Timer className="h-4 w-4 text-cyan-500" /> First Response Time
          </h3>
          <div className="grid grid-cols-4 gap-3 mb-4">
            <div className="text-center">
              <div className="text-lg font-bold text-heading">{formatDuration(data.responseTime?.avg_response_seconds ? parseFloat(data.responseTime.avg_response_seconds) : null)}</div>
              <div className="text-[10px] text-muted">Average</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-heading">{formatDuration(data.responseTime?.median_response_seconds ? parseFloat(data.responseTime.median_response_seconds) : null)}</div>
              <div className="text-[10px] text-muted">Median</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-heading">{formatDuration(data.responseTime?.min_response_seconds ? parseFloat(data.responseTime.min_response_seconds) : null)}</div>
              <div className="text-[10px] text-muted">Fastest</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-heading">{formatDuration(data.responseTime?.max_response_seconds ? parseFloat(data.responseTime.max_response_seconds) : null)}</div>
              <div className="text-[10px] text-muted">Slowest</div>
            </div>
          </div>
          <h4 className="text-xs font-medium text-muted mb-2">By Priority</h4>
          <BarChartSimple
            data={(data.responseTimeByPriority || []).map(d => ({
              label: d.priority,
              value: Math.round((parseFloat(d.avg_response_seconds || '0')) / 60),
            }))}
            maxVal={Math.max(...(data.responseTimeByPriority || []).map(d => Math.round(parseFloat(d.avg_response_seconds || '0') / 60)), 1)}
            color="#06b6d4"
            emptyTitle="No response time samples by priority"
          />
          <div className="text-[9px] text-muted mt-1 text-right">minutes</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-medium text-heading mb-3 flex items-center gap-2">
            <Timer className="h-4 w-4 text-teal-500" /> Resolution Time
          </h3>
          <div className="grid grid-cols-4 gap-3 mb-4">
            <div className="text-center">
              <div className="text-lg font-bold text-heading">{formatDuration(data.resolutionTime?.avg_resolution_seconds ? parseFloat(data.resolutionTime.avg_resolution_seconds) : null)}</div>
              <div className="text-[10px] text-muted">Average</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-heading">{formatDuration(data.resolutionTime?.median_resolution_seconds ? parseFloat(data.resolutionTime.median_resolution_seconds) : null)}</div>
              <div className="text-[10px] text-muted">Median</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-heading">{formatDuration(data.resolutionTime?.min_resolution_seconds ? parseFloat(data.resolutionTime.min_resolution_seconds) : null)}</div>
              <div className="text-[10px] text-muted">Fastest</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-heading">{formatDuration(data.resolutionTime?.max_resolution_seconds ? parseFloat(data.resolutionTime.max_resolution_seconds) : null)}</div>
              <div className="text-[10px] text-muted">Slowest</div>
            </div>
          </div>
          <h4 className="text-xs font-medium text-muted mb-2">By Priority</h4>
          <BarChartSimple
            data={(data.resolutionTimeByPriority || []).map(d => ({
              label: d.priority,
              value: Math.round((parseFloat(d.avg_resolution_seconds || '0')) / 3600),
            }))}
            maxVal={Math.max(...(data.resolutionTimeByPriority || []).map(d => Math.round(parseFloat(d.avg_resolution_seconds || '0') / 3600)), 1)}
            color="#14b8a6"
            emptyTitle="No resolution time samples by priority"
          />
          <div className="text-[9px] text-muted mt-1 text-right">hours</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-medium text-heading mb-3">By Priority</h3>
          <BarChartSimple
            data={data.byPriority.map(d => ({ label: d.priority, value: parseInt(d.count) }))}
            maxVal={priorityMax}
            color="#6366f1"
            emptyTitle="No tickets by priority"
          />
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-medium text-heading mb-3">By Category</h3>
          <BarChartSimple
            data={data.byCategory.map(d => ({ label: d.category, value: parseInt(d.count) }))}
            maxVal={categoryMax}
            color="#8b5cf6"
            emptyTitle="No tickets by category"
          />
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-medium text-heading mb-3">Backlog Aging</h3>
          <BarChartSimple
            data={[
              { label: 'Today', value: parseInt(data.backlogAging?.today || '0') },
              { label: 'This Week', value: parseInt(data.backlogAging?.this_week || '0') },
              { label: 'This Month', value: parseInt(data.backlogAging?.this_month || '0') },
              { label: '30d+', value: parseInt(data.backlogAging?.older || '0') },
            ]}
            maxVal={Math.max(parseInt(data.backlogAging?.today || '0'), parseInt(data.backlogAging?.this_week || '0'), parseInt(data.backlogAging?.this_month || '0'), parseInt(data.backlogAging?.older || '0'), 1)}
            color="#f59e0b"
            emptyTitle="No backlog in this window"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-medium text-heading mb-3 flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" /> Agent Workload
          </h3>
          {data.agentWorkload.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No agent activity yet"
              variant="compact"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted">Agent</th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted">Total</th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted">Resolved</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted">Distribution</th>
                  </tr>
                </thead>
                <tbody>
                  {data.agentWorkload.map(a => {
                    const total = parseInt(a.open_count);
                    const resolved = parseInt(a.resolved_count);
                    return (
                      <tr key={a.email} className="border-b border-border">
                        <td className="px-3 py-2 text-sm text-heading">{a.email}</td>
                        <td className="px-3 py-2 text-sm text-heading text-right">{total}</td>
                        <td className="px-3 py-2 text-sm text-green-600 text-right">{resolved}</td>
                        <td className="px-3 py-2">
                          <div className="h-3 bg-surface-hover rounded-full overflow-hidden w-32">
                            <div className="h-full rounded-full bg-primary" style={{ width: `${(total / workloadMax) * 100}%` }} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-medium text-heading mb-3 flex items-center gap-2">
            <Timer className="h-4 w-4 text-cyan-500" /> Response Time by Agent
          </h3>
          {(data.responseTimeByAgent || []).length === 0 ? (
            <EmptyState
              icon={Timer}
              title="No response time samples yet"
              variant="compact"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted">Agent</th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted">Avg Response</th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted">Tickets</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.responseTimeByAgent || []).map(a => (
                    <tr key={a.email} className="border-b border-border">
                      <td className="px-3 py-2 text-sm text-heading">{a.email}</td>
                      <td className="px-3 py-2 text-sm text-heading text-right">{formatDuration(parseFloat(a.avg_response_seconds))}</td>
                      <td className="px-3 py-2 text-sm text-muted text-right">{a.sample_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
