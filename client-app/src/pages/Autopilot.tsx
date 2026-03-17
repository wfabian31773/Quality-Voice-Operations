import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import {
  Zap, Brain, Shield, ShieldCheck, ShieldAlert, ShieldOff,
  CheckCircle2, XCircle, Clock, ChevronDown, ChevronUp, Loader2,
  BarChart3, AlertTriangle, TrendingUp, DollarSign, Play, RotateCcw,
  Bell, Settings2, Activity, Eye, ThumbsUp, ThumbsDown, Trash2,
  RefreshCw, Target, Sparkles, ArrowRight, Info, FileText, Gauge,
} from 'lucide-react';

interface DashboardSummary {
  totalInsights: number;
  activeInsights: number;
  totalRecommendations: number;
  pendingRecommendations: number;
  approvedRecommendations: number;
  rejectedRecommendations: number;
  executedActions: number;
  totalRevenueImpactCents: number;
  totalCostSavingsCents: number;
  lastRunAt: string | null;
}

interface AutopilotInsight {
  id: string;
  category: string;
  severity: string;
  title: string;
  description: string;
  detectedSignal: string;
  dataEvidence: Record<string, unknown>;
  industryPack: string | null;
  confidenceScore: number;
  status: string;
  createdAt: string;
}

interface AutopilotRecommendation {
  id: string;
  insightId: string | null;
  title: string;
  situationSummary: string;
  recommendedAction: string;
  expectedOutcome: string;
  reasoning: string;
  confidenceScore: number;
  riskTier: string;
  actionType: string;
  actionPayload: Record<string, unknown>;
  estimatedRevenueImpactCents: number | null;
  estimatedCostSavingsCents: number | null;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  industryPack: string | null;
  createdAt: string;
}

interface AutopilotAction {
  id: string;
  recommendationId: string | null;
  actionType: string;
  actionPayload: Record<string, unknown>;
  status: string;
  executedAt: string | null;
  completedAt: string | null;
  result: Record<string, unknown>;
  errorMessage: string | null;
  rolledBack: boolean;
  autoExecuted: boolean;
  createdAt: string;
}

interface AutopilotRun {
  id: string;
  runType: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  insightsDetected: number;
  recommendationsGenerated: number;
  actionsAutoExecuted: number;
  errors: number;
}

type TabType = 'overview' | 'recommendations' | 'actions' | 'insights' | 'policies' | 'notifications';

function formatCents(cents: number): string {
  if (cents >= 100000) return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  return `$${(cents / 100).toFixed(2)}`;
}

function severityColor(severity: string): string {
  if (severity === 'critical') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
  if (severity === 'warning') return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
  return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
}

function riskTierColor(tier: string): string {
  if (tier === 'high') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
  if (tier === 'medium') return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
  return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
}

function riskTierIcon(tier: string) {
  if (tier === 'high') return ShieldAlert;
  if (tier === 'medium') return Shield;
  return ShieldCheck;
}

function statusColor(status: string): string {
  if (status === 'approved' || status === 'completed' || status === 'executed') return 'text-green-600 dark:text-green-400';
  if (status === 'rejected' || status === 'failed') return 'text-red-600 dark:text-red-400';
  if (status === 'pending' || status === 'executing') return 'text-amber-600 dark:text-amber-400';
  if (status === 'dismissed' || status === 'rolled_back') return 'text-gray-500 dark:text-gray-400';
  return 'text-text-secondary';
}

function confidenceBadge(score: number): string {
  if (score >= 0.8) return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  if (score >= 0.5) return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
  return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
}

function SummaryCard({ icon: Icon, label, value, subtext, color }: { icon: typeof Zap; label: string; value: string; subtext?: string; color: string }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <div className="flex items-center gap-3">
        <div className={`p-2.5 rounded-lg shrink-0 ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-2xl font-bold text-text-primary">{value}</p>
          <p className="text-xs text-text-secondary">{label}</p>
          {subtext && <p className="text-[10px] text-text-secondary mt-0.5">{subtext}</p>}
        </div>
      </div>
    </div>
  );
}

export default function Autopilot() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabType>('overview');
  const [expandedRec, setExpandedRec] = useState<string | null>(null);
  const [expandedInsight, setExpandedInsight] = useState<string | null>(null);
  const [recStatusFilter, setRecStatusFilter] = useState('pending');

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['autopilot-summary'],
    queryFn: () => api.get<DashboardSummary>('/autopilot/summary'),
    refetchInterval: 30_000,
  });

  const { data: recsData, isLoading: recsLoading } = useQuery({
    queryKey: ['autopilot-recommendations', recStatusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (recStatusFilter) params.set('status', recStatusFilter);
      params.set('limit', '50');
      return api.get<{ recommendations: AutopilotRecommendation[]; total: number }>(`/autopilot/recommendations?${params}`);
    },
    enabled: tab === 'overview' || tab === 'recommendations',
    refetchInterval: 30_000,
  });

  const { data: insightsData, isLoading: insightsLoading } = useQuery({
    queryKey: ['autopilot-insights'],
    queryFn: () => api.get<{ insights: AutopilotInsight[]; total: number }>('/autopilot/insights?limit=50'),
    enabled: tab === 'overview' || tab === 'insights',
    refetchInterval: 60_000,
  });

  const { data: actionsData, isLoading: actionsLoading } = useQuery({
    queryKey: ['autopilot-actions'],
    queryFn: () => api.get<{ actions: AutopilotAction[]; total: number }>('/autopilot/actions?limit=50'),
    enabled: tab === 'actions',
  });

  const { data: runsData } = useQuery({
    queryKey: ['autopilot-runs'],
    queryFn: () => api.get<{ runs: AutopilotRun[] }>('/autopilot/runs?limit=10'),
    enabled: tab === 'overview',
  });

  const scanMutation = useMutation({
    mutationFn: () => api.post<{ run: AutopilotRun }>('/autopilot/scan', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['autopilot-summary'] });
      queryClient.invalidateQueries({ queryKey: ['autopilot-recommendations'] });
      queryClient.invalidateQueries({ queryKey: ['autopilot-insights'] });
      queryClient.invalidateQueries({ queryKey: ['autopilot-runs'] });
    },
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => api.post(`/autopilot/recommendations/${id}/approve`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['autopilot-recommendations'] });
      queryClient.invalidateQueries({ queryKey: ['autopilot-summary'] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post(`/autopilot/recommendations/${id}/reject`, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['autopilot-recommendations'] });
      queryClient.invalidateQueries({ queryKey: ['autopilot-summary'] });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: (id: string) => api.post(`/autopilot/recommendations/${id}/dismiss`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['autopilot-recommendations'] });
      queryClient.invalidateQueries({ queryKey: ['autopilot-summary'] });
    },
  });

  const executeMutation = useMutation({
    mutationFn: (id: string) => api.post(`/autopilot/recommendations/${id}/execute`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['autopilot-actions'] });
      queryClient.invalidateQueries({ queryKey: ['autopilot-recommendations'] });
      queryClient.invalidateQueries({ queryKey: ['autopilot-summary'] });
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: (id: string) => api.post(`/autopilot/actions/${id}/rollback`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['autopilot-actions'] });
      queryClient.invalidateQueries({ queryKey: ['autopilot-summary'] });
    },
  });

  const recommendations = recsData?.recommendations ?? [];
  const insights = insightsData?.insights ?? [];
  const actions = actionsData?.actions ?? [];
  const runs = runsData?.runs ?? [];

  const tabs: { key: TabType; label: string; icon: typeof Zap }[] = [
    { key: 'overview', label: 'Overview', icon: Gauge },
    { key: 'recommendations', label: 'Recommendations', icon: Target },
    { key: 'insights', label: 'Insights', icon: Eye },
    { key: 'actions', label: 'Action History', icon: Activity },
    { key: 'policies', label: 'Policies', icon: Settings2 },
    { key: 'notifications', label: 'Notifications', icon: Bell },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
            <Brain className="h-6 w-6 text-primary" />
            AI Business Autopilot
          </h1>
          <p className="text-sm text-text-secondary mt-1">
            Proactive intelligence that detects issues, recommends actions, and optimizes your operations
          </p>
        </div>
        <button
          onClick={() => scanMutation.mutate()}
          disabled={scanMutation.isPending}
          className="flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
        >
          {scanMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Zap className="h-4 w-4" />
          )}
          {scanMutation.isPending ? 'Scanning...' : 'Run Scan'}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <SummaryCard
          icon={Eye}
          label="Active Insights"
          value={summaryLoading ? '—' : String(summary?.activeInsights ?? 0)}
          color="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
        />
        <SummaryCard
          icon={Target}
          label="Pending Recommendations"
          value={summaryLoading ? '—' : String(summary?.pendingRecommendations ?? 0)}
          color="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
        />
        <SummaryCard
          icon={CheckCircle2}
          label="Approved"
          value={summaryLoading ? '—' : String(summary?.approvedRecommendations ?? 0)}
          color="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
        />
        <SummaryCard
          icon={DollarSign}
          label="Est. Revenue Impact"
          value={summaryLoading ? '—' : formatCents(summary?.totalRevenueImpactCents ?? 0)}
          subtext="from approved recommendations"
          color="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
        />
        <SummaryCard
          icon={Activity}
          label="Actions Executed"
          value={summaryLoading ? '—' : String(summary?.executedActions ?? 0)}
          color="bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"
        />
      </div>

      <div className="border-b border-border">
        <div className="flex gap-0 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
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

      {tab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-surface border border-border rounded-xl">
              <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                  <Target className="h-4 w-4 text-primary" />
                  Pending Recommendations
                </h3>
                <span className="text-xs text-text-secondary">{recommendations.length} items</span>
              </div>
              <div className="max-h-[400px] overflow-y-auto">
                {recsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  </div>
                ) : recommendations.length === 0 ? (
                  <div className="p-8 text-center">
                    <Sparkles className="h-8 w-8 text-text-secondary/30 mx-auto mb-2" />
                    <p className="text-sm text-text-secondary">No pending recommendations</p>
                    <p className="text-xs text-text-secondary mt-1">Run a scan to generate recommendations</p>
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {recommendations.slice(0, 5).map((rec) => {
                      const RiskIcon = riskTierIcon(rec.riskTier);
                      return (
                        <div key={rec.id} className="px-5 py-3">
                          <div className="flex items-start gap-3">
                            <div className={`p-1.5 rounded-md shrink-0 ${riskTierColor(rec.riskTier)}`}>
                              <RiskIcon className="h-3.5 w-3.5" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-text-primary truncate">{rec.title}</p>
                              <p className="text-xs text-text-secondary mt-0.5 line-clamp-1">{rec.situationSummary}</p>
                              <div className="flex items-center gap-2 mt-1.5">
                                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${confidenceBadge(rec.confidenceScore)}`}>
                                  {Math.round(rec.confidenceScore * 100)}% conf.
                                </span>
                                {rec.estimatedRevenueImpactCents != null && rec.estimatedRevenueImpactCents > 0 && (
                                  <span className="text-[10px] text-green-600 dark:text-green-400 font-medium">
                                    +{formatCents(rec.estimatedRevenueImpactCents)}/mo
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                onClick={() => approveMutation.mutate(rec.id)}
                                className="p-1.5 text-green-600 hover:bg-green-100 dark:hover:bg-green-900/30 rounded-md transition-colors"
                                title="Approve"
                              >
                                <ThumbsUp className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => rejectMutation.mutate({ id: rec.id })}
                                className="p-1.5 text-red-600 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-md transition-colors"
                                title="Reject"
                              >
                                <ThumbsDown className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              {recommendations.length > 5 && (
                <div className="px-5 py-3 border-t border-border">
                  <button
                    onClick={() => setTab('recommendations')}
                    className="text-xs text-primary hover:text-primary-hover font-medium flex items-center gap-1"
                  >
                    View all {recommendations.length} recommendations <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>

            <div className="bg-surface border border-border rounded-xl">
              <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary" />
                  Recent Scan Runs
                </h3>
              </div>
              <div className="max-h-[400px] overflow-y-auto">
                {runs.length === 0 ? (
                  <div className="p-8 text-center">
                    <RefreshCw className="h-8 w-8 text-text-secondary/30 mx-auto mb-2" />
                    <p className="text-sm text-text-secondary">No scans run yet</p>
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {runs.map((run) => (
                      <div key={run.id} className="px-5 py-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${run.status === 'completed' ? 'bg-green-500' : run.status === 'running' ? 'bg-amber-500 animate-pulse' : 'bg-red-500'}`} />
                            <span className="text-sm text-text-primary capitalize">{run.runType} scan</span>
                          </div>
                          <span className="text-xs text-text-secondary">
                            {new Date(run.startedAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1.5 text-xs text-text-secondary">
                          <span>{run.insightsDetected} insights</span>
                          <span>{run.recommendationsGenerated} recommendations</span>
                          {run.errors > 0 && <span className="text-red-500">{run.errors} errors</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {insights.length > 0 && (
            <div className="bg-surface border border-border rounded-xl">
              <div className="px-5 py-4 border-b border-border">
                <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  Recent Insights
                </h3>
              </div>
              <div className="divide-y divide-border">
                {insights.slice(0, 5).map((insight) => (
                  <div key={insight.id} className="px-5 py-3 flex items-start gap-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 mt-0.5 ${severityColor(insight.severity)}`}>
                      {insight.severity}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">{insight.title}</p>
                      <p className="text-xs text-text-secondary mt-0.5 line-clamp-2">{insight.description}</p>
                    </div>
                    <span className="text-[10px] text-text-secondary shrink-0">
                      {new Date(insight.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'recommendations' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <div className="flex gap-1 bg-surface border border-border rounded-lg p-1">
              {['pending', 'approved', 'rejected', 'dismissed', 'executed', ''].map((s) => (
                <button
                  key={s}
                  onClick={() => setRecStatusFilter(s)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    recStatusFilter === s
                      ? 'bg-primary text-white'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {s || 'All'}
                </button>
              ))}
            </div>
          </div>

          {recsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : recommendations.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-12 text-center">
              <Target className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-text-secondary font-medium">No recommendations found</p>
              <p className="text-sm text-text-secondary mt-1">Run a scan to generate autopilot recommendations</p>
            </div>
          ) : (
            <div className="space-y-3">
              {recommendations.map((rec) => {
                const RiskIcon = riskTierIcon(rec.riskTier);
                const isExpanded = expandedRec === rec.id;

                return (
                  <div key={rec.id} className="bg-surface border border-border rounded-xl shadow-sm hover:shadow-md transition-shadow">
                    <div className="px-5 py-4 cursor-pointer" onClick={() => setExpandedRec(isExpanded ? null : rec.id)}>
                      <div className="flex items-start gap-4">
                        <div className={`p-2.5 rounded-lg shrink-0 ${riskTierColor(rec.riskTier)}`}>
                          <RiskIcon className="h-5 w-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-sm font-semibold text-text-primary">{rec.title}</h3>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${riskTierColor(rec.riskTier)}`}>
                              {rec.riskTier} risk
                            </span>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${confidenceBadge(rec.confidenceScore)}`}>
                              {Math.round(rec.confidenceScore * 100)}% confidence
                            </span>
                            {rec.industryPack && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400">
                                {rec.industryPack}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-text-secondary mt-1">{rec.situationSummary}</p>
                          <div className="flex items-center gap-3 mt-1.5">
                            {rec.estimatedRevenueImpactCents != null && rec.estimatedRevenueImpactCents > 0 && (
                              <span className="text-xs text-green-600 dark:text-green-400 font-medium flex items-center gap-1">
                                <TrendingUp className="h-3 w-3" />
                                +{formatCents(rec.estimatedRevenueImpactCents)}/mo revenue
                              </span>
                            )}
                            {rec.estimatedCostSavingsCents != null && rec.estimatedCostSavingsCents > 0 && (
                              <span className="text-xs text-blue-600 dark:text-blue-400 font-medium flex items-center gap-1">
                                <DollarSign className="h-3 w-3" />
                                {formatCents(rec.estimatedCostSavingsCents)}/mo savings
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {rec.status === 'pending' && (
                            <>
                              <button
                                onClick={(e) => { e.stopPropagation(); approveMutation.mutate(rec.id); }}
                                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-green-700 bg-green-100 hover:bg-green-200 dark:text-green-400 dark:bg-green-900/30 dark:hover:bg-green-900/50 rounded-lg transition-colors"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); rejectMutation.mutate({ id: rec.id }); }}
                                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-100 hover:bg-red-200 dark:text-red-400 dark:bg-red-900/30 dark:hover:bg-red-900/50 rounded-lg transition-colors"
                              >
                                <XCircle className="h-3.5 w-3.5" /> Reject
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); dismissMutation.mutate(rec.id); }}
                                className="p-1.5 text-text-secondary hover:text-text-primary rounded-md transition-colors"
                                title="Dismiss"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                          {rec.status === 'approved' && (
                            <button
                              onClick={(e) => { e.stopPropagation(); executeMutation.mutate(rec.id); }}
                              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-primary bg-primary/10 hover:bg-primary/20 rounded-lg transition-colors"
                            >
                              <Play className="h-3.5 w-3.5" /> Execute
                            </button>
                          )}
                          {rec.status !== 'pending' && rec.status !== 'approved' && (
                            <span className={`text-xs font-medium capitalize ${statusColor(rec.status)}`}>
                              {rec.status}
                            </span>
                          )}
                          {isExpanded ? <ChevronUp className="h-4 w-4 text-text-secondary" /> : <ChevronDown className="h-4 w-4 text-text-secondary" />}
                        </div>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="px-5 pb-5 border-t border-border pt-4 space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          <div className="bg-surface-hover rounded-lg p-3">
                            <p className="text-xs font-medium text-text-secondary uppercase mb-1">Recommended Action</p>
                            <p className="text-sm text-text-primary">{rec.recommendedAction}</p>
                          </div>
                          <div className="bg-green-50 dark:bg-green-900/10 rounded-lg p-3">
                            <p className="text-xs font-medium text-text-secondary uppercase mb-1">Expected Outcome</p>
                            <p className="text-sm text-text-primary">{rec.expectedOutcome}</p>
                          </div>
                          <div className="bg-blue-50 dark:bg-blue-900/10 rounded-lg p-3">
                            <p className="text-xs font-medium text-text-secondary uppercase mb-1">Reasoning</p>
                            <p className="text-sm text-text-primary">{rec.reasoning}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-text-secondary">
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {new Date(rec.createdAt).toLocaleString()}
                          </span>
                          <span>Action: {rec.actionType.replace(/_/g, ' ')}</span>
                          {rec.approvedBy && <span>Approved by: {rec.approvedBy}</span>}
                          {rec.rejectionReason && <span>Reason: {rec.rejectionReason}</span>}
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

      {tab === 'insights' && (
        <div className="space-y-3">
          {insightsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : insights.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-12 text-center">
              <Eye className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-text-secondary font-medium">No insights detected yet</p>
              <p className="text-sm text-text-secondary mt-1">Run a scan to detect operational patterns and issues</p>
            </div>
          ) : (
            insights.map((insight) => {
              const isExpanded = expandedInsight === insight.id;
              return (
                <div key={insight.id} className="bg-surface border border-border rounded-xl shadow-sm">
                  <div className="px-5 py-4 cursor-pointer" onClick={() => setExpandedInsight(isExpanded ? null : insight.id)}>
                    <div className="flex items-start gap-4">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium shrink-0 ${severityColor(insight.severity)}`}>
                        {insight.severity}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-semibold text-text-primary">{insight.title}</h3>
                          <span className="text-[10px] text-text-secondary bg-surface-hover px-2 py-0.5 rounded">
                            {insight.category.replace(/_/g, ' ')}
                          </span>
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${confidenceBadge(insight.confidenceScore)}`}>
                            {Math.round(insight.confidenceScore * 100)}%
                          </span>
                          {insight.industryPack && (
                            <span className="text-[10px] text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 px-2 py-0.5 rounded">
                              {insight.industryPack}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-text-secondary mt-1 line-clamp-2">{insight.description}</p>
                      </div>
                      <span className="text-xs text-text-secondary shrink-0">
                        {new Date(insight.createdAt).toLocaleDateString()}
                      </span>
                      {isExpanded ? <ChevronUp className="h-4 w-4 text-text-secondary" /> : <ChevronDown className="h-4 w-4 text-text-secondary" />}
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-5 pb-4 border-t border-border pt-3 space-y-3">
                      <div>
                        <p className="text-xs font-medium text-text-secondary uppercase mb-1">Detected Signal</p>
                        <p className="text-sm text-text-primary">{insight.detectedSignal}</p>
                      </div>
                      {Object.keys(insight.dataEvidence).length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-text-secondary uppercase mb-1">Data Evidence</p>
                          <pre className="text-xs text-text-secondary bg-surface-hover p-3 rounded-lg overflow-x-auto">
                            {JSON.stringify(insight.dataEvidence, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {tab === 'actions' && (
        <div className="space-y-3">
          {actionsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : actions.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-12 text-center">
              <Activity className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-text-secondary font-medium">No actions executed yet</p>
              <p className="text-sm text-text-secondary mt-1">Approve and execute recommendations to see action history</p>
            </div>
          ) : (
            actions.map((action) => (
              <div key={action.id} className="bg-surface border border-border rounded-xl px-5 py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-2.5 h-2.5 rounded-full ${
                      action.status === 'completed' ? 'bg-green-500' :
                      action.status === 'failed' ? 'bg-red-500' :
                      action.status === 'rolled_back' ? 'bg-gray-400' :
                      action.status === 'executing' ? 'bg-amber-500 animate-pulse' :
                      'bg-gray-300'
                    }`} />
                    <div>
                      <p className="text-sm font-medium text-text-primary">
                        {action.actionType.replace(/_/g, ' ')}
                      </p>
                      <p className="text-xs text-text-secondary mt-0.5">
                        {action.autoExecuted ? 'Auto-executed' : 'Manually executed'}
                        {action.executedAt && ` at ${new Date(action.executedAt).toLocaleString()}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-medium capitalize ${statusColor(action.status)}`}>
                      {action.status.replace(/_/g, ' ')}
                    </span>
                    {action.status === 'completed' && !action.rolledBack && (
                      <button
                        onClick={() => rollbackMutation.mutate(action.id)}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover rounded-md transition-colors"
                      >
                        <RotateCcw className="h-3 w-3" /> Rollback
                      </button>
                    )}
                  </div>
                </div>
                {action.errorMessage && (
                  <p className="text-xs text-red-600 dark:text-red-400 mt-2 bg-red-50 dark:bg-red-900/10 p-2 rounded">
                    {action.errorMessage}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'policies' && <PoliciesPanel />}

      {tab === 'notifications' && <NotificationsPanel />}
    </div>
  );
}

function PoliciesPanel() {
  const queryClient = useQueryClient();

  const { data: policiesData, isLoading } = useQuery({
    queryKey: ['autopilot-policies'],
    queryFn: () => api.get<{ policies: Array<{ id: string; name: string; riskTier: string; actionType: string; requiresApproval: boolean; approvalRole: string; autoExecute: boolean; enabled: boolean }> }>('/autopilot/policies'),
  });

  const saveMutation = useMutation({
    mutationFn: (policy: { name: string; riskTier: string; actionType: string; requiresApproval: boolean; approvalRole: string; autoExecute: boolean }) =>
      api.post('/autopilot/policies', policy),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['autopilot-policies'] }),
  });

  const policies = policiesData?.policies ?? [];

  const defaultPolicies = [
    { name: 'Auto-execute low-risk alerts', riskTier: 'low', actionType: 'send_alert', requiresApproval: false, approvalRole: 'operator', autoExecute: true },
    { name: 'Manager approval for workflow changes', riskTier: 'medium', actionType: 'enable_workflow', requiresApproval: true, approvalRole: 'manager', autoExecute: false },
    { name: 'Owner approval for campaign launches', riskTier: 'high', actionType: 'launch_campaign', requiresApproval: true, approvalRole: 'owner', autoExecute: false },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Approval Policies</h3>
          <p className="text-xs text-text-secondary mt-0.5">Configure which actions require human approval and at what role level</p>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="grid grid-cols-6 gap-4 px-5 py-3 bg-surface-hover text-xs font-medium text-text-secondary uppercase">
          <span className="col-span-2">Policy</span>
          <span>Risk Tier</span>
          <span>Action Type</span>
          <span>Approval</span>
          <span>Auto-Execute</span>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : policies.length === 0 ? (
          <div className="p-8 text-center">
            <Settings2 className="h-8 w-8 text-text-secondary/30 mx-auto mb-2" />
            <p className="text-sm text-text-secondary">No policies configured yet</p>
            <p className="text-xs text-text-secondary mt-1 mb-3">Set up default policies to get started</p>
            <button
              onClick={() => defaultPolicies.forEach(p => saveMutation.mutate(p))}
              disabled={saveMutation.isPending}
              className="text-xs text-primary hover:text-primary-hover font-medium"
            >
              {saveMutation.isPending ? 'Creating...' : 'Create Default Policies'}
            </button>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {policies.map((policy) => (
              <div key={policy.id} className="grid grid-cols-6 gap-4 px-5 py-3 items-center">
                <span className="col-span-2 text-sm text-text-primary font-medium">{policy.name}</span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium w-fit ${riskTierColor(policy.riskTier)}`}>
                  {policy.riskTier}
                </span>
                <span className="text-xs text-text-secondary">{policy.actionType.replace(/_/g, ' ')}</span>
                <span className="text-xs text-text-secondary">
                  {policy.requiresApproval ? `${policy.approvalRole}+` : 'None'}
                </span>
                <span className={`text-xs font-medium ${policy.autoExecute ? 'text-green-600 dark:text-green-400' : 'text-text-secondary'}`}>
                  {policy.autoExecute ? 'Yes' : 'No'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-surface border border-border rounded-xl p-5">
        <h4 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
          <Info className="h-4 w-4 text-text-secondary" />
          How Approval Tiers Work
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-green-50 dark:bg-green-900/10 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <ShieldCheck className="h-4 w-4 text-green-600" />
              <span className="text-sm font-medium text-green-700 dark:text-green-400">Low Risk</span>
            </div>
            <p className="text-xs text-text-secondary">Auto-executed without approval. Alerts, notifications, task creation.</p>
          </div>
          <div className="bg-amber-50 dark:bg-amber-900/10 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <Shield className="h-4 w-4 text-amber-600" />
              <span className="text-sm font-medium text-amber-700 dark:text-amber-400">Medium Risk</span>
            </div>
            <p className="text-xs text-text-secondary">Requires manager approval. Workflow changes, schedule adjustments.</p>
          </div>
          <div className="bg-red-50 dark:bg-red-900/10 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <ShieldAlert className="h-4 w-4 text-red-600" />
              <span className="text-sm font-medium text-red-700 dark:text-red-400">High Risk</span>
            </div>
            <p className="text-xs text-text-secondary">Requires admin approval. Campaign launches, routing changes, agent activation.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function NotificationsPanel() {
  const queryClient = useQueryClient();

  const { data: notifData, isLoading } = useQuery({
    queryKey: ['autopilot-notifications'],
    queryFn: () => api.get<{ notifications: Array<{ id: string; title: string; body: string; severity: string; channel: string; read: boolean; createdAt: string }>; unreadCount: number }>('/autopilot/notifications?limit=50'),
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => api.post('/autopilot/notifications/read-all', {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['autopilot-notifications'] }),
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => api.post(`/autopilot/notifications/${id}/read`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['autopilot-notifications'] }),
  });

  const notifications = notifData?.notifications ?? [];
  const unreadCount = notifData?.unreadCount ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-text-primary">Autopilot Notifications</h3>
          {unreadCount > 0 && (
            <span className="bg-primary text-white text-[10px] font-bold px-2 py-0.5 rounded-full">{unreadCount}</span>
          )}
        </div>
        {unreadCount > 0 && (
          <button
            onClick={() => markAllReadMutation.mutate()}
            className="text-xs text-primary hover:text-primary-hover font-medium"
          >
            Mark all read
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : notifications.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <Bell className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
          <p className="text-text-secondary font-medium">No notifications yet</p>
          <p className="text-sm text-text-secondary mt-1">Notifications will appear here when the autopilot detects important events</p>
        </div>
      ) : (
        <div className="space-y-2">
          {notifications.map((notif) => (
            <div
              key={notif.id}
              className={`bg-surface border border-border rounded-xl px-5 py-3 flex items-start gap-3 ${!notif.read ? 'border-l-2 border-l-primary' : ''}`}
              onClick={() => !notif.read && markReadMutation.mutate(notif.id)}
            >
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 mt-0.5 ${severityColor(notif.severity)}`}>
                {notif.channel}
              </span>
              <div className="flex-1 min-w-0">
                <p className={`text-sm ${!notif.read ? 'font-semibold text-text-primary' : 'text-text-primary'}`}>{notif.title}</p>
                <p className="text-xs text-text-secondary mt-0.5">{notif.body}</p>
              </div>
              <span className="text-[10px] text-text-secondary shrink-0">
                {new Date(notif.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
