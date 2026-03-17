import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import {
  Lightbulb, TrendingUp, DollarSign, Bot, Wrench, Calendar,
  CheckCircle2, XCircle, Clock, ChevronDown, ChevronUp, Loader2,
  Zap, BarChart3, AlertTriangle, FileText, RefreshCw, ArrowRight,
  Target, Sparkles, Bell, ShieldAlert, ShieldCheck,
} from 'lucide-react';

interface AiInsight {
  id: string;
  tenantId: string;
  category: string;
  title: string;
  description: string;
  impactEstimate: string | null;
  difficulty: string;
  estimatedRevenueImpactCents: number | null;
  status: string;
  actionType: string | null;
  actionPayload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  measuredImpact: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

interface InsightsSummary {
  totalInsights: number;
  newInsights: number;
  acceptedInsights: number;
  dismissedInsights: number;
  byCategory: Record<string, number>;
}

interface WeeklyReport {
  id: string;
  weekStart: string;
  weekEnd: string;
  summary: string;
  metricsSnapshot: Record<string, unknown>;
  topIssues: Array<{ title: string; description: string; severity: string }>;
  prioritizedActions: Array<{ title: string; description: string; priority: number; effort: string }>;
  insightsGenerated: number;
  insightsAccepted: number;
  insightsDismissed: number;
  createdAt: string;
}

interface OperationsAlert {
  id: string;
  tenantId: string;
  type: string;
  severity: string;
  message: string;
  metadata: Record<string, unknown>;
  acknowledged: boolean;
  createdAt: string;
}

type TabType = 'recommendations' | 'reports' | 'alerts' | 'tracking';
type CategoryFilter = '' | 'missed_opportunity' | 'performance' | 'cost_optimization' | 'agent_improvement' | 'workflow' | 'scheduling';

const CATEGORIES: { value: CategoryFilter; label: string; icon: typeof Lightbulb }[] = [
  { value: '', label: 'All', icon: Sparkles },
  { value: 'missed_opportunity', label: 'Missed Opportunities', icon: Target },
  { value: 'performance', label: 'Performance', icon: TrendingUp },
  { value: 'cost_optimization', label: 'Cost Optimization', icon: DollarSign },
  { value: 'agent_improvement', label: 'Agent Improvement', icon: Bot },
  { value: 'workflow', label: 'Workflow', icon: Wrench },
  { value: 'scheduling', label: 'Scheduling', icon: Calendar },
];

function categoryIcon(category: string) {
  const found = CATEGORIES.find((c) => c.value === category);
  return found?.icon || Lightbulb;
}

function categoryColor(category: string): string {
  const colors: Record<string, string> = {
    missed_opportunity: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    performance: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    cost_optimization: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    agent_improvement: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
    workflow: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
    scheduling: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
  };
  return colors[category] || 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400';
}

function difficultyBadge(difficulty: string): string {
  if (difficulty === 'easy') return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  if (difficulty === 'hard') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
  return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
}

function severityBadge(severity: string): string {
  if (severity === 'high') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
  if (severity === 'low') return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
}

function actionPath(insight: AiInsight): { label: string; path: string } | null {
  if (!insight.actionType) return null;
  const payload = insight.actionPayload || {};
  const agentId = payload.agentId as string | undefined;
  const agentParam = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';

  const map: Record<string, { label: string; path: string }> = {
    update_prompt: { label: 'Edit Agent Prompt', path: `/agents${agentParam}${agentParam ? '&section=prompt' : '?section=prompt'}` },
    add_tool: { label: 'Configure Tools', path: `/connectors${agentParam}` },
    adjust_schedule: { label: 'Adjust Schedule', path: `/agents${agentParam}${agentParam ? '&section=schedule' : '?section=schedule'}` },
    enable_feature: { label: 'Enable Feature', path: '/settings' },
    review_calls: { label: 'Review Calls', path: `/quality${payload.callId ? `?callId=${encodeURIComponent(String(payload.callId))}` : ''}` },
  };
  return map[insight.actionType] || null;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function Insights() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabType>('recommendations');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('');
  const [expandedInsight, setExpandedInsight] = useState<string | null>(null);
  const [expandedReport, setExpandedReport] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('new');

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['insights-summary'],
    queryFn: () => api.get<InsightsSummary>('/insights/summary'),
    refetchInterval: 60_000,
  });

  const { data: insightsData, isLoading: insightsLoading } = useQuery({
    queryKey: ['insights', statusFilter, categoryFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      params.set('limit', '50');
      return api.get<{ insights: AiInsight[]; total: number }>(`/insights?${params}`);
    },
    refetchInterval: 60_000,
  });

  const { data: reportsData, isLoading: reportsLoading } = useQuery({
    queryKey: ['weekly-reports'],
    queryFn: () => api.get<{ reports: WeeklyReport[] }>('/insights/weekly-reports'),
    enabled: tab === 'reports',
  });

  const analyzeMutation = useMutation({
    mutationFn: () => api.post<{ insights: AiInsight[]; count: number }>('/insights/analyze', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['insights'] });
      queryClient.invalidateQueries({ queryKey: ['insights-summary'] });
    },
  });

  const generateReportMutation = useMutation({
    mutationFn: () => api.post<{ report: WeeklyReport }>('/insights/weekly-report', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['weekly-reports'] });
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'accepted' | 'dismissed' }) =>
      api.post<{ insight: AiInsight }>(`/insights/${id}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['insights'] });
      queryClient.invalidateQueries({ queryKey: ['insights-summary'] });
    },
  });

  const insights = insightsData?.insights ?? [];
  const reports = reportsData?.reports ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-primary" />
            Operations Intelligence
          </h1>
          <p className="text-sm text-text-secondary mt-1">
            AI-powered insights and recommendations for your voice operations
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => analyzeMutation.mutate()}
            disabled={analyzeMutation.isPending}
            className="flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
          >
            {analyzeMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Zap className="h-4 w-4" />
            )}
            {analyzeMutation.isPending ? 'Analyzing...' : 'Run Analysis'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          icon={Lightbulb}
          label="Total Insights"
          value={summaryLoading ? '—' : String(summary?.totalInsights ?? 0)}
          color="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
        />
        <SummaryCard
          icon={Sparkles}
          label="New Recommendations"
          value={summaryLoading ? '—' : String(summary?.newInsights ?? 0)}
          color="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
        />
        <SummaryCard
          icon={CheckCircle2}
          label="Accepted"
          value={summaryLoading ? '—' : String(summary?.acceptedInsights ?? 0)}
          color="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
        />
        <SummaryCard
          icon={XCircle}
          label="Dismissed"
          value={summaryLoading ? '—' : String(summary?.dismissedInsights ?? 0)}
          color="bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
        />
      </div>

      <div className="border-b border-border">
        <div className="flex gap-0">
          {([
            { key: 'recommendations', label: 'Recommendations', icon: Lightbulb },
            { key: 'reports', label: 'Weekly Reports', icon: FileText },
            { key: 'alerts', label: 'Alert History', icon: Bell },
            { key: 'tracking', label: 'Impact Tracking', icon: BarChart3 },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'recommendations' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 bg-surface border border-border rounded-lg p-1">
              {['new', 'accepted', 'dismissed', ''].map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    statusFilter === s
                      ? 'bg-primary text-white'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {s || 'All'}
                </button>
              ))}
            </div>
            <div className="flex gap-1 bg-surface border border-border rounded-lg p-1">
              {CATEGORIES.map((c) => (
                <button
                  key={c.value}
                  onClick={() => setCategoryFilter(c.value)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    categoryFilter === c.value
                      ? 'bg-primary text-white'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {insightsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : insights.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-12 text-center">
              <Lightbulb className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-text-secondary font-medium">No insights yet</p>
              <p className="text-sm text-text-secondary mt-1">
                Click "Run Analysis" to generate AI-powered recommendations based on your call data
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {insights.map((insight) => {
                const CatIcon = categoryIcon(insight.category);
                const action = actionPath(insight);
                const isExpanded = expandedInsight === insight.id;

                return (
                  <div
                    key={insight.id}
                    className="bg-surface border border-border rounded-xl shadow-sm hover:shadow-md transition-shadow"
                  >
                    <div
                      className="px-5 py-4 cursor-pointer"
                      onClick={() => setExpandedInsight(isExpanded ? null : insight.id)}
                    >
                      <div className="flex items-start gap-4">
                        <div className={`p-2.5 rounded-lg shrink-0 ${categoryColor(insight.category)}`}>
                          <CatIcon className="h-5 w-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-sm font-semibold text-text-primary">{insight.title}</h3>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${categoryColor(insight.category)}`}>
                              {insight.category.replace(/_/g, ' ')}
                            </span>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${difficultyBadge(insight.difficulty)}`}>
                              {insight.difficulty}
                            </span>
                          </div>
                          {insight.impactEstimate && (
                            <p className="text-xs text-text-secondary mt-1 flex items-center gap-1">
                              <TrendingUp className="h-3 w-3" />
                              {insight.impactEstimate}
                              {insight.estimatedRevenueImpactCents != null && insight.estimatedRevenueImpactCents > 0 && (
                                <span className="font-medium text-green-600 dark:text-green-400 ml-1">
                                  ({formatCents(insight.estimatedRevenueImpactCents)}/mo est.)
                                </span>
                              )}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {insight.status === 'new' && (
                            <>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  statusMutation.mutate({ id: insight.id, status: 'accepted' });
                                }}
                                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-green-700 bg-green-100 hover:bg-green-200 dark:text-green-400 dark:bg-green-900/30 dark:hover:bg-green-900/50 rounded-lg transition-colors"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Accept
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  statusMutation.mutate({ id: insight.id, status: 'dismissed' });
                                }}
                                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover rounded-lg transition-colors"
                              >
                                <XCircle className="h-3.5 w-3.5" />
                                Dismiss
                              </button>
                            </>
                          )}
                          {insight.status === 'accepted' && (
                            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400 font-medium">
                              <CheckCircle2 className="h-3.5 w-3.5" /> Accepted
                            </span>
                          )}
                          {insight.status === 'dismissed' && (
                            <span className="flex items-center gap-1 text-xs text-text-secondary font-medium">
                              <XCircle className="h-3.5 w-3.5" /> Dismissed
                            </span>
                          )}
                          {isExpanded ? (
                            <ChevronUp className="h-4 w-4 text-text-secondary" />
                          ) : (
                            <ChevronDown className="h-4 w-4 text-text-secondary" />
                          )}
                        </div>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="px-5 pb-4 border-t border-border pt-3">
                        <p className="text-sm text-text-secondary leading-relaxed">{insight.description}</p>
                        {action && (
                          <button
                            onClick={() => navigate(action.path)}
                            className="mt-3 flex items-center gap-2 text-sm text-primary hover:text-primary-hover font-medium transition-colors"
                          >
                            {action.label}
                            <ArrowRight className="h-4 w-4" />
                          </button>
                        )}
                        <div className="flex items-center gap-4 mt-3 text-xs text-text-secondary">
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {new Date(insight.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'reports' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-text-secondary">Weekly optimization reports summarizing key metrics and actions</p>
            <button
              onClick={() => generateReportMutation.mutate()}
              disabled={generateReportMutation.isPending}
              className="flex items-center gap-2 bg-surface border border-border hover:bg-surface-hover text-text-primary text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            >
              {generateReportMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Generate Report
            </button>
          </div>

          {reportsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : reports.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-12 text-center">
              <FileText className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-text-secondary font-medium">No weekly reports yet</p>
              <p className="text-sm text-text-secondary mt-1">
                Click "Generate Report" to create your first weekly operations report
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {reports.map((report) => {
                const isExpanded = expandedReport === report.id;
                const metrics = report.metricsSnapshot as Record<string, unknown>;

                return (
                  <div key={report.id} className="bg-surface border border-border rounded-xl shadow-sm">
                    <div
                      className="px-5 py-4 cursor-pointer"
                      onClick={() => setExpandedReport(isExpanded ? null : report.id)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                            <FileText className="h-5 w-5" />
                          </div>
                          <div>
                            <h3 className="text-sm font-semibold text-text-primary">
                              Week of {report.weekStart} to {report.weekEnd}
                            </h3>
                            <p className="text-xs text-text-secondary mt-0.5">
                              {metrics.totalCalls ?? 0} calls · {metrics.callsChange ?? '0'}% change from prev week
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-2 text-xs text-text-secondary">
                            <span className="flex items-center gap-1">
                              <CheckCircle2 className="h-3 w-3 text-green-500" /> {report.insightsAccepted}
                            </span>
                            <span className="flex items-center gap-1">
                              <XCircle className="h-3 w-3 text-text-secondary" /> {report.insightsDismissed}
                            </span>
                          </div>
                          {isExpanded ? (
                            <ChevronUp className="h-4 w-4 text-text-secondary" />
                          ) : (
                            <ChevronDown className="h-4 w-4 text-text-secondary" />
                          )}
                        </div>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="px-5 pb-5 border-t border-border pt-4 space-y-4">
                        <div>
                          <h4 className="text-xs font-medium text-text-secondary uppercase mb-2">Summary</h4>
                          <p className="text-sm text-text-primary leading-relaxed">{report.summary}</p>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          <MiniStat label="Total Calls" value={String(metrics.totalCalls ?? 0)} />
                          <MiniStat label="Completed" value={String(metrics.completed ?? 0)} />
                          <MiniStat label="Failed" value={String(metrics.failed ?? 0)} />
                          <MiniStat label="Avg Quality" value={String(metrics.avgQuality ?? '—')} />
                        </div>

                        {report.topIssues.length > 0 && (
                          <div>
                            <h4 className="text-xs font-medium text-text-secondary uppercase mb-2">Top Issues</h4>
                            <div className="space-y-2">
                              {report.topIssues.map((issue, i) => (
                                <div key={i} className="flex items-start gap-3 bg-surface-hover rounded-lg p-3">
                                  <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <p className="text-sm font-medium text-text-primary">{issue.title}</p>
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${severityBadge(issue.severity)}`}>
                                        {issue.severity}
                                      </span>
                                    </div>
                                    <p className="text-xs text-text-secondary mt-0.5">{issue.description}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {report.prioritizedActions.length > 0 && (
                          <div>
                            <h4 className="text-xs font-medium text-text-secondary uppercase mb-2">Prioritized Actions</h4>
                            <div className="space-y-2">
                              {report.prioritizedActions.map((action, i) => (
                                <div key={i} className="flex items-start gap-3 bg-surface-hover rounded-lg p-3">
                                  <span className="flex items-center justify-center h-5 w-5 rounded-full bg-primary text-white text-[10px] font-bold shrink-0 mt-0.5">
                                    {action.priority}
                                  </span>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <p className="text-sm font-medium text-text-primary">{action.title}</p>
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${difficultyBadge(action.effort)}`}>
                                        {action.effort}
                                      </span>
                                    </div>
                                    <p className="text-xs text-text-secondary mt-0.5">{action.description}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'alerts' && (
        <AlertsTab />
      )}

      {tab === 'tracking' && (
        <TrackingTab />
      )}
    </div>
  );
}

function alertSeverityStyle(severity: string): { bg: string; icon: typeof ShieldAlert } {
  if (severity === 'critical') return { bg: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400', icon: ShieldAlert };
  if (severity === 'warning') return { bg: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400', icon: AlertTriangle };
  return { bg: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400', icon: Bell };
}

function alertTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    booking_rate_drop: 'Completion Rate Drop',
    escalation_spike: 'Escalation Spike',
    error_rate_spike: 'Error Rate Spike',
    cost_anomaly: 'Cost Anomaly',
  };
  return labels[type] || type.replace(/_/g, ' ');
}

function AlertsTab() {
  const queryClient = useQueryClient();
  const [severityFilter, setSeverityFilter] = useState<string>('');

  const { data: alertsData, isLoading } = useQuery({
    queryKey: ['insights-alerts', severityFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (severityFilter) params.set('severity', severityFilter);
      params.set('limit', '50');
      return api.get<{ alerts: OperationsAlert[]; total: number }>(`/insights/alerts?${params}`);
    },
    refetchInterval: 30_000,
  });

  const acknowledgeMutation = useMutation({
    mutationFn: (alertId: string) =>
      api.post<{ success: boolean }>(`/insights/alerts/${alertId}/acknowledge`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['insights-alerts'] });
    },
  });

  const alerts = alertsData?.alerts ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">Real-time anomaly alerts from automated monitoring</p>
        <div className="flex gap-1 bg-surface border border-border rounded-lg p-1">
          {['', 'critical', 'warning', 'info'].map((s) => (
            <button
              key={s}
              onClick={() => setSeverityFilter(s)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                severityFilter === s
                  ? 'bg-primary text-white'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {s || 'All'}
            </button>
          ))}
        </div>
      </div>

      {alerts.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <ShieldCheck className="h-10 w-10 text-green-400 mx-auto mb-3" />
          <p className="text-text-secondary font-medium">No alerts</p>
          <p className="text-sm text-text-secondary mt-1">
            All systems are operating normally. Anomaly detection runs every 30 minutes.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map((alert) => {
            const style = alertSeverityStyle(alert.severity);
            const AlertIcon = style.icon;

            return (
              <div
                key={alert.id}
                className={`bg-surface border border-border rounded-xl shadow-sm px-5 py-4 ${
                  alert.acknowledged ? 'opacity-60' : ''
                }`}
              >
                <div className="flex items-start gap-4">
                  <div className={`p-2.5 rounded-lg shrink-0 ${style.bg}`}>
                    <AlertIcon className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-sm font-semibold text-text-primary">{alertTypeLabel(alert.type)}</h3>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${style.bg}`}>
                        {alert.severity}
                      </span>
                      {alert.acknowledged && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                          acknowledged
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-text-secondary mt-1">{alert.message}</p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-text-secondary">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {new Date(alert.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  {!alert.acknowledged && (
                    <button
                      onClick={() => acknowledgeMutation.mutate(alert.id)}
                      disabled={acknowledgeMutation.isPending}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover rounded-lg transition-colors shrink-0"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Acknowledge
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TrackingTab() {
  const { data: insightsData, isLoading } = useQuery({
    queryKey: ['insights', 'accepted', ''],
    queryFn: () => api.get<{ insights: AiInsight[]; total: number }>('/insights?status=accepted&limit=50'),
  });

  const insights = insightsData?.insights ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (insights.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-xl p-12 text-center">
        <BarChart3 className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
        <p className="text-text-secondary font-medium">No accepted recommendations to track</p>
        <p className="text-sm text-text-secondary mt-1">
          Accept recommendations to track their impact over time
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">
        Tracking impact of {insights.length} accepted recommendation{insights.length !== 1 ? 's' : ''}
      </p>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-hover">
              <th className="text-left px-5 py-3 text-xs font-medium text-text-secondary uppercase">Recommendation</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-text-secondary uppercase hidden md:table-cell">Category</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-text-secondary uppercase hidden lg:table-cell">Expected Impact</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-text-secondary uppercase">Accepted</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-text-secondary uppercase">Status</th>
            </tr>
          </thead>
          <tbody>
            {insights.map((insight) => (
              <tr key={insight.id} className="border-b border-border last:border-0 hover:bg-surface-hover/50">
                <td className="px-5 py-3">
                  <p className="font-medium text-text-primary">{insight.title}</p>
                </td>
                <td className="px-5 py-3 hidden md:table-cell">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${categoryColor(insight.category)}`}>
                    {insight.category.replace(/_/g, ' ')}
                  </span>
                </td>
                <td className="px-5 py-3 text-text-secondary text-xs hidden lg:table-cell">
                  {insight.impactEstimate || '—'}
                </td>
                <td className="px-5 py-3 text-text-secondary text-xs">
                  {new Date(insight.updatedAt).toLocaleDateString()}
                </td>
                <td className="px-5 py-3">
                  {insight.measuredImpact ? (
                    <div>
                      <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400 font-medium">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Measured
                      </span>
                      {typeof (insight.measuredImpact as Record<string, unknown>).completionRateChange === 'number' && (
                        <span className="text-[10px] text-text-secondary block mt-0.5">
                          Completion: {((insight.measuredImpact as Record<string, unknown>).completionRateChange as number) > 0 ? '+' : ''}
                          {(((insight.measuredImpact as Record<string, unknown>).completionRateChange as number) * 100).toFixed(1)}%
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 font-medium">
                      <Clock className="h-3.5 w-3.5" /> Monitoring
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, color }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={`p-2.5 rounded-lg ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-text-secondary">{label}</p>
          <p className="text-2xl font-bold text-text-primary">{value}</p>
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface-hover rounded-lg p-3">
      <p className="text-[10px] text-text-secondary uppercase">{label}</p>
      <p className="text-lg font-bold text-text-primary mt-0.5">{value}</p>
    </div>
  );
}
