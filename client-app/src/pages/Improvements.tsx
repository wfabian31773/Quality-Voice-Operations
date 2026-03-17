import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import {
  Lightbulb, TrendingUp, Check, XCircle, Clock,
  BarChart3, ChevronDown, ChevronUp, ArrowRight,
} from 'lucide-react';

interface Agent {
  id: string;
  name: string;
}

interface ImprovementSuggestion {
  id: string;
  agentId: string;
  status: 'pending' | 'accepted' | 'dismissed';
  weaknessCategory: string;
  weaknessDescription: string;
  currentPromptSection: string;
  suggestedPromptSection: string;
  rationale: string;
  simulationScoreBefore: number | null;
  simulationScoreAfter: number | null;
  createdAt: string;
}

interface ImprovementVelocity {
  totalGenerated: number;
  totalAccepted: number;
  totalDismissed: number;
  totalPending: number;
  acceptanceRate: number;
  avgQualityImprovement: number | null;
  weeklyTrend: {
    week: string;
    generated: number;
    accepted: number;
    dismissed: number;
    avgScoreBefore: number | null;
    avgScoreAfter: number | null;
  }[];
}

interface CategoryBreakdown {
  category: string;
  count: number;
  accepted: number;
  dismissed: number;
}

function categoryLabel(cat: string): string {
  const labels: Record<string, string> = {
    prompt_structure: 'Prompt Structure',
    question_ordering: 'Question Ordering',
    objection_handling: 'Objection Handling',
    workflow_efficiency: 'Workflow Efficiency',
    tone: 'Tone',
    accuracy: 'Accuracy',
    resolution: 'Resolution',
  };
  return labels[cat] || cat;
}

function categoryColor(cat: string): string {
  const colors: Record<string, string> = {
    prompt_structure: 'bg-blue-500',
    question_ordering: 'bg-purple-500',
    objection_handling: 'bg-orange-500',
    workflow_efficiency: 'bg-cyan-500',
    tone: 'bg-pink-500',
    accuracy: 'bg-red-500',
    resolution: 'bg-amber-500',
  };
  return colors[cat] || 'bg-gray-500';
}

function categoryBadge(cat: string): string {
  const colors: Record<string, string> = {
    prompt_structure: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    question_ordering: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
    objection_handling: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
    workflow_efficiency: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
    tone: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
    accuracy: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    resolution: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  };
  return colors[cat] || 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400';
}

export default function Improvements() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [velocity, setVelocity] = useState<ImprovementVelocity | null>(null);
  const [categories, setCategories] = useState<CategoryBreakdown[]>([]);
  const [suggestions, setSuggestions] = useState<ImprovementSuggestion[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ agents: Agent[] }>('/agents?limit=100')
      .then((data) => {
        setAgents(data.agents || []);
      })
      .catch(() => {});
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const agentParam = selectedAgentId ? `&agentId=${selectedAgentId}` : '';
      const statusParam = statusFilter !== 'all' ? `&status=${statusFilter}` : '';

      const [velData, catData, sugData] = await Promise.all([
        api.get<{ velocity: ImprovementVelocity }>(`/improvements/velocity?days=90${agentParam}`),
        api.get<{ categories: CategoryBreakdown[] }>(`/improvements/categories?days=90${agentParam}`),
        api.get<{ suggestions: ImprovementSuggestion[] }>(`/improvements/suggestions?limit=50${agentParam}${statusParam}`),
      ]);

      setVelocity(velData.velocity);
      setCategories(catData.categories);
      setSuggestions(sugData.suggestions || []);
    } catch {
      setVelocity(null);
      setCategories([]);
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, [selectedAgentId, statusFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAccept = async (id: string) => {
    setActionLoading(id);
    try {
      await api.post(`/improvements/suggestions/${id}/accept`, {});
      fetchData();
    } catch { /* ignore */ }
    setActionLoading(null);
  };

  const handleDismiss = async (id: string) => {
    setActionLoading(id);
    try {
      await api.post(`/improvements/suggestions/${id}/dismiss`, {});
      fetchData();
    } catch { /* ignore */ }
    setActionLoading(null);
  };

  const maxCatCount = categories.length > 0 ? Math.max(...categories.map((c) => c.count)) : 1;

  if (loading && !velocity) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-heading">Continuous Improvement</h1>
          <p className="text-sm text-muted mt-1">Track AI-generated prompt improvements and their impact on call quality</p>
        </div>
        <select
          value={selectedAgentId}
          onChange={(e) => setSelectedAgentId(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-border bg-surface text-heading text-sm"
        >
          <option value="">All Agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-surface border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted text-sm mb-1">
            <Lightbulb className="h-4 w-4" />
            Generated
          </div>
          <p className="text-2xl font-bold text-heading">{velocity?.totalGenerated ?? 0}</p>
        </div>
        <div className="bg-surface border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted text-sm mb-1">
            <Check className="h-4 w-4 text-green-500" />
            Accepted
          </div>
          <p className="text-2xl font-bold text-green-600 dark:text-green-400">{velocity?.totalAccepted ?? 0}</p>
        </div>
        <div className="bg-surface border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted text-sm mb-1">
            <XCircle className="h-4 w-4 text-red-500" />
            Dismissed
          </div>
          <p className="text-2xl font-bold text-red-600 dark:text-red-400">{velocity?.totalDismissed ?? 0}</p>
        </div>
        <div className="bg-surface border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted text-sm mb-1">
            <Clock className="h-4 w-4 text-amber-500" />
            Pending
          </div>
          <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{velocity?.totalPending ?? 0}</p>
        </div>
        <div className="bg-surface border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted text-sm mb-1">
            <TrendingUp className="h-4 w-4 text-green-500" />
            Avg Improvement
          </div>
          <p className="text-2xl font-bold text-green-600 dark:text-green-400">
            {velocity?.avgQualityImprovement != null
              ? `+${velocity.avgQualityImprovement.toFixed(1)}`
              : '—'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-border rounded-lg p-4">
          <h2 className="font-semibold text-heading mb-4 flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            Weekly Trend
          </h2>
          {!velocity?.weeklyTrend?.length ? (
            <p className="text-sm text-muted text-center py-8">No trend data yet</p>
          ) : (
            <div className="space-y-2">
              {velocity.weeklyTrend.slice(0, 8).map((w) => (
                <div key={w.week} className="flex items-center gap-3">
                  <span className="text-xs text-muted w-20 flex-shrink-0">{w.week.slice(5)}</span>
                  <div className="flex-1 flex gap-1 h-5">
                    {w.generated > 0 && (
                      <div
                        className="bg-blue-400 rounded-sm"
                        style={{ width: `${(w.generated / Math.max(...velocity.weeklyTrend.map((t) => t.generated), 1)) * 100}%`, minWidth: '4px' }}
                        title={`Generated: ${w.generated}`}
                      />
                    )}
                    {w.accepted > 0 && (
                      <div
                        className="bg-green-500 rounded-sm"
                        style={{ width: `${(w.accepted / Math.max(...velocity.weeklyTrend.map((t) => t.generated), 1)) * 100}%`, minWidth: '4px' }}
                        title={`Accepted: ${w.accepted}`}
                      />
                    )}
                    {w.dismissed > 0 && (
                      <div
                        className="bg-red-400 rounded-sm"
                        style={{ width: `${(w.dismissed / Math.max(...velocity.weeklyTrend.map((t) => t.generated), 1)) * 100}%`, minWidth: '4px' }}
                        title={`Dismissed: ${w.dismissed}`}
                      />
                    )}
                  </div>
                  <span className="text-xs text-muted w-8 text-right">{w.generated}</span>
                </div>
              ))}
              <div className="flex gap-4 mt-2 text-[10px] text-muted">
                <span className="flex items-center gap-1"><span className="w-2 h-2 bg-blue-400 rounded-sm" /> Generated</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 bg-green-500 rounded-sm" /> Accepted</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 bg-red-400 rounded-sm" /> Dismissed</span>
              </div>
            </div>
          )}
        </div>

        <div className="bg-surface border border-border rounded-lg p-4">
          <h2 className="font-semibold text-heading mb-4">Weakness Categories</h2>
          {categories.length === 0 ? (
            <p className="text-sm text-muted text-center py-8">No category data yet</p>
          ) : (
            <div className="space-y-3">
              {categories.map((c) => (
                <div key={c.category}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-heading">{categoryLabel(c.category)}</span>
                    <div className="flex items-center gap-2 text-[10px] text-muted">
                      <span className="text-green-600 dark:text-green-400">{c.accepted} accepted</span>
                      <span className="text-red-500">{c.dismissed} dismissed</span>
                      <span>{c.count} total</span>
                    </div>
                  </div>
                  <div className="h-2 bg-surface-secondary rounded-full overflow-hidden">
                    <div
                      className={`h-full ${categoryColor(c.category)} rounded-full transition-all`}
                      style={{ width: `${(c.count / maxCatCount) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-surface border border-border rounded-lg">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-heading">All Suggestions</h2>
          <div className="flex gap-1">
            {['all', 'pending', 'accepted', 'dismissed'].map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-2.5 py-1 text-xs rounded-lg transition ${
                  statusFilter === s
                    ? 'bg-primary text-white'
                    : 'text-muted hover:bg-surface-secondary'
                }`}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {suggestions.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <Lightbulb className="h-10 w-10 text-muted mx-auto mb-3" />
            <p className="text-sm text-muted">No suggestions yet</p>
            <p className="text-xs text-muted mt-1">
              Improvement suggestions are generated automatically after low-scoring calls are detected and analyzed.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {suggestions.map((s) => (
              <div key={s.id}>
                <button
                  onClick={() => setExpandedId(expandedId === s.id ? null : s.id)}
                  className="w-full text-left px-4 py-3 hover:bg-surface-secondary/50 transition flex items-center gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${categoryBadge(s.weaknessCategory)}`}>
                        {categoryLabel(s.weaknessCategory)}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        s.status === 'accepted' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                          : s.status === 'dismissed' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                          : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                      }`}>
                        {s.status}
                      </span>
                      {s.simulationScoreBefore != null && s.simulationScoreAfter != null && (
                        <span className="text-[10px] text-green-600 dark:text-green-400 font-medium">
                          +{(s.simulationScoreAfter - s.simulationScoreBefore).toFixed(1)} predicted
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-heading line-clamp-1">{s.weaknessDescription}</p>
                  </div>
                  <span className="text-xs text-muted flex-shrink-0">
                    {new Date(s.createdAt).toLocaleDateString()}
                  </span>
                  {expandedId === s.id ? (
                    <ChevronUp className="h-4 w-4 text-muted flex-shrink-0" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted flex-shrink-0" />
                  )}
                </button>

                {expandedId === s.id && (
                  <div className="px-4 pb-4 space-y-3">
                    <div>
                      <p className="text-[10px] font-medium text-muted uppercase tracking-wider mb-1">Current Prompt Section</p>
                      <pre className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/10 rounded p-3 whitespace-pre-wrap max-h-32 overflow-auto">
                        {s.currentPromptSection}
                      </pre>
                    </div>
                    <div className="flex justify-center">
                      <ArrowRight className="h-4 w-4 text-muted rotate-90" />
                    </div>
                    <div>
                      <p className="text-[10px] font-medium text-muted uppercase tracking-wider mb-1">Suggested Improvement</p>
                      <pre className="text-xs text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/10 rounded p-3 whitespace-pre-wrap max-h-32 overflow-auto">
                        {s.suggestedPromptSection}
                      </pre>
                    </div>
                    <div>
                      <p className="text-[10px] font-medium text-muted uppercase tracking-wider mb-1">Rationale</p>
                      <p className="text-xs text-muted">{s.rationale}</p>
                    </div>

                    {s.simulationScoreBefore != null && s.simulationScoreAfter != null && (
                      <div className="flex items-center gap-4 bg-surface-secondary rounded-lg p-3">
                        <div className="text-center">
                          <p className="text-[10px] text-muted">Before</p>
                          <p className="text-lg font-bold text-red-500">{s.simulationScoreBefore.toFixed(1)}</p>
                        </div>
                        <TrendingUp className="h-5 w-5 text-green-500" />
                        <div className="text-center">
                          <p className="text-[10px] text-muted">After</p>
                          <p className="text-lg font-bold text-green-500">{s.simulationScoreAfter.toFixed(1)}</p>
                        </div>
                        <div className="ml-auto text-center">
                          <p className="text-[10px] text-muted">Impact</p>
                          <p className="text-lg font-bold text-green-500">+{(s.simulationScoreAfter - s.simulationScoreBefore).toFixed(1)}</p>
                        </div>
                      </div>
                    )}

                    {s.status === 'pending' && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleAccept(s.id)}
                          disabled={actionLoading === s.id}
                          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium bg-green-500 text-white rounded-lg hover:bg-green-600 transition disabled:opacity-50"
                        >
                          <Check className="h-4 w-4" />
                          {actionLoading === s.id ? 'Applying...' : 'Accept & Apply'}
                        </button>
                        <button
                          onClick={() => handleDismiss(s.id)}
                          disabled={actionLoading === s.id}
                          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium border border-border text-muted rounded-lg hover:bg-surface-secondary transition disabled:opacity-50"
                        >
                          <XCircle className="h-4 w-4" />
                          Dismiss
                        </button>
                      </div>
                    )}

                    {s.agentId && (
                      <button
                        onClick={() => navigate(`/agents/${s.agentId}/builder`)}
                        className="text-xs text-primary hover:text-primary/80 transition"
                      >
                        Open in Agent Builder
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {velocity && velocity.totalGenerated > 0 && (
        <div className="bg-surface border border-border rounded-lg p-4">
          <h2 className="font-semibold text-heading mb-3">Acceptance Rate</h2>
          <div className="flex items-center gap-4">
            <div className="flex-1 h-4 bg-surface-secondary rounded-full overflow-hidden">
              <div
                className="h-full bg-green-500 rounded-full transition-all"
                style={{ width: `${velocity.acceptanceRate * 100}%` }}
              />
            </div>
            <span className="text-sm font-bold text-heading">
              {(velocity.acceptanceRate * 100).toFixed(0)}%
            </span>
          </div>
          <p className="text-xs text-muted mt-1">
            {velocity.totalAccepted} of {velocity.totalGenerated} suggestions accepted
          </p>
        </div>
      )}
    </div>
  );
}
