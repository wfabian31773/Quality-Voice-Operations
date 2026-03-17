import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  Dna, TrendingUp, Lightbulb, FlaskConical, BarChart3,
  CheckCircle, XCircle, Clock, ChevronRight, Play,
  AlertCircle, Zap, Target, ArrowUpRight, Brain,
  RefreshCw, Filter, ChevronDown,
} from 'lucide-react';
import clsx from 'clsx';

interface DashboardData {
  opportunities: {
    total: number;
    highValue: number;
    newThisMonth: number;
    top5: Array<{
      id: string;
      opportunity_type: string;
      title: string;
      composite_score: number;
      signal_count: number;
      affected_tenant_count: number;
      created_at: string;
    }>;
  };
  recommendations: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    approvedRevenueCents: number;
    topRecommendation: {
      id: string;
      title: string;
      recommended_priority: string;
      estimated_revenue_impact_cents: number;
      ai_explanation: string | null;
      created_at: string;
    } | null;
  };
  verticalGrowth: Array<{
    vertical_name: string;
    current_tenant_count: number;
    expansion_score: number;
    growth_rate: number;
  }>;
  topIntegrations: Array<{
    integration_name: string;
    demand_score: number;
    request_count: number;
    unique_tenant_count: number;
  }>;
  experiments: {
    total: number;
    active: number;
    concluded: number;
  };
  signals: {
    total: number;
    last7d: number;
  };
}

interface Opportunity {
  id: string;
  opportunityType: string;
  title: string;
  description: string | null;
  status: string;
  customerDemandScore: number;
  revenuePotentialScore: number;
  strategicFitScore: number;
  developmentEffortScore: number;
  retentionImpactScore: number;
  differentiationScore: number;
  compositeScore: number;
  signalCount: number;
  affectedTenantCount: number;
  evidence: unknown[];
  createdAt: string;
}

interface Recommendation {
  id: string;
  opportunityId: string | null;
  title: string;
  problemDetected: string;
  evidenceSummary: string | null;
  affectedSegments: string[];
  expectedBusinessImpact: Record<string, unknown>;
  implementationComplexity: string;
  recommendedPriority: string;
  estimatedRevenueImpactCents: number;
  estimatedEffortDays: number;
  aiExplanation: string | null;
  status: string;
  statusChangedBy: string | null;
  statusChangedAt: string | null;
  statusReason: string | null;
  createdAt: string;
}

interface Experiment {
  id: string;
  experimentName: string;
  experimentType: string;
  state: string;
  hypothesis: string | null;
  description: string | null;
  pilotTenantIds: string[];
  config: Record<string, unknown>;
  successCriteria: Record<string, unknown>;
  results: Record<string, unknown>;
  opportunityId: string | null;
  startedAt: string | null;
  concludedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

type Tab = 'overview' | 'opportunities' | 'roadmap' | 'experiments';

const TYPE_LABELS: Record<string, string> = {
  missing_vertical: 'Missing Vertical',
  missing_integration: 'Missing Integration',
  missing_tool: 'Missing Tool',
  onboarding_gap: 'Onboarding Gap',
  marketplace_gap: 'Marketplace Gap',
  retention_risk: 'Retention Risk',
  revenue_opportunity: 'Revenue Opportunity',
  ux_improvement: 'UX Improvement',
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  low: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
};

const STATE_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
  active: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  paused: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  concluded: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  cancelled: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function ScoreBar({ score, max = 10, label }: { score: number; max?: number; label: string }) {
  const pct = Math.min((score / max) * 100, 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-28 text-gray-500 dark:text-gray-400 truncate">{label}</span>
      <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className={clsx('h-full rounded-full', pct >= 70 ? 'bg-teal-500' : pct >= 40 ? 'bg-yellow-500' : 'bg-gray-400')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-8 text-right text-gray-600 dark:text-gray-300">{score.toFixed(1)}</span>
    </div>
  );
}

export default function EvolutionEngine() {
  const [tab, setTab] = useState<Tab>('overview');
  const [oppTypeFilter, setOppTypeFilter] = useState('');
  const [recStatusFilter, setRecStatusFilter] = useState('');
  const [expStateFilter, setExpStateFilter] = useState('');
  const [selectedOpp, setSelectedOpp] = useState<Opportunity | null>(null);
  const [selectedRec, setSelectedRec] = useState<Recommendation | null>(null);
  const [showNewExperiment, setShowNewExperiment] = useState(false);
  const [newExp, setNewExp] = useState({ experimentName: '', experimentType: 'prompt_pack', hypothesis: '', description: '' });
  const queryClient = useQueryClient();

  const { data: dashboardData, isLoading: dashLoading } = useQuery<{ dashboard: DashboardData }>({
    queryKey: ['evolution-dashboard'],
    queryFn: () => api.get('/evolution/dashboard'),
  });

  const { data: oppsData, isLoading: oppsLoading } = useQuery<{ opportunities: Opportunity[]; total: number }>({
    queryKey: ['evolution-opportunities', oppTypeFilter],
    queryFn: () => api.get(`/evolution/opportunities${oppTypeFilter ? `?type=${oppTypeFilter}` : ''}`),
    enabled: tab === 'opportunities',
  });

  const { data: recsData, isLoading: recsLoading } = useQuery<{ recommendations: Recommendation[]; total: number }>({
    queryKey: ['evolution-recommendations', recStatusFilter],
    queryFn: () => api.get(`/evolution/recommendations${recStatusFilter ? `?status=${recStatusFilter}` : ''}`),
    enabled: tab === 'roadmap',
  });

  const { data: expsData, isLoading: expsLoading } = useQuery<{ experiments: Experiment[]; total: number }>({
    queryKey: ['evolution-experiments', expStateFilter],
    queryFn: () => api.get(`/evolution/experiments${expStateFilter ? `?state=${expStateFilter}` : ''}`),
    enabled: tab === 'experiments',
  });

  const runPipeline = useMutation({
    mutationFn: () => api.post('/evolution/run-pipeline', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['evolution-dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['evolution-opportunities'] });
      queryClient.invalidateQueries({ queryKey: ['evolution-recommendations'] });
    },
  });

  const updateRecStatus = useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: string; reason?: string }) =>
      api.patch(`/evolution/recommendations/${id}/status`, { status, reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['evolution-recommendations'] });
      queryClient.invalidateQueries({ queryKey: ['evolution-dashboard'] });
    },
  });

  const updateExpState = useMutation({
    mutationFn: ({ id, state }: { id: string; state: string }) =>
      api.patch(`/evolution/experiments/${id}/state`, { state }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['evolution-experiments'] });
      queryClient.invalidateQueries({ queryKey: ['evolution-dashboard'] });
    },
  });

  const createExp = useMutation({
    mutationFn: (data: typeof newExp) => api.post('/evolution/experiments', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['evolution-experiments'] });
      setShowNewExperiment(false);
      setNewExp({ experimentName: '', experimentType: 'prompt_pack', hypothesis: '', description: '' });
    },
  });

  const dash = dashboardData?.dashboard;

  const tabs: { key: Tab; label: string; icon: typeof Dna }[] = [
    { key: 'overview', label: 'Overview', icon: BarChart3 },
    { key: 'opportunities', label: 'Opportunities', icon: Lightbulb },
    { key: 'roadmap', label: 'Roadmap', icon: Target },
    { key: 'experiments', label: 'Experiments', icon: FlaskConical },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-indigo-600 rounded-xl flex items-center justify-center">
            <Dna className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Platform Evolution Engine</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">AI-powered product intelligence and roadmap recommendations</p>
          </div>
        </div>
        <button
          onClick={() => runPipeline.mutate()}
          disabled={runPipeline.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 text-sm font-medium"
        >
          {runPipeline.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {runPipeline.isPending ? 'Running...' : 'Run Pipeline'}
        </button>
      </div>

      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors',
              tab === key
                ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300',
            )}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-6">
          {dashLoading ? (
            <div className="text-center py-12 text-gray-500">Loading dashboard...</div>
          ) : dash ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard icon={Lightbulb} label="Active Opportunities" value={dash.opportunities.total} sub={`${dash.opportunities.highValue} high value`} color="purple" />
                <StatCard icon={Target} label="Recommendations" value={dash.recommendations.total} sub={`${dash.recommendations.pending} pending review`} color="blue" />
                <StatCard icon={FlaskConical} label="Experiments" value={dash.experiments.total} sub={`${dash.experiments.active} active`} color="teal" />
                <StatCard icon={Zap} label="Signals (7d)" value={dash.signals.last7d} sub={`${dash.signals.total} total`} color="orange" />
              </div>

              {dash.recommendations.topRecommendation && (
                <div className="bg-gradient-to-r from-purple-50 to-indigo-50 dark:from-purple-900/20 dark:to-indigo-900/20 border border-purple-200 dark:border-purple-800 rounded-xl p-6">
                  <div className="flex items-start gap-3">
                    <Brain className="w-6 h-6 text-purple-600 dark:text-purple-400 mt-1 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-semibold text-purple-900 dark:text-purple-200">Top Recommendation</h3>
                        <span className={clsx('px-2 py-0.5 rounded text-xs font-medium', PRIORITY_COLORS[dash.recommendations.topRecommendation.recommended_priority] || PRIORITY_COLORS.medium)}>
                          {dash.recommendations.topRecommendation.recommended_priority}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-gray-900 dark:text-white mb-2">
                        {dash.recommendations.topRecommendation.title}
                      </p>
                      {dash.recommendations.topRecommendation.ai_explanation && (
                        <p className="text-sm text-gray-700 dark:text-gray-300 line-clamp-3">
                          {dash.recommendations.topRecommendation.ai_explanation}
                        </p>
                      )}
                      {dash.recommendations.topRecommendation.estimated_revenue_impact_cents > 0 && (
                        <p className="text-xs text-purple-700 dark:text-purple-300 mt-2 font-medium">
                          Est. revenue impact: {formatCents(dash.recommendations.topRecommendation.estimated_revenue_impact_cents)}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-teal-500" />
                    Top Opportunities This Quarter
                  </h3>
                  {dash.opportunities.top5.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">No opportunities detected yet. Run the pipeline to start.</p>
                  ) : (
                    <div className="space-y-3">
                      {dash.opportunities.top5.map((opp) => (
                        <div key={opp.id} className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                          <div className="w-8 h-8 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center text-xs font-bold text-purple-700 dark:text-purple-300">
                            {opp.composite_score.toFixed(1)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{opp.title}</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              {TYPE_LABELS[opp.opportunity_type] || opp.opportunity_type} · {opp.signal_count} signals · {opp.affected_tenant_count} tenants
                            </p>
                          </div>
                          <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-6">
                  <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                      <ArrowUpRight className="w-4 h-4 text-green-500" />
                      Fastest-Growing Verticals
                    </h3>
                    {dash.verticalGrowth.length === 0 ? (
                      <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">No vertical data yet</p>
                    ) : (
                      <div className="space-y-2">
                        {dash.verticalGrowth.map((v, i) => (
                          <div key={i} className="flex items-center justify-between text-sm">
                            <span className="text-gray-700 dark:text-gray-300 capitalize">{v.vertical_name}</span>
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-gray-500 dark:text-gray-400">{v.current_tenant_count} tenants</span>
                              <span className="font-medium text-gray-900 dark:text-white">{v.expansion_score.toFixed(1)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                      <Zap className="w-4 h-4 text-orange-500" />
                      Most Requested Integrations
                    </h3>
                    {dash.topIntegrations.length === 0 ? (
                      <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">No integration demand data yet</p>
                    ) : (
                      <div className="space-y-2">
                        {dash.topIntegrations.map((integ, i) => (
                          <div key={i} className="flex items-center justify-between text-sm">
                            <span className="text-gray-700 dark:text-gray-300">{integ.integration_name}</span>
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-gray-500 dark:text-gray-400">{integ.unique_tenant_count} tenants</span>
                              <span className="font-medium text-gray-900 dark:text-white">{integ.demand_score.toFixed(1)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {dash.recommendations.approvedRevenueCents > 0 && (
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Approved Roadmap Revenue Impact</h3>
                    <span className="text-lg font-bold text-green-600 dark:text-green-400">
                      {formatCents(dash.recommendations.approvedRevenueCents)}
                    </span>
                  </div>
                  <div className="flex gap-4 mt-3 text-xs text-gray-500 dark:text-gray-400">
                    <span>{dash.recommendations.approved} approved</span>
                    <span>{dash.recommendations.rejected} rejected</span>
                    <span>{dash.recommendations.pending} pending</span>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}

      {tab === 'opportunities' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Filter className="w-4 h-4 text-gray-400" />
            <select
              value={oppTypeFilter}
              onChange={(e) => setOppTypeFilter(e.target.value)}
              className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            >
              <option value="">All Types</option>
              {Object.entries(TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>

          {oppsLoading ? (
            <div className="text-center py-12 text-gray-500">Loading opportunities...</div>
          ) : (oppsData?.opportunities ?? []).length === 0 ? (
            <div className="text-center py-12 text-gray-500 dark:text-gray-400">
              <Lightbulb className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p>No opportunities detected yet</p>
              <p className="text-xs mt-1">Run the pipeline to collect signals and detect opportunities</p>
            </div>
          ) : (
            <div className="space-y-3">
              {(oppsData?.opportunities ?? []).map((opp) => (
                <div
                  key={opp.id}
                  onClick={() => setSelectedOpp(selectedOpp?.id === opp.id ? null : opp)}
                  className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4 cursor-pointer hover:border-purple-300 dark:hover:border-purple-700 transition-colors"
                >
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-xl bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center flex-shrink-0">
                      <span className="text-sm font-bold text-purple-700 dark:text-purple-300">{opp.compositeScore.toFixed(1)}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">{opp.title}</h3>
                        <span className="px-2 py-0.5 rounded text-xs bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                          {TYPE_LABELS[opp.opportunityType] || opp.opportunityType}
                        </span>
                      </div>
                      {opp.description && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{opp.description}</p>
                      )}
                      <div className="flex gap-4 mt-2 text-xs text-gray-500 dark:text-gray-400">
                        <span>{opp.signalCount} signals</span>
                        <span>{opp.affectedTenantCount} tenants</span>
                        <span>{new Date(opp.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <ChevronDown className={clsx('w-4 h-4 text-gray-400 transition-transform flex-shrink-0', selectedOpp?.id === opp.id && 'rotate-180')} />
                  </div>

                  {selectedOpp?.id === opp.id && (
                    <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                        <ScoreBar label="Customer Demand" score={opp.customerDemandScore} />
                        <ScoreBar label="Revenue Potential" score={opp.revenuePotentialScore} />
                        <ScoreBar label="Strategic Fit" score={opp.strategicFitScore} />
                        <ScoreBar label="Dev Effort" score={opp.developmentEffortScore} />
                        <ScoreBar label="Retention Impact" score={opp.retentionImpactScore} />
                        <ScoreBar label="Differentiation" score={opp.differentiationScore} />
                      </div>
                      {opp.evidence.length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Evidence</p>
                          <pre className="text-xs bg-gray-50 dark:bg-gray-900 p-3 rounded-lg overflow-x-auto text-gray-600 dark:text-gray-400">
                            {JSON.stringify(opp.evidence, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'roadmap' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Filter className="w-4 h-4 text-gray-400" />
            <select
              value={recStatusFilter}
              onChange={(e) => setRecStatusFilter(e.target.value)}
              className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            >
              <option value="">All Statuses</option>
              <option value="proposed">Proposed</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="deferred">Deferred</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
            </select>
          </div>

          {recsLoading ? (
            <div className="text-center py-12 text-gray-500">Loading recommendations...</div>
          ) : (recsData?.recommendations ?? []).length === 0 ? (
            <div className="text-center py-12 text-gray-500 dark:text-gray-400">
              <Target className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p>No roadmap recommendations yet</p>
              <p className="text-xs mt-1">Run the pipeline to generate recommendations from detected opportunities</p>
            </div>
          ) : (
            <div className="space-y-4">
              {(recsData?.recommendations ?? []).map((rec) => (
                <div
                  key={rec.id}
                  className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5"
                >
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{rec.title}</h3>
                        <span className={clsx('px-2 py-0.5 rounded text-xs font-medium', PRIORITY_COLORS[rec.recommendedPriority] || PRIORITY_COLORS.medium)}>
                          {rec.recommendedPriority}
                        </span>
                        <span className={clsx('px-2 py-0.5 rounded text-xs', rec.status === 'proposed' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : rec.status === 'approved' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400')}>
                          {rec.status}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-300">{rec.problemDetected}</p>
                    </div>
                    {rec.estimatedRevenueImpactCents > 0 && (
                      <div className="text-right flex-shrink-0">
                        <p className="text-xs text-gray-500 dark:text-gray-400">Est. Revenue Impact</p>
                        <p className="text-lg font-bold text-green-600 dark:text-green-400">{formatCents(rec.estimatedRevenueImpactCents)}</p>
                      </div>
                    )}
                  </div>

                  {rec.aiExplanation && (
                    <div
                      onClick={() => setSelectedRec(selectedRec?.id === rec.id ? null : rec)}
                      className="bg-purple-50 dark:bg-purple-900/10 border border-purple-200 dark:border-purple-800 rounded-lg p-4 mb-3 cursor-pointer"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Brain className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                        <span className="text-xs font-semibold text-purple-700 dark:text-purple-300">AI Product Strategist</span>
                        <ChevronDown className={clsx('w-3 h-3 text-purple-400 ml-auto transition-transform', selectedRec?.id === rec.id && 'rotate-180')} />
                      </div>
                      <p className={clsx('text-sm text-gray-700 dark:text-gray-300', selectedRec?.id !== rec.id && 'line-clamp-2')}>
                        {rec.aiExplanation}
                      </p>
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <div className="flex gap-4 text-xs text-gray-500 dark:text-gray-400">
                      <span>Complexity: {rec.implementationComplexity}</span>
                      <span>Effort: {rec.estimatedEffortDays}d</span>
                      <span>{new Date(rec.createdAt).toLocaleDateString()}</span>
                    </div>

                    {rec.status === 'proposed' && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => updateRecStatus.mutate({ id: rec.id, status: 'approved' })}
                          disabled={updateRecStatus.isPending}
                          className="flex items-center gap-1 px-3 py-1 text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 rounded-lg hover:bg-green-200 dark:hover:bg-green-900/50"
                        >
                          <CheckCircle className="w-3 h-3" /> Approve
                        </button>
                        <button
                          onClick={() => updateRecStatus.mutate({ id: rec.id, status: 'rejected' })}
                          disabled={updateRecStatus.isPending}
                          className="flex items-center gap-1 px-3 py-1 text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 rounded-lg hover:bg-red-200 dark:hover:bg-red-900/50"
                        >
                          <XCircle className="w-3 h-3" /> Reject
                        </button>
                        <button
                          onClick={() => updateRecStatus.mutate({ id: rec.id, status: 'deferred' })}
                          disabled={updateRecStatus.isPending}
                          className="flex items-center gap-1 px-3 py-1 text-xs font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300 rounded-lg hover:bg-yellow-200 dark:hover:bg-yellow-900/50"
                        >
                          <Clock className="w-3 h-3" /> Defer
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'experiments' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Filter className="w-4 h-4 text-gray-400" />
              <select
                value={expStateFilter}
                onChange={(e) => setExpStateFilter(e.target.value)}
                className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
              >
                <option value="">All States</option>
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="concluded">Concluded</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
            <button
              onClick={() => setShowNewExperiment(!showNewExperiment)}
              className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium"
            >
              <FlaskConical className="w-4 h-4" />
              New Experiment
            </button>
          </div>

          {showNewExperiment && (
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Create Experiment</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
                  <input
                    value={newExp.experimentName}
                    onChange={(e) => setNewExp({ ...newExp, experimentName: e.target.value })}
                    className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-900 dark:text-white"
                    placeholder="Experiment name"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Type</label>
                  <select
                    value={newExp.experimentType}
                    onChange={(e) => setNewExp({ ...newExp, experimentType: e.target.value })}
                    className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-900 dark:text-white"
                  >
                    <option value="prompt_pack">Prompt Pack</option>
                    <option value="onboarding_flow">Onboarding Flow</option>
                    <option value="vertical_demo">Vertical Demo</option>
                    <option value="feature_flag">Feature Flag</option>
                    <option value="pricing_test">Pricing Test</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Hypothesis</label>
                <input
                  value={newExp.hypothesis}
                  onChange={(e) => setNewExp({ ...newExp, hypothesis: e.target.value })}
                  className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-900 dark:text-white"
                  placeholder="What do you expect to happen?"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                <textarea
                  value={newExp.description}
                  onChange={(e) => setNewExp({ ...newExp, description: e.target.value })}
                  className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-900 dark:text-white"
                  rows={2}
                  placeholder="Describe the experiment"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => createExp.mutate(newExp)}
                  disabled={!newExp.experimentName || createExp.isPending}
                  className="px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50"
                >
                  {createExp.isPending ? 'Creating...' : 'Create'}
                </button>
                <button
                  onClick={() => setShowNewExperiment(false)}
                  className="px-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {expsLoading ? (
            <div className="text-center py-12 text-gray-500">Loading experiments...</div>
          ) : (expsData?.experiments ?? []).length === 0 ? (
            <div className="text-center py-12 text-gray-500 dark:text-gray-400">
              <FlaskConical className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p>No experiments yet</p>
              <p className="text-xs mt-1">Create an experiment to test product hypotheses</p>
            </div>
          ) : (
            <div className="space-y-3">
              {(expsData?.experiments ?? []).map((exp) => (
                <div key={exp.id} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{exp.experimentName}</h3>
                        <span className={clsx('px-2 py-0.5 rounded text-xs font-medium', STATE_COLORS[exp.state] || STATE_COLORS.draft)}>
                          {exp.state}
                        </span>
                        <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400">
                          {exp.experimentType}
                        </span>
                      </div>
                      {exp.hypothesis && (
                        <p className="text-sm text-gray-600 dark:text-gray-300 italic mb-1">"{exp.hypothesis}"</p>
                      )}
                      {exp.description && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">{exp.description}</p>
                      )}
                      <div className="flex gap-4 mt-2 text-xs text-gray-500 dark:text-gray-400">
                        {exp.pilotTenantIds.length > 0 && <span>{exp.pilotTenantIds.length} pilot tenants</span>}
                        <span>Created {new Date(exp.createdAt).toLocaleDateString()}</span>
                        {exp.startedAt && <span>Started {new Date(exp.startedAt).toLocaleDateString()}</span>}
                        {exp.concludedAt && <span>Concluded {new Date(exp.concludedAt).toLocaleDateString()}</span>}
                      </div>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      {exp.state === 'draft' && (
                        <button
                          onClick={() => updateExpState.mutate({ id: exp.id, state: 'active' })}
                          disabled={updateExpState.isPending}
                          className="flex items-center gap-1 px-3 py-1 text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 rounded-lg hover:bg-blue-200"
                        >
                          <Play className="w-3 h-3" /> Activate
                        </button>
                      )}
                      {exp.state === 'active' && (
                        <>
                          <button
                            onClick={() => updateExpState.mutate({ id: exp.id, state: 'paused' })}
                            disabled={updateExpState.isPending}
                            className="flex items-center gap-1 px-3 py-1 text-xs font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300 rounded-lg hover:bg-yellow-200"
                          >
                            Pause
                          </button>
                          <button
                            onClick={() => updateExpState.mutate({ id: exp.id, state: 'concluded' })}
                            disabled={updateExpState.isPending}
                            className="flex items-center gap-1 px-3 py-1 text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 rounded-lg hover:bg-green-200"
                          >
                            <CheckCircle className="w-3 h-3" /> Conclude
                          </button>
                        </>
                      )}
                      {exp.state === 'paused' && (
                        <button
                          onClick={() => updateExpState.mutate({ id: exp.id, state: 'active' })}
                          disabled={updateExpState.isPending}
                          className="flex items-center gap-1 px-3 py-1 text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 rounded-lg hover:bg-blue-200"
                        >
                          <Play className="w-3 h-3" /> Resume
                        </button>
                      )}
                    </div>
                  </div>

                  {exp.state === 'concluded' && Object.keys(exp.results).length > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
                      <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Results</p>
                      <pre className="text-xs bg-gray-50 dark:bg-gray-900 p-3 rounded-lg overflow-x-auto text-gray-600 dark:text-gray-400">
                        {JSON.stringify(exp.results, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: typeof Dna;
  label: string;
  value: number;
  sub: string;
  color: string;
}) {
  const bgColor = color === 'purple' ? 'bg-purple-100 dark:bg-purple-900/30' :
    color === 'blue' ? 'bg-blue-100 dark:bg-blue-900/30' :
    color === 'teal' ? 'bg-teal-100 dark:bg-teal-900/30' :
    'bg-orange-100 dark:bg-orange-900/30';
  const textColor = color === 'purple' ? 'text-purple-600 dark:text-purple-400' :
    color === 'blue' ? 'text-blue-600 dark:text-blue-400' :
    color === 'teal' ? 'text-teal-600 dark:text-teal-400' :
    'text-orange-600 dark:text-orange-400';

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
      <div className="flex items-center gap-3 mb-3">
        <div className={clsx('w-8 h-8 rounded-lg flex items-center justify-center', bgColor)}>
          <Icon className={clsx('w-4 h-4', textColor)} />
        </div>
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</span>
      </div>
      <p className="text-2xl font-bold text-gray-900 dark:text-white">{value.toLocaleString()}</p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{sub}</p>
    </div>
  );
}
