import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { TrendingUp, AlertTriangle, History, RotateCcw, Star, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';

interface QualityTrend {
  date: string;
  avgScore: number;
  callCount: number;
  agentId: string;
  agentName: string;
}

interface LowestScoringCall {
  callSessionId: string;
  score: number;
  agentName: string;
  agentId: string;
  durationSeconds: number;
  scoredAt: string;
  summary: string;
  transcriptPreview: string;
}

interface PromptVersion {
  id: string;
  version: number;
  system_prompt: string;
  notes: string | null;
  created_by: string;
  created_at: string;
}

interface Agent {
  id: string;
  name: string;
}

export default function Quality() {
  const navigate = useNavigate();
  const [trends, setTrends] = useState<QualityTrend[]>([]);
  const [lowestScoring, setLowestScoring] = useState<LowestScoringCall[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [promptVersions, setPromptVersions] = useState<PromptVersion[]>([]);
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchQualityData = useCallback(async () => {
    try {
      const [qualityData, agentData] = await Promise.all([
        api.get<{ trends: QualityTrend[]; lowestScoring: LowestScoringCall[] }>('/analytics/quality'),
        api.get<{ agents: Agent[] }>('/agents?limit=100'),
      ]);
      setTrends(qualityData.trends);
      setLowestScoring(qualityData.lowestScoring);
      setAgents(agentData.agents);
      if (agentData.agents.length > 0 && !selectedAgentId) {
        setSelectedAgentId(agentData.agents[0].id);
      }
    } catch {
      setError('Failed to load quality data');
    } finally {
      setLoading(false);
    }
  }, [selectedAgentId]);

  useEffect(() => {
    fetchQualityData();
  }, [fetchQualityData]);

  useEffect(() => {
    if (!selectedAgentId) return;
    api
      .get<{ versions: PromptVersion[] }>(`/agents/${selectedAgentId}/prompt-versions`)
      .then((data) => setPromptVersions(data.versions))
      .catch(() => setPromptVersions([]));
  }, [selectedAgentId]);

  const handleRestore = async (agentId: string, version: number) => {
    try {
      await api.post(`/agents/${agentId}/prompt-versions/${version}/restore`, {});
      const data = await api.get<{ versions: PromptVersion[] }>(`/agents/${agentId}/prompt-versions`);
      setPromptVersions(data.versions);
    } catch {
      setError('Failed to restore prompt version');
    }
  };

  const dailyAvg = trends.reduce((acc, t) => {
    if (!acc[t.date]) {
      acc[t.date] = { totalScore: 0, totalCalls: 0 };
    }
    acc[t.date].totalScore += t.avgScore * t.callCount;
    acc[t.date].totalCalls += t.callCount;
    return acc;
  }, {} as Record<string, { totalScore: number; totalCalls: number }>);

  const dailyTrendData = Object.entries(dailyAvg)
    .map(([date, v]) => ({
      date,
      avgScore: v.totalCalls > 0 ? v.totalScore / v.totalCalls : 0,
      callCount: v.totalCalls,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-14);

  const overallAvg =
    dailyTrendData.length > 0
      ? dailyTrendData.reduce((sum, d) => sum + d.avgScore, 0) / dailyTrendData.length
      : 0;

  const totalScoredCalls = dailyTrendData.reduce((sum, d) => sum + d.callCount, 0);

  const maxScore = dailyTrendData.length > 0 ? Math.max(...dailyTrendData.map((d) => d.avgScore)) : 10;
  const barMax = Math.max(maxScore, 1);

  function scoreColor(score: number): string {
    if (score >= 8) return 'text-green-600 dark:text-green-400';
    if (score >= 6) return 'text-yellow-600 dark:text-yellow-400';
    return 'text-red-600 dark:text-red-400';
  }

  function scoreBgColor(score: number): string {
    if (score >= 8) return 'bg-green-500';
    if (score >= 6) return 'bg-yellow-500';
    return 'bg-red-500';
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-heading">Call Quality</h1>
        <p className="text-sm text-muted mt-1">Monitor AI agent performance and manage prompt versions</p>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-surface border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted text-sm mb-1">
            <Star className="h-4 w-4" />
            Avg Quality Score
          </div>
          <p className={`text-2xl font-bold ${scoreColor(overallAvg)}`}>
            {overallAvg > 0 ? overallAvg.toFixed(1) : '—'}<span className="text-sm text-muted">/10</span>
          </p>
        </div>
        <div className="bg-surface border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted text-sm mb-1">
            <TrendingUp className="h-4 w-4" />
            Calls Scored (14d)
          </div>
          <p className="text-2xl font-bold text-heading">{totalScoredCalls}</p>
        </div>
        <div className="bg-surface border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted text-sm mb-1">
            <AlertTriangle className="h-4 w-4" />
            Low Quality Calls
          </div>
          <p className="text-2xl font-bold text-red-600 dark:text-red-400">
            {lowestScoring.filter((c) => c.score < 5).length}
          </p>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-lg p-4">
        <h2 className="font-semibold text-heading mb-4">Quality Score Trend (14 days)</h2>
        {dailyTrendData.length === 0 ? (
          <p className="text-sm text-muted text-center py-8">No quality data yet. Scores appear after calls are processed.</p>
        ) : (
          <div className="flex items-end gap-1 h-40">
            {dailyTrendData.map((d) => (
              <div key={d.date} className="flex-1 flex flex-col items-center gap-1">
                <span className="text-xs text-muted">{d.avgScore.toFixed(1)}</span>
                <div
                  className={`w-full rounded-t ${scoreBgColor(d.avgScore)} transition-all`}
                  style={{ height: `${(d.avgScore / barMax) * 100}%`, minHeight: '4px' }}
                  title={`${d.date}: ${d.avgScore.toFixed(1)} avg (${d.callCount} calls)`}
                />
                <span className="text-[10px] text-muted truncate w-full text-center">
                  {d.date.slice(5)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="font-semibold text-heading">Lowest Scoring Calls</h2>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface-secondary">
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Score</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Agent</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase hidden sm:table-cell">Duration</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase hidden md:table-cell">Transcript Preview</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase hidden lg:table-cell">Scored</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Actions</th>
            </tr>
          </thead>
          <tbody>
            {lowestScoring.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-sm text-muted">
                  No scored calls yet
                </td>
              </tr>
            ) : (
              lowestScoring.slice(0, 10).map((call) => (
                <tr key={call.callSessionId} className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                  <td className="px-4 py-3">
                    <span className={`text-sm font-bold ${scoreColor(call.score)}`}>
                      {call.score.toFixed(1)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-heading">{call.agentName}</td>
                  <td className="px-4 py-3 text-sm text-muted hidden sm:table-cell">
                    {Math.floor(call.durationSeconds / 60)}m {call.durationSeconds % 60}s
                  </td>
                  <td className="px-4 py-3 text-sm text-muted hidden md:table-cell max-w-xs">
                    {call.transcriptPreview ? (
                      <div className="space-y-0.5 max-h-16 overflow-hidden">
                        {call.transcriptPreview.split('\n').slice(0, 3).map((line, i) => (
                          <p key={i} className="truncate text-xs">{line}</p>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs italic">{call.summary || '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted hidden lg:table-cell">
                    {new Date(call.scoredAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => navigate(`/calls?highlight=${call.callSessionId}`)}
                      className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors whitespace-nowrap"
                    >
                      <ExternalLink className="h-3 w-3" />
                      View Transcript
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <History className="h-5 w-5 text-muted" />
            <h2 className="font-semibold text-heading">Prompt Version History</h2>
          </div>
          <select
            value={selectedAgentId}
            onChange={(e) => setSelectedAgentId(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-border bg-surface text-heading text-sm"
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>

        {promptVersions.length === 0 ? (
          <p className="text-sm text-muted text-center py-8">
            No prompt versions archived yet. Edit an agent's system prompt to create version history.
          </p>
        ) : (
          <div className="space-y-2">
            {promptVersions.map((pv) => (
              <div key={pv.id} className="border border-border rounded-lg">
                <div
                  className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-surface-secondary/50"
                  onClick={() => setExpandedVersion(expandedVersion === pv.version ? null : pv.version)}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-mono font-medium text-heading">v{pv.version}</span>
                    <span className="text-xs text-muted">
                      {new Date(pv.created_at).toLocaleDateString()}
                    </span>
                    {pv.notes && (
                      <span className="text-xs text-muted italic">{pv.notes}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRestore(selectedAgentId, pv.version);
                      }}
                      className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 rounded transition-colors"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Restore
                    </button>
                    {expandedVersion === pv.version ? (
                      <ChevronUp className="h-4 w-4 text-muted" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted" />
                    )}
                  </div>
                </div>
                {expandedVersion === pv.version && (
                  <div className="px-4 pb-3 border-t border-border">
                    <pre className="text-xs text-muted bg-surface-secondary rounded p-3 mt-2 max-h-48 overflow-auto whitespace-pre-wrap">
                      {pv.system_prompt}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
