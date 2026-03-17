import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import {
  Globe, TrendingUp, TrendingDown, BarChart3, Lightbulb, BookOpen,
  CheckCircle2, XCircle, Loader2, Shield, ShieldCheck, ChevronDown,
  ChevronUp, Sparkles, ArrowUpRight, ArrowDownRight, Minus, Info,
} from 'lucide-react';

interface BenchmarkComparison {
  metricName: string;
  tenantValue: number;
  industryAvg: number;
  percentile25: number | null;
  percentile50: number | null;
  percentile75: number | null;
  percentileRank: string;
  sampleSize: number;
}

interface GlobalPattern {
  id: string;
  patternType: string;
  title: string;
  description: string;
  industryVertical: string | null;
  confidenceScore: number;
  sampleSize: number;
  impactEstimate: string | null;
  createdAt: string;
}

interface PromptPattern {
  id: string;
  promptCategory: string;
  industryVertical: string | null;
  patternDescription: string;
  examplePrompt: string | null;
  effectivenessScore: number;
  sampleSize: number;
  createdAt: string;
}

interface NetworkRecommendation {
  id: string;
  title: string;
  description: string;
  recommendationType: string;
  industryVertical: string | null;
  estimatedImpact: string | null;
  confidenceScore: number;
  status: string;
  createdAt: string;
}

interface GinParticipation {
  ginParticipation: boolean;
  ginOptedInAt: string | null;
  ginDataUsageAccepted: boolean;
}

type TabType = 'benchmarks' | 'best-practices' | 'recommendations' | 'settings';

const METRIC_LABELS: Record<string, string> = {
  booking_conversion_rate: 'Booking Conversion Rate',
  avg_call_duration_seconds: 'Avg Call Duration',
  avg_quality_score: 'Quality Score',
  call_completion_rate: 'Call Completion Rate',
  escalation_rate: 'Escalation Rate',
};

const PATTERN_TYPE_LABELS: Record<string, string> = {
  call_flow: 'Call Flow',
  scheduling: 'Scheduling',
  objection_handling: 'Objection Handling',
  lead_qualification: 'Lead Qualification',
  booking_optimization: 'Booking Optimization',
  follow_up_timing: 'Follow-up Timing',
  prompt_structure: 'Prompt Structure',
};

function formatMetricValue(name: string, value: number): string {
  if (name.includes('rate') || name.includes('conversion')) return `${(value * 100).toFixed(1)}%`;
  if (name.includes('duration') || name.includes('seconds')) return `${Math.round(value)}s`;
  if (name.includes('score')) return value.toFixed(1);
  return value.toFixed(2);
}

function rankColor(rank: string): string {
  if (rank === 'top_25') return 'text-green-600 dark:text-green-400';
  if (rank === 'above_average') return 'text-blue-600 dark:text-blue-400';
  if (rank === 'below_average') return 'text-red-600 dark:text-red-400';
  return 'text-text-secondary';
}

function rankLabel(rank: string): string {
  if (rank === 'top_25') return 'Top 25%';
  if (rank === 'above_average') return 'Above Average';
  if (rank === 'below_average') return 'Below Average';
  return 'Average';
}

function RankIcon({ rank }: { rank: string }) {
  if (rank === 'top_25' || rank === 'above_average') return <ArrowUpRight className="h-4 w-4" />;
  if (rank === 'below_average') return <ArrowDownRight className="h-4 w-4" />;
  return <Minus className="h-4 w-4" />;
}

function confidenceBadge(score: number): string {
  if (score >= 0.8) return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  if (score >= 0.5) return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
  return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
}

export default function GlobalIntelligence() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabType>('benchmarks');
  const [expandedPattern, setExpandedPattern] = useState<string | null>(null);
  const [expandedRec, setExpandedRec] = useState<string | null>(null);

  const { data: benchmarkData, isLoading: benchmarkLoading } = useQuery({
    queryKey: ['gin-benchmarks'],
    queryFn: () => api.get<{ industry: string; comparisons: BenchmarkComparison[] }>('/gin/benchmarks'),
    enabled: tab === 'benchmarks',
  });

  const { data: patternsData, isLoading: patternsLoading } = useQuery({
    queryKey: ['gin-patterns'],
    queryFn: () => api.get<{ patterns: GlobalPattern[]; total: number }>('/gin/patterns'),
    enabled: tab === 'best-practices',
  });

  const { data: promptPatternsData } = useQuery({
    queryKey: ['gin-prompt-patterns'],
    queryFn: () => api.get<{ patterns: PromptPattern[] }>('/gin/prompt-patterns'),
    enabled: tab === 'best-practices',
  });

  const { data: recsData, isLoading: recsLoading } = useQuery({
    queryKey: ['gin-recommendations'],
    queryFn: () => api.get<{ recommendations: NetworkRecommendation[]; total: number }>('/gin/recommendations'),
    enabled: tab === 'recommendations',
  });

  const { data: participation, isLoading: participationLoading } = useQuery({
    queryKey: ['gin-participation'],
    queryFn: () => api.get<GinParticipation>('/gin/participation'),
  });

  const participationMutation = useMutation({
    mutationFn: (data: { participate: boolean; acceptDataUsage: boolean }) =>
      api.post<GinParticipation>('/gin/participation', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gin-participation'] });
    },
  });

  const recStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'applied' | 'dismissed' }) =>
      api.post<{ recommendation: NetworkRecommendation }>(`/gin/recommendations/${id}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gin-recommendations'] });
    },
  });

  const comparisons = benchmarkData?.comparisons ?? [];
  const patterns = patternsData?.patterns ?? [];
  const promptPatterns = promptPatternsData?.patterns ?? [];
  const recommendations = recsData?.recommendations ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
            <Globe className="h-6 w-6 text-primary" />
            Global Intelligence Network
          </h1>
          <p className="text-sm text-text-secondary mt-1">
            Anonymized cross-platform insights and industry benchmarks
          </p>
        </div>
        {participation && (
          <div className="flex items-center gap-2">
            {participation.ginParticipation ? (
              <span className="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400 font-medium bg-green-100 dark:bg-green-900/30 px-3 py-1.5 rounded-lg">
                <ShieldCheck className="h-4 w-4" />
                Participating
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-sm text-text-secondary font-medium bg-surface border border-border px-3 py-1.5 rounded-lg">
                <Shield className="h-4 w-4" />
                Not Participating
              </span>
            )}
          </div>
        )}
      </div>

      <div className="border-b border-border">
        <div className="flex gap-0">
          {([
            { key: 'benchmarks', label: 'Industry Benchmarks', icon: BarChart3 },
            { key: 'best-practices', label: 'Best Practices Library', icon: BookOpen },
            { key: 'recommendations', label: 'Recommendations', icon: Lightbulb },
            { key: 'settings', label: 'Participation Settings', icon: Shield },
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

      {tab === 'benchmarks' && (
        <div className="space-y-4">
          {benchmarkData?.industry && (
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <Info className="h-4 w-4" />
              Comparing your metrics against <span className="font-medium text-text-primary capitalize">{benchmarkData.industry.replace(/_/g, ' ')}</span> industry averages
            </div>
          )}

          {benchmarkLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : comparisons.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-12 text-center">
              <BarChart3 className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-text-secondary font-medium">No benchmark data available yet</p>
              <p className="text-sm text-text-secondary mt-1">
                Benchmarks are generated from anonymized data across all participating tenants
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {comparisons.map((comp) => (
                <div key={comp.metricName} className="bg-surface border border-border rounded-xl p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium text-text-secondary">
                      {METRIC_LABELS[comp.metricName] || comp.metricName.replace(/_/g, ' ')}
                    </h3>
                    <span className={`flex items-center gap-1 text-xs font-medium ${rankColor(comp.percentileRank)}`}>
                      <RankIcon rank={comp.percentileRank} />
                      {rankLabel(comp.percentileRank)}
                    </span>
                  </div>
                  <div className="flex items-end gap-3 mb-3">
                    <div>
                      <p className="text-2xl font-bold text-text-primary">
                        {formatMetricValue(comp.metricName, comp.tenantValue)}
                      </p>
                      <p className="text-xs text-text-secondary">Your Value</p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-medium text-text-secondary">
                        {formatMetricValue(comp.metricName, comp.industryAvg)}
                      </p>
                      <p className="text-xs text-text-secondary">Industry Avg</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-text-secondary">
                    <span>Based on {comp.sampleSize} organizations</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'best-practices' && (
        <div className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-text-primary mb-3 flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              Discovered Patterns
            </h2>

            {patternsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : patterns.length === 0 ? (
              <div className="bg-surface border border-border rounded-xl p-12 text-center">
                <BookOpen className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
                <p className="text-text-secondary font-medium">No patterns discovered yet</p>
                <p className="text-sm text-text-secondary mt-1">
                  The platform analyzes anonymized data to discover high-performing patterns
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {patterns.map((pattern) => {
                  const isExpanded = expandedPattern === pattern.id;
                  return (
                    <div key={pattern.id} className="bg-surface border border-border rounded-xl shadow-sm hover:shadow-md transition-shadow">
                      <div
                        className="px-5 py-4 cursor-pointer"
                        onClick={() => setExpandedPattern(isExpanded ? null : pattern.id)}
                      >
                        <div className="flex items-start gap-4">
                          <div className="p-2.5 rounded-lg shrink-0 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                            <Sparkles className="h-5 w-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="text-sm font-semibold text-text-primary">{pattern.title}</h3>
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
                                {PATTERN_TYPE_LABELS[pattern.patternType] || pattern.patternType.replace(/_/g, ' ')}
                              </span>
                              {pattern.industryVertical && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400 capitalize">
                                  {pattern.industryVertical.replace(/_/g, ' ')}
                                </span>
                              )}
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${confidenceBadge(pattern.confidenceScore)}`}>
                                {Math.round(pattern.confidenceScore * 100)}% confidence
                              </span>
                            </div>
                            {pattern.impactEstimate && (
                              <p className="text-xs text-text-secondary mt-1 flex items-center gap-1">
                                <TrendingUp className="h-3 w-3" />
                                {pattern.impactEstimate}
                              </p>
                            )}
                          </div>
                          <div className="shrink-0">
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
                          <p className="text-sm text-text-secondary leading-relaxed">{pattern.description}</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {promptPatterns.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-text-primary mb-3 flex items-center gap-2">
                <BookOpen className="h-5 w-5 text-primary" />
                Effective Prompt Patterns
              </h2>
              <div className="space-y-3">
                {promptPatterns.map((pp) => (
                  <div key={pp.id} className="bg-surface border border-border rounded-xl p-5">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400 capitalize">
                        {pp.promptCategory.replace(/_/g, ' ')}
                      </span>
                      {pp.industryVertical && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400 capitalize">
                          {pp.industryVertical.replace(/_/g, ' ')}
                        </span>
                      )}
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${confidenceBadge(pp.effectivenessScore)}`}>
                        {Math.round(pp.effectivenessScore * 100)}% effective
                      </span>
                    </div>
                    <p className="text-sm text-text-primary">{pp.patternDescription}</p>
                    {pp.examplePrompt && (
                      <div className="mt-3 bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3">
                        <p className="text-xs text-text-secondary font-medium mb-1">Example Structure</p>
                        <p className="text-sm text-text-primary font-mono whitespace-pre-wrap">{pp.examplePrompt}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'recommendations' && (
        <div className="space-y-4">
          {recsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : recommendations.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-12 text-center">
              <Lightbulb className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-text-secondary font-medium">No recommendations yet</p>
              <p className="text-sm text-text-secondary mt-1">
                {participation?.ginParticipation
                  ? 'Recommendations will appear as the platform discovers patterns relevant to your operations'
                  : 'Enable GIN participation in Settings to receive personalized recommendations'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {recommendations.map((rec) => {
                const isExpanded = expandedRec === rec.id;
                return (
                  <div key={rec.id} className="bg-surface border border-border rounded-xl shadow-sm hover:shadow-md transition-shadow">
                    <div
                      className="px-5 py-4 cursor-pointer"
                      onClick={() => setExpandedRec(isExpanded ? null : rec.id)}
                    >
                      <div className="flex items-start gap-4">
                        <div className="p-2.5 rounded-lg shrink-0 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                          <Lightbulb className="h-5 w-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-sm font-semibold text-text-primary">{rec.title}</h3>
                            {rec.industryVertical && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400 capitalize">
                                {rec.industryVertical.replace(/_/g, ' ')}
                              </span>
                            )}
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${confidenceBadge(rec.confidenceScore)}`}>
                              {Math.round(rec.confidenceScore * 100)}% confidence
                            </span>
                          </div>
                          {rec.estimatedImpact && (
                            <p className="text-xs text-text-secondary mt-1 flex items-center gap-1">
                              <TrendingUp className="h-3 w-3" />
                              {rec.estimatedImpact}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {rec.status === 'pending' && (
                            <>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  recStatusMutation.mutate({ id: rec.id, status: 'applied' });
                                }}
                                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-green-700 bg-green-100 hover:bg-green-200 dark:text-green-400 dark:bg-green-900/30 dark:hover:bg-green-900/50 rounded-lg transition-colors"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Apply
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  recStatusMutation.mutate({ id: rec.id, status: 'dismissed' });
                                }}
                                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover rounded-lg transition-colors"
                              >
                                <XCircle className="h-3.5 w-3.5" />
                                Dismiss
                              </button>
                            </>
                          )}
                          {rec.status === 'applied' && (
                            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400 font-medium">
                              <CheckCircle2 className="h-3.5 w-3.5" /> Applied
                            </span>
                          )}
                          {rec.status === 'dismissed' && (
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
                        <p className="text-sm text-text-secondary leading-relaxed">{rec.description}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'settings' && (
        <div className="max-w-2xl space-y-6">
          <div className="bg-surface border border-border rounded-xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-primary/10 text-primary">
                <Globe className="h-6 w-6" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-text-primary">Global Intelligence Network Participation</h2>
                <p className="text-sm text-text-secondary">Control how your anonymized data contributes to platform-wide insights</p>
              </div>
            </div>

            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-6">
              <h3 className="text-sm font-medium text-blue-900 dark:text-blue-300 mb-2">Data Usage Policy</h3>
              <ul className="text-sm text-blue-800 dark:text-blue-300 space-y-1.5">
                <li>Your data is fully anonymized before aggregation - no tenant-identifying information is ever shared</li>
                <li>All personally identifiable information (PII) is redacted before processing</li>
                <li>Only aggregate statistical patterns are derived - individual conversations are never exposed</li>
                <li>You can opt out at any time - your data will be excluded from future aggregation runs</li>
                <li>Participation enables access to industry benchmarks and network-sourced recommendations</li>
              </ul>
            </div>

            {participationLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {participation?.ginParticipation ? 'Currently participating' : 'Not currently participating'}
                  </p>
                  {participation?.ginOptedInAt && (
                    <p className="text-xs text-text-secondary mt-0.5">
                      Opted in on {new Date(participation.ginOptedInAt).toLocaleDateString()}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => {
                    const newState = !participation?.ginParticipation;
                    participationMutation.mutate({
                      participate: newState,
                      acceptDataUsage: newState,
                    });
                  }}
                  disabled={participationMutation.isPending}
                  className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 ${
                    participation?.ginParticipation
                      ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
                      : 'bg-primary hover:bg-primary-hover text-white'
                  }`}
                >
                  {participationMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : participation?.ginParticipation ? (
                    <Shield className="h-4 w-4" />
                  ) : (
                    <ShieldCheck className="h-4 w-4" />
                  )}
                  {participation?.ginParticipation ? 'Opt Out' : 'Opt In & Accept Policy'}
                </button>
              </div>
            )}
          </div>

          <div className="bg-surface border border-border rounded-xl p-6">
            <h3 className="text-sm font-semibold text-text-primary mb-3">What You Get</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex items-start gap-3">
                <BarChart3 className="h-5 w-5 text-primary mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-text-primary">Industry Benchmarks</p>
                  <p className="text-xs text-text-secondary">Compare your metrics against anonymized industry averages</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <BookOpen className="h-5 w-5 text-primary mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-text-primary">Best Practices Library</p>
                  <p className="text-xs text-text-secondary">Access proven patterns discovered across the platform</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Lightbulb className="h-5 w-5 text-primary mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-text-primary">Smart Recommendations</p>
                  <p className="text-xs text-text-secondary">Receive actionable suggestions based on global patterns</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <TrendingUp className="h-5 w-5 text-primary mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-text-primary">Network Effect</p>
                  <p className="text-xs text-text-secondary">Every participant improves insights for all others</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
