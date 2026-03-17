import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import {
  FlaskConical, Play, Plus, ChevronDown, ChevronRight, CheckCircle, XCircle,
  Clock, BarChart3, Eye, Trash2, Edit3, Users, Target, AlertTriangle,
  ArrowLeft, MessageSquare, Bot, User, Zap, RefreshCw,
} from 'lucide-react';

interface Agent {
  id: string;
  name: string;
  type: string;
}

interface CallerPersona {
  name: string;
  mood: string;
  background: string;
  speakingStyle: string;
  urgency: string;
}

interface ExpectedOutcomes {
  shouldBook: boolean;
  shouldEscalate: boolean;
  shouldResolve: boolean;
  expectedIntent: string;
  acceptableEndStates: string[];
}

interface Scenario {
  id: string;
  name: string;
  description: string | null;
  category: string;
  persona: CallerPersona;
  goals: string[];
  expectedOutcomes: ExpectedOutcomes;
  difficulty: string;
  maxTurns: number;
  isDefault: boolean;
}

interface CategoryBreakdown {
  category: string;
  total: number;
  passed: number;
  failed: number;
  avgScore: number;
}

interface AggregateScores {
  avgBookingSuccess: number;
  avgConversationCompletion: number;
  avgIntentResolution: number;
  avgToneAppropriateness: number;
  avgOverall: number;
  avgHelpfulness: number;
  avgAccuracy: number;
  avgTone: number;
  avgResolution: number;
  passRate: number;
  failureBreakdown: Record<string, number>;
  scoreDistribution: { bucket: string; count: number }[];
  categoryBreakdown: CategoryBreakdown[];
}

interface SimulationRun {
  id: string;
  agentId: string;
  name: string | null;
  status: string;
  totalScenarios: number;
  completedScenarios: number;
  failedScenarios: number;
  aggregateScores: AggregateScores | null;
  promptVersionLabel: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface TranscriptEntry {
  role: 'caller' | 'agent';
  content: string;
  turnNumber: number;
  timestamp: string;
}

interface SimulationScores {
  bookingSuccess: number;
  conversationCompletion: number;
  intentResolution: number;
  toneAppropriateness: number;
  overall: number;
  passed: boolean;
  scoringRationale: string;
}

interface ReasoningTraceEntry {
  turnNumber: number;
  intent: string;
  confidence: string;
  action: string;
  slots: Record<string, string>;
  reasoning: string;
}

interface SimulationResult {
  id: string;
  runId: string;
  scenarioId: string;
  status: string;
  transcript: TranscriptEntry[];
  scores: SimulationScores | null;
  reasoningTrace: ReasoningTraceEntry[];
  toolCalls: { turnNumber: number; toolName: string; args: Record<string, unknown>; result: string; success: boolean }[];
  outcome: string | null;
  failureReason: string | null;
  turnCount: number;
  durationMs: number | null;
}

interface ComparisonEntry {
  runId: string;
  promptVersionLabel: string | null;
  avgOverall: number;
  avgHelpfulness: number;
  avgTone: number;
  avgResolution: number;
  passRate: number;
  totalScenarios: number;
  completedScenarios: number;
  failedScenarios: number;
}

type View = 'dashboard' | 'run-detail' | 'replay' | 'scenario-editor' | 'compare';

const CATEGORIES = [
  { value: 'angry_customer', label: 'Angry Customer' },
  { value: 'emergency', label: 'Emergency Call' },
  { value: 'scheduling', label: 'Scheduling' },
  { value: 'lead_qualification', label: 'Lead Qualification' },
  { value: 'custom', label: 'Custom' },
];

const DIFFICULTIES = ['easy', 'medium', 'hard'];

export default function SimulationLab() {
  const [view, setView] = useState<View>('dashboard');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [runs, setRuns] = useState<SimulationRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runResults, setRunResults] = useState<SimulationResult[]>([]);
  const [selectedResult, setSelectedResult] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [selectedScenarioIds, setSelectedScenarioIds] = useState<string[]>([]);
  const [runName, setRunName] = useState('');
  const [promptVersionLabel, setPromptVersionLabel] = useState('');
  const [launching, setLaunching] = useState(false);

  const [editingScenario, setEditingScenario] = useState<Partial<Scenario> | null>(null);
  const [compareRunIds, setCompareRunIds] = useState<string[]>([]);
  const [comparisonData, setComparisonData] = useState<ComparisonEntry[]>([]);
  const [comparisonRuns, setComparisonRuns] = useState<SimulationRun[]>([]);

  const fetchData = useCallback(async () => {
    try {
      const [agentData, scenarioData, runData] = await Promise.all([
        api.get<{ agents: Agent[] }>('/agents?limit=100'),
        api.get<{ scenarios: Scenario[] }>('/simulations/scenarios'),
        api.get<{ runs: SimulationRun[] }>('/simulations/runs'),
      ]);
      setAgents(agentData.agents);
      setScenarios(scenarioData.scenarios);
      setRuns(runData.runs);
      if (agentData.agents.length > 0 && !selectedAgentId) {
        setSelectedAgentId(agentData.agents[0].id);
      }
    } catch {
      setError('Failed to load simulation data');
    } finally {
      setLoading(false);
    }
  }, [selectedAgentId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleLaunchRun = async () => {
    if (!selectedAgentId || selectedScenarioIds.length === 0) return;
    setLaunching(true);
    setError(null);
    try {
      await api.post('/simulations/runs', {
        agentId: selectedAgentId,
        scenarioIds: selectedScenarioIds,
        name: runName || undefined,
        promptVersionLabel: promptVersionLabel || undefined,
      });
      setSelectedScenarioIds([]);
      setRunName('');
      setPromptVersionLabel('');
      await fetchData();
    } catch {
      setError('Failed to launch simulation run');
    } finally {
      setLaunching(false);
    }
  };

  const handleViewRun = async (runId: string) => {
    setSelectedRunId(runId);
    try {
      const data = await api.get<{ results: SimulationResult[] }>(`/simulations/runs/${runId}/results`);
      setRunResults(data.results);
      setView('run-detail');
    } catch {
      setError('Failed to load run results');
    }
  };

  const handleViewReplay = (result: SimulationResult) => {
    setSelectedResult(result);
    setView('replay');
  };

  const handleSaveScenario = async () => {
    if (!editingScenario) return;
    setError(null);
    try {
      if (editingScenario.id) {
        await api.patch(`/simulations/scenarios/${editingScenario.id}`, editingScenario);
      } else {
        await api.post('/simulations/scenarios', editingScenario);
      }
      const data = await api.get<{ scenarios: Scenario[] }>('/simulations/scenarios');
      setScenarios(data.scenarios);
      setEditingScenario(null);
      setView('dashboard');
    } catch {
      setError('Failed to save scenario');
    }
  };

  const handleDeleteScenario = async (id: string) => {
    try {
      await api.delete(`/simulations/scenarios/${id}`);
      setScenarios((prev) => prev.filter((s) => s.id !== id));
    } catch {
      setError('Failed to delete scenario');
    }
  };

  const handleRefreshRun = async () => {
    if (!selectedRunId) return;
    try {
      const [runData, resultData] = await Promise.all([
        api.get<{ run: SimulationRun }>(`/simulations/runs/${selectedRunId}`),
        api.get<{ results: SimulationResult[] }>(`/simulations/runs/${selectedRunId}/results`),
      ]);
      setRuns((prev) => prev.map((r) => (r.id === selectedRunId ? runData.run : r)));
      setRunResults(resultData.results);
    } catch {
      setError('Failed to refresh run');
    }
  };

  const toggleScenario = (id: string) => {
    setSelectedScenarioIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  };

  const selectAllScenarios = () => {
    if (selectedScenarioIds.length === scenarios.length) {
      setSelectedScenarioIds([]);
    } else {
      setSelectedScenarioIds(scenarios.map((s) => s.id));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (view === 'replay' && selectedResult) {
    return <ReplayViewer result={selectedResult} scenarios={scenarios} onBack={() => setView('run-detail')} />;
  }

  if (view === 'run-detail' && selectedRunId) {
    const run = runs.find((r) => r.id === selectedRunId);
    return (
      <RunDetail
        run={run ?? null}
        results={runResults}
        scenarios={scenarios}
        agents={agents}
        onBack={() => { setView('dashboard'); setSelectedRunId(null); }}
        onViewReplay={handleViewReplay}
        onRefresh={handleRefreshRun}
      />
    );
  }

  if (view === 'scenario-editor') {
    return (
      <ScenarioEditor
        scenario={editingScenario}
        onUpdate={setEditingScenario}
        onSave={handleSaveScenario}
        onCancel={() => { setEditingScenario(null); setView('dashboard'); }}
        error={error}
      />
    );
  }

  if (view === 'compare') {
    return (
      <CompareView
        comparisonData={comparisonData}
        comparisonRuns={comparisonRuns}
        onBack={() => { setView('dashboard'); setCompareRunIds([]); setComparisonData([]); setComparisonRuns([]); }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-heading flex items-center gap-2">
          <FlaskConical className="h-6 w-6" />
          Simulation Lab
        </h1>
        <p className="text-sm text-muted mt-1">
          Test your AI agents against simulated conversations before deploying live
        </p>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      <div className="bg-surface border border-border rounded-lg p-4">
        <h2 className="font-semibold text-heading mb-4 flex items-center gap-2">
          <Play className="h-4 w-4" />
          Launch Simulation Run
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Agent</label>
            <select
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Run Name (optional)</label>
            <input
              value={runName}
              onChange={(e) => setRunName(e.target.value)}
              placeholder="e.g., Pre-deploy test v2.1"
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Prompt Version Label (optional)</label>
            <input
              value={promptVersionLabel}
              onChange={(e) => setPromptVersionLabel(e.target.value)}
              placeholder="e.g., v3-empathetic-tone"
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
            />
          </div>
        </div>

        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-muted">Scenarios</label>
            <button onClick={selectAllScenarios} className="text-xs text-primary hover:underline">
              {selectedScenarioIds.length === scenarios.length ? 'Deselect All' : 'Select All'}
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-60 overflow-y-auto">
            {scenarios.map((s) => (
              <label
                key={s.id}
                className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${
                  selectedScenarioIds.includes(s.id)
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedScenarioIds.includes(s.id)}
                  onChange={() => toggleScenario(s.id)}
                  className="mt-0.5"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-heading truncate">{s.name}</p>
                  <p className="text-xs text-muted">
                    {CATEGORIES.find((c) => c.value === s.category)?.label || s.category}
                    {' · '}
                    <span className={difficultyColor(s.difficulty)}>{s.difficulty}</span>
                  </p>
                </div>
              </label>
            ))}
          </div>
        </div>

        <button
          onClick={handleLaunchRun}
          disabled={launching || !selectedAgentId || selectedScenarioIds.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Play className="h-4 w-4" />
          {launching ? 'Launching...' : `Run ${selectedScenarioIds.length} Scenario${selectedScenarioIds.length !== 1 ? 's' : ''}`}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-border rounded-lg">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="font-semibold text-heading flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Recent Runs
            </h2>
            {compareRunIds.length >= 2 && (
              <button
                onClick={async () => {
                  try {
                    const result = await api.post<{ comparison: ComparisonEntry[]; runs: SimulationRun[] }>(
                      '/simulations/runs/compare',
                      { runIds: compareRunIds },
                    );
                    setComparisonData(result.comparison);
                    setComparisonRuns(result.runs);
                    setView('compare');
                  } catch {
                    setError('Failed to compare runs');
                  }
                }}
                className="text-xs bg-primary text-white px-3 py-1 rounded hover:bg-primary/90"
              >
                Compare ({compareRunIds.length})
              </button>
            )}
          </div>
          <div className="divide-y divide-border">
            {runs.length === 0 ? (
              <p className="px-4 py-8 text-sm text-muted text-center">No simulation runs yet</p>
            ) : (
              runs.filter(r => r.status === 'completed').length < 2 ? (
                runs.slice(0, 10).map((run) => (
                  <div
                    key={run.id}
                    className="px-4 py-3 hover:bg-surface-secondary/50 cursor-pointer transition-colors"
                    onClick={() => handleViewRun(run.id)}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-heading">
                        {run.name || `Run ${run.id.slice(0, 8)}`}
                      </span>
                      <StatusBadge status={run.status} />
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted">
                      <span>{run.totalScenarios} scenarios</span>
                      {run.aggregateScores && (
                        <>
                          <span className={scoreColor(run.aggregateScores.avgOverall)}>
                            {run.aggregateScores.avgOverall.toFixed(1)}/10
                          </span>
                          <span>{run.aggregateScores.passRate.toFixed(0)}% pass</span>
                        </>
                      )}
                      <span>{new Date(run.createdAt).toLocaleDateString()}</span>
                    </div>
                    {run.promptVersionLabel && (
                      <span className="text-xs text-primary mt-1 inline-block">{run.promptVersionLabel}</span>
                    )}
                  </div>
                ))
              ) : (
                runs.slice(0, 10).map((run) => (
                  <div
                    key={run.id}
                    className="px-4 py-3 hover:bg-surface-secondary/50 cursor-pointer transition-colors flex items-start gap-2"
                  >
                    {run.status === 'completed' && (
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={compareRunIds.includes(run.id)}
                        onChange={(e) => {
                          e.stopPropagation();
                          setCompareRunIds(prev =>
                            prev.includes(run.id) ? prev.filter(id => id !== run.id) : [...prev, run.id]
                          );
                        }}
                      />
                    )}
                    <div className="flex-1" onClick={() => handleViewRun(run.id)}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium text-heading">
                          {run.name || `Run ${run.id.slice(0, 8)}`}
                        </span>
                        <StatusBadge status={run.status} />
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted">
                        <span>{run.totalScenarios} scenarios</span>
                        {run.aggregateScores && (
                          <>
                            <span className={scoreColor(run.aggregateScores.avgOverall)}>
                              {run.aggregateScores.avgOverall.toFixed(1)}/10
                            </span>
                            <span>{run.aggregateScores.passRate.toFixed(0)}% pass</span>
                          </>
                        )}
                        <span>{new Date(run.createdAt).toLocaleDateString()}</span>
                      </div>
                      {run.promptVersionLabel && (
                        <span className="text-xs text-primary mt-1 inline-block">{run.promptVersionLabel}</span>
                      )}
                    </div>
                  </div>
                ))
              )
            )}
          </div>
        </div>

        <div className="bg-surface border border-border rounded-lg">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="font-semibold text-heading flex items-center gap-2">
              <Target className="h-4 w-4" />
              Scenarios
            </h2>
            <button
              onClick={() => {
                setEditingScenario({
                  name: '',
                  description: '',
                  category: 'custom',
                  persona: { name: '', mood: 'neutral', background: '', speakingStyle: '', urgency: 'medium' },
                  goals: [''],
                  expectedOutcomes: {
                    shouldBook: false, shouldEscalate: false, shouldResolve: true,
                    expectedIntent: 'general_inquiry', acceptableEndStates: [],
                  },
                  difficulty: 'medium',
                  maxTurns: 15,
                });
                setView('scenario-editor');
              }}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 rounded transition-colors"
            >
              <Plus className="h-3 w-3" />
              New Scenario
            </button>
          </div>
          <div className="divide-y divide-border max-h-96 overflow-y-auto">
            {scenarios.map((s) => (
              <div key={s.id} className="px-4 py-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-heading">{s.name}</span>
                  <div className="flex items-center gap-1">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${difficultyBg(s.difficulty)}`}>
                      {s.difficulty}
                    </span>
                    {!s.isDefault && (
                      <>
                        <button
                          onClick={() => { setEditingScenario(s); setView('scenario-editor'); }}
                          className="p-1 text-muted hover:text-heading"
                        >
                          <Edit3 className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => handleDeleteScenario(s.id)}
                          className="p-1 text-muted hover:text-red-500"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted">
                  {CATEGORIES.find((c) => c.value === s.category)?.label || s.category}
                  {s.description && ` — ${s.description}`}
                </p>
                <div className="flex items-center gap-2 mt-1 text-xs text-muted">
                  <Users className="h-3 w-3" />
                  <span>{s.persona.name} ({s.persona.mood})</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function RunDetail({
  run,
  results,
  scenarios,
  agents,
  onBack,
  onViewReplay,
  onRefresh,
}: {
  run: SimulationRun | null;
  results: SimulationResult[];
  scenarios: Scenario[];
  agents: Agent[];
  onBack: () => void;
  onViewReplay: (result: SimulationResult) => void;
  onRefresh: () => void;
}) {
  if (!run) return null;

  const agent = agents.find((a) => a.id === run.agentId);
  const agg = run.aggregateScores;
  const isRunning = run.status === 'running' || run.status === 'pending';

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="p-1 hover:bg-surface-secondary rounded">
          <ArrowLeft className="h-5 w-5 text-muted" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-heading">
            {run.name || `Run ${run.id.slice(0, 8)}`}
          </h1>
          <p className="text-sm text-muted">
            Agent: {agent?.name || 'Unknown'} · {run.totalScenarios} scenarios
            {run.promptVersionLabel && ` · ${run.promptVersionLabel}`}
          </p>
        </div>
        <StatusBadge status={run.status} />
        {isRunning && (
          <button
            onClick={onRefresh}
            className="flex items-center gap-1 px-2 py-1 text-xs text-primary hover:bg-primary/10 rounded"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        )}
      </div>

      {agg && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <ScoreCard label="Overall" value={agg.avgOverall} />
            <ScoreCard label="Booking Success" value={agg.avgBookingSuccess} />
            <ScoreCard label="Completion" value={agg.avgConversationCompletion} />
            <ScoreCard label="Intent Resolution" value={agg.avgIntentResolution} />
            <ScoreCard label="Tone" value={agg.avgToneAppropriateness} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-surface border border-border rounded-lg p-4">
              <h3 className="text-sm font-semibold text-heading mb-3">Pass/Fail Rate</h3>
              <div className="flex items-center gap-4">
                <div className="relative w-24 h-24">
                  <svg className="w-24 h-24 -rotate-90" viewBox="0 0 36 36">
                    <path
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      fill="none" stroke="#e5e7eb" strokeWidth="3"
                    />
                    <path
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      fill="none" stroke={agg.passRate >= 80 ? '#22c55e' : agg.passRate >= 50 ? '#eab308' : '#ef4444'}
                      strokeWidth="3" strokeDasharray={`${agg.passRate}, 100`}
                    />
                  </svg>
                  <span className="absolute inset-0 flex items-center justify-center text-lg font-bold text-heading">
                    {agg.passRate.toFixed(0)}%
                  </span>
                </div>
                <div>
                  <p className="text-sm text-muted">
                    <span className="text-green-600 font-medium">{results.filter((r) => r.outcome === 'passed').length} passed</span>
                    {' / '}
                    <span className="text-red-600 font-medium">{results.filter((r) => r.outcome === 'failed' || r.status === 'failed').length} failed</span>
                    {' / '}
                    <span className="text-muted">{run.totalScenarios} total</span>
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-surface border border-border rounded-lg p-4">
              <h3 className="text-sm font-semibold text-heading mb-3">Score Distribution</h3>
              <div className="flex items-end gap-1 h-20">
                {agg.scoreDistribution.map((d) => (
                  <div key={d.bucket} className="flex-1 flex flex-col items-center gap-1">
                    <span className="text-[10px] text-muted">{d.count}</span>
                    <div
                      className="w-full rounded-t bg-primary/70 transition-all"
                      style={{
                        height: `${Math.max(4, (d.count / Math.max(1, ...agg.scoreDistribution.map((x) => x.count))) * 100)}%`,
                        minHeight: '4px',
                      }}
                    />
                    <span className="text-[10px] text-muted">{d.bucket}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {agg.categoryBreakdown && agg.categoryBreakdown.length > 0 && (
            <div className="bg-surface border border-border rounded-lg p-4">
              <h3 className="text-sm font-semibold text-heading mb-3 flex items-center gap-2">
                <Target className="h-4 w-4" />
                Pass/Fail by Scenario Type
              </h3>
              <div className="space-y-3">
                {agg.categoryBreakdown.map((cat) => (
                  <div key={cat.category}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="font-medium text-heading capitalize">{cat.category.replace(/_/g, ' ')}</span>
                      <span className="text-xs text-muted">{cat.avgScore.toFixed(1)}/10 avg</span>
                    </div>
                    <div className="flex h-4 rounded-full overflow-hidden bg-surface-secondary">
                      {cat.passed > 0 && (
                        <div
                          className="bg-green-500 transition-all"
                          style={{ width: `${(cat.passed / cat.total) * 100}%` }}
                          title={`${cat.passed} passed`}
                        />
                      )}
                      {cat.failed > 0 && (
                        <div
                          className="bg-red-500 transition-all"
                          style={{ width: `${(cat.failed / cat.total) * 100}%` }}
                          title={`${cat.failed} failed`}
                        />
                      )}
                    </div>
                    <div className="flex gap-3 text-xs text-muted mt-1">
                      <span className="text-green-600">{cat.passed} passed</span>
                      <span className="text-red-600">{cat.failed} failed</span>
                      <span>{cat.total} total</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {Object.keys(agg.failureBreakdown).length > 0 && (
            <div className="bg-surface border border-border rounded-lg p-4">
              <h3 className="text-sm font-semibold text-heading mb-3 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-red-500" />
                Failure Breakdown
              </h3>
              <div className="space-y-2">
                {Object.entries(agg.failureBreakdown).map(([reason, count]) => (
                  <div key={reason} className="flex items-center justify-between text-sm">
                    <span className="text-muted truncate max-w-md">{reason}</span>
                    <span className="text-red-600 font-medium">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="font-semibold text-heading">Individual Results</h2>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface-secondary">
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Scenario</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Status</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase hidden sm:table-cell">Score</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase hidden md:table-cell">Turns</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase hidden lg:table-cell">Duration</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Actions</th>
            </tr>
          </thead>
          <tbody>
            {results.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-sm text-muted">
                  {isRunning ? 'Simulation is running...' : 'No results yet'}
                </td>
              </tr>
            ) : (
              results.map((r) => {
                const scenario = scenarios.find((s) => s.id === r.scenarioId);
                return (
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                    <td className="px-4 py-3 text-sm text-heading">
                      {scenario?.name || r.scenarioId.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3">
                      {r.outcome === 'passed' ? (
                        <span className="flex items-center gap-1 text-xs text-green-600"><CheckCircle className="h-3 w-3" /> Pass</span>
                      ) : r.status === 'failed' || r.outcome === 'failed' ? (
                        <span className="flex items-center gap-1 text-xs text-red-600"><XCircle className="h-3 w-3" /> Fail</span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-muted"><Clock className="h-3 w-3" /> {r.status}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm hidden sm:table-cell">
                      {r.scores ? (
                        <span className={scoreColor(r.scores.overall)}>{r.scores.overall.toFixed(1)}</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted hidden md:table-cell">{r.turnCount}</td>
                    <td className="px-4 py-3 text-sm text-muted hidden lg:table-cell">
                      {r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {r.transcript.length > 0 && (
                        <button
                          onClick={() => onViewReplay(r)}
                          className="flex items-center gap-1 text-xs text-primary hover:text-primary/80"
                        >
                          <Eye className="h-3 w-3" /> Replay
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReplayViewer({
  result,
  scenarios,
  onBack,
}: {
  result: SimulationResult;
  scenarios: Scenario[];
  onBack: () => void;
}) {
  const [currentTurn, setCurrentTurn] = useState(0);
  const [showReasoning, setShowReasoning] = useState(false);
  const scenario = scenarios.find((s) => s.id === result.scenarioId);
  const transcript = result.transcript;

  const visibleMessages = transcript.slice(0, currentTurn + 1);
  const currentTraceEntry = result.reasoningTrace.find((t) => t.turnNumber === transcript[currentTurn]?.turnNumber);
  const currentToolCall = result.toolCalls.find((t) => t.turnNumber === transcript[currentTurn]?.turnNumber);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="p-1 hover:bg-surface-secondary rounded">
          <ArrowLeft className="h-5 w-5 text-muted" />
        </button>
        <div>
          <h1 className="text-xl font-bold text-heading">
            Conversation Replay
          </h1>
          <p className="text-sm text-muted">
            {scenario?.name || 'Unknown Scenario'}
            {result.scores && (
              <span className={`ml-2 font-medium ${scoreColor(result.scores.overall)}`}>
                Score: {result.scores.overall.toFixed(1)}/10
                {result.scores.passed ? ' ✓' : ' ✗'}
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-surface border border-border rounded-lg flex flex-col" style={{ maxHeight: '600px' }}>
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h3 className="text-sm font-semibold text-heading flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              Transcript
            </h3>
            <span className="text-xs text-muted">
              Turn {currentTurn + 1} of {transcript.length}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {visibleMessages.map((msg, idx) => (
              <div
                key={idx}
                className={`flex gap-2 ${msg.role === 'agent' ? '' : 'flex-row-reverse'}`}
              >
                <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                  msg.role === 'agent' ? 'bg-primary/10' : 'bg-orange-100 dark:bg-orange-900/30'
                }`}>
                  {msg.role === 'agent' ? (
                    <Bot className="h-4 w-4 text-primary" />
                  ) : (
                    <User className="h-4 w-4 text-orange-600" />
                  )}
                </div>
                <div
                  className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                    msg.role === 'agent'
                      ? 'bg-primary/5 border border-primary/10 text-heading'
                      : 'bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 text-heading'
                  } ${idx === currentTurn ? 'ring-2 ring-primary/30' : ''}`}
                >
                  <p className="text-xs font-medium text-muted mb-1">
                    {msg.role === 'agent' ? 'Agent' : 'Caller'}
                  </p>
                  {msg.content}
                </div>
              </div>
            ))}
          </div>

          <div className="px-4 py-3 border-t border-border flex items-center gap-2">
            <button
              onClick={() => setCurrentTurn(0)}
              disabled={currentTurn === 0}
              className="px-2 py-1 text-xs rounded border border-border disabled:opacity-30"
            >
              ⏮
            </button>
            <button
              onClick={() => setCurrentTurn(Math.max(0, currentTurn - 1))}
              disabled={currentTurn === 0}
              className="px-2 py-1 text-xs rounded border border-border disabled:opacity-30"
            >
              ◀
            </button>
            <input
              type="range"
              min={0}
              max={transcript.length - 1}
              value={currentTurn}
              onChange={(e) => setCurrentTurn(parseInt(e.target.value))}
              className="flex-1"
            />
            <button
              onClick={() => setCurrentTurn(Math.min(transcript.length - 1, currentTurn + 1))}
              disabled={currentTurn >= transcript.length - 1}
              className="px-2 py-1 text-xs rounded border border-border disabled:opacity-30"
            >
              ▶
            </button>
            <button
              onClick={() => setCurrentTurn(transcript.length - 1)}
              disabled={currentTurn >= transcript.length - 1}
              className="px-2 py-1 text-xs rounded border border-border disabled:opacity-30"
            >
              ⏭
            </button>
          </div>
        </div>

        <div className="space-y-4">
          {scenario && (
            <div className="bg-surface border border-border rounded-lg p-4">
              <h3 className="text-sm font-semibold text-heading mb-2">Scenario</h3>
              <div className="space-y-2 text-xs">
                <div>
                  <span className="text-muted">Persona:</span>{' '}
                  <span className="text-heading">{scenario.persona.name} ({scenario.persona.mood})</span>
                </div>
                <div>
                  <span className="text-muted">Goals:</span>
                  <ul className="list-disc list-inside mt-1">
                    {scenario.goals.map((g, i) => <li key={i} className="text-heading">{g}</li>)}
                  </ul>
                </div>
              </div>
            </div>
          )}

          <div className="bg-surface border border-border rounded-lg p-4">
            <button
              onClick={() => setShowReasoning(!showReasoning)}
              className="flex items-center gap-2 text-sm font-semibold text-heading w-full"
            >
              <Zap className="h-4 w-4" />
              Reasoning & Tools
              {showReasoning ? <ChevronDown className="h-4 w-4 ml-auto" /> : <ChevronRight className="h-4 w-4 ml-auto" />}
            </button>
            {showReasoning && (
              <div className="mt-3 space-y-2">
                {currentTraceEntry ? (
                  <div className="text-xs space-y-1">
                    <div><span className="text-muted">Intent:</span> <span className="text-heading">{currentTraceEntry.intent}</span></div>
                    <div><span className="text-muted">Confidence:</span> <span className="text-heading">{currentTraceEntry.confidence}</span></div>
                    <div><span className="text-muted">Action:</span> <span className="text-heading">{currentTraceEntry.action}</span></div>
                    <div><span className="text-muted">Reasoning:</span> <span className="text-heading">{currentTraceEntry.reasoning}</span></div>
                    {Object.keys(currentTraceEntry.slots).length > 0 && (
                      <div>
                        <span className="text-muted">Slots:</span>
                        <pre className="bg-surface-secondary rounded p-2 mt-1 overflow-x-auto">
                          {JSON.stringify(currentTraceEntry.slots, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted">No reasoning data for this turn</p>
                )}
                {currentToolCall && (
                  <div className="border-t border-border pt-2 text-xs">
                    <div><span className="text-muted">Tool:</span> <span className="text-heading">{currentToolCall.toolName}</span></div>
                    <div><span className="text-muted">Result:</span> <span className={currentToolCall.success ? 'text-green-600' : 'text-red-600'}>{currentToolCall.result}</span></div>
                  </div>
                )}
              </div>
            )}
          </div>

          {result.scores && (
            <div className="bg-surface border border-border rounded-lg p-4">
              <h3 className="text-sm font-semibold text-heading mb-3">Scores</h3>
              <div className="space-y-2">
                <ScoreBar label="Booking" value={result.scores.bookingSuccess} />
                <ScoreBar label="Completion" value={result.scores.conversationCompletion} />
                <ScoreBar label="Intent" value={result.scores.intentResolution} />
                <ScoreBar label="Tone" value={result.scores.toneAppropriateness} />
                <div className="border-t border-border pt-2 mt-2">
                  <ScoreBar label="Overall" value={result.scores.overall} bold />
                </div>
                <p className="text-xs text-muted mt-2 italic">{result.scores.scoringRationale}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ScenarioEditor({
  scenario,
  onUpdate,
  onSave,
  onCancel,
  error,
}: {
  scenario: Partial<Scenario> | null;
  onUpdate: (s: Partial<Scenario> | null) => void;
  onSave: () => void;
  onCancel: () => void;
  error: string | null;
}) {
  if (!scenario) return null;

  const persona = scenario.persona || { name: '', mood: 'neutral', background: '', speakingStyle: '', urgency: 'medium' };
  const goals = scenario.goals || [''];
  const outcomes = scenario.expectedOutcomes || {
    shouldBook: false, shouldEscalate: false, shouldResolve: true,
    expectedIntent: 'general_inquiry', acceptableEndStates: [],
  };

  const updatePersona = (key: string, value: string) => {
    onUpdate({ ...scenario, persona: { ...persona, [key]: value } });
  };

  const updateGoal = (idx: number, value: string) => {
    const newGoals = [...goals];
    newGoals[idx] = value;
    onUpdate({ ...scenario, goals: newGoals });
  };

  const addGoal = () => onUpdate({ ...scenario, goals: [...goals, ''] });
  const removeGoal = (idx: number) => onUpdate({ ...scenario, goals: goals.filter((_, i) => i !== idx) });

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <button onClick={onCancel} className="p-1 hover:bg-surface-secondary rounded">
          <ArrowLeft className="h-5 w-5 text-muted" />
        </button>
        <h1 className="text-xl font-bold text-heading">
          {scenario.id ? 'Edit Scenario' : 'New Scenario'}
        </h1>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
        <h2 className="font-semibold text-heading">Basic Info</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Name</label>
            <input
              value={scenario.name || ''}
              onChange={(e) => onUpdate({ ...scenario, name: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
              placeholder="Scenario name"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Category</label>
            <select
              value={scenario.category || 'custom'}
              onChange={(e) => onUpdate({ ...scenario, category: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-muted mb-1">Description</label>
            <input
              value={scenario.description || ''}
              onChange={(e) => onUpdate({ ...scenario, description: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
              placeholder="Brief description"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Difficulty</label>
            <select
              value={scenario.difficulty || 'medium'}
              onChange={(e) => onUpdate({ ...scenario, difficulty: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
            >
              {DIFFICULTIES.map((d) => (
                <option key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Max Turns</label>
            <input
              type="number"
              value={scenario.maxTurns || 15}
              onChange={(e) => onUpdate({ ...scenario, maxTurns: parseInt(e.target.value) || 15 })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
              min={5}
              max={50}
            />
          </div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
        <h2 className="font-semibold text-heading">Caller Persona</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Name</label>
            <input
              value={persona.name}
              onChange={(e) => updatePersona('name', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
              placeholder="Caller's name"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Mood</label>
            <select
              value={persona.mood}
              onChange={(e) => updatePersona('mood', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
            >
              {['pleasant', 'neutral', 'frustrated but polite', 'angry', 'panicked', 'confused', 'impatient', 'curious'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-muted mb-1">Background</label>
            <textarea
              value={persona.background}
              onChange={(e) => updatePersona('background', e.target.value)}
              rows={2}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm resize-y"
              placeholder="Caller's background and context"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Speaking Style</label>
            <input
              value={persona.speakingStyle}
              onChange={(e) => updatePersona('speakingStyle', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
              placeholder="e.g., polite, demanding, concise"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Urgency</label>
            <select
              value={persona.urgency}
              onChange={(e) => updatePersona('urgency', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
            >
              {['low', 'medium', 'high', 'critical'].map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-heading">Conversation Goals</h2>
          <button onClick={addGoal} className="text-xs text-primary hover:underline flex items-center gap-1">
            <Plus className="h-3 w-3" /> Add Goal
          </button>
        </div>
        {goals.map((goal, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <input
              value={goal}
              onChange={(e) => updateGoal(idx, e.target.value)}
              className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
              placeholder={`Goal ${idx + 1}`}
            />
            {goals.length > 1 && (
              <button onClick={() => removeGoal(idx)} className="p-1 text-muted hover:text-red-500">
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
        <h2 className="font-semibold text-heading">Expected Outcomes</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="flex items-center gap-2 text-sm text-heading">
            <input
              type="checkbox"
              checked={outcomes.shouldBook}
              onChange={(e) => onUpdate({ ...scenario, expectedOutcomes: { ...outcomes, shouldBook: e.target.checked } })}
            />
            Should Book/Schedule
          </label>
          <label className="flex items-center gap-2 text-sm text-heading">
            <input
              type="checkbox"
              checked={outcomes.shouldEscalate}
              onChange={(e) => onUpdate({ ...scenario, expectedOutcomes: { ...outcomes, shouldEscalate: e.target.checked } })}
            />
            Should Escalate
          </label>
          <label className="flex items-center gap-2 text-sm text-heading">
            <input
              type="checkbox"
              checked={outcomes.shouldResolve}
              onChange={(e) => onUpdate({ ...scenario, expectedOutcomes: { ...outcomes, shouldResolve: e.target.checked } })}
            />
            Should Resolve
          </label>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted mb-1">Expected Intent</label>
          <select
            value={outcomes.expectedIntent}
            onChange={(e) => onUpdate({ ...scenario, expectedOutcomes: { ...outcomes, expectedIntent: e.target.value } })}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
          >
            {[
              'general_inquiry', 'schedule_appointment', 'billing_inquiry', 'urgent_medical',
              'complaint', 'cancel', 'transfer_human', 'service_request', 'make_reservation',
            ].map((i) => (
              <option key={i} value={i}>{i.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={!scenario.name || !persona.name}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          <CheckCircle className="h-4 w-4" />
          Save Scenario
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2 border border-border rounded-lg text-sm text-heading hover:bg-surface-secondary transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function CompareView({
  comparisonData,
  comparisonRuns,
  onBack,
}: {
  comparisonData: ComparisonEntry[];
  comparisonRuns: SimulationRun[];
  onBack: () => void;
}) {
  const metrics = [
    { key: 'avgOverall', label: 'Overall Score' },
    { key: 'avgHelpfulness', label: 'Helpfulness' },
    { key: 'avgTone', label: 'Tone' },
    { key: 'avgResolution', label: 'Resolution' },
    { key: 'passRate', label: 'Pass Rate' },
  ] as const;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="p-1 hover:bg-surface-secondary rounded">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-2xl font-bold text-heading flex items-center gap-2">
          <BarChart3 className="h-6 w-6" />
          Run Comparison
        </h1>
      </div>

      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-secondary">
              <th className="text-left p-3 text-muted font-medium">Metric</th>
              {comparisonData.map((entry, i) => {
                const run = comparisonRuns.find(r => r.id === entry.runId);
                return (
                  <th key={i} className="text-center p-3 text-heading font-medium">
                    {entry.promptVersionLabel || run?.name || `Run ${i + 1}`}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {metrics.map(({ key, label }) => {
              const values = comparisonData.map(e => e[key]);
              const best = Math.max(...values);
              return (
                <tr key={key} className="border-t border-border">
                  <td className="p-3 text-muted font-medium">{label}</td>
                  {values.map((val, i) => (
                    <td key={i} className="p-3 text-center">
                      <span className={`font-semibold ${key === 'passRate'
                        ? (val >= 80 ? 'text-green-600 dark:text-green-400' : val >= 60 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400')
                        : scoreColor(val)
                      } ${val === best ? 'underline decoration-2' : ''}`}>
                        {key === 'passRate' ? `${val.toFixed(0)}%` : val.toFixed(1)}
                      </span>
                    </td>
                  ))}
                </tr>
              );
            })}
            <tr className="border-t border-border">
              <td className="p-3 text-muted font-medium">Scenarios</td>
              {comparisonData.map((entry, i) => (
                <td key={i} className="p-3 text-center text-heading">
                  {entry.completedScenarios}/{entry.totalScenarios}
                  {entry.failedScenarios > 0 && (
                    <span className="text-red-500 text-xs ml-1">({entry.failedScenarios} failed)</span>
                  )}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-heading mb-3">Score Comparison</h3>
        <div className="space-y-3">
          {['avgOverall', 'avgHelpfulness', 'avgTone', 'avgResolution'].map(key => (
            <div key={key} className="flex items-center gap-3">
              <span className="text-xs text-muted w-24">{key.replace('avg', '')}</span>
              <div className="flex-1 flex gap-1">
                {comparisonData.map((entry, i) => {
                  const val = entry[key as keyof ComparisonEntry] as number;
                  return (
                    <div key={i} className="flex-1">
                      <div className="h-4 bg-surface-secondary rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${i === 0 ? 'bg-blue-500' : i === 1 ? 'bg-emerald-500' : 'bg-purple-500'}`}
                          style={{ width: `${(val / 10) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs text-center block mt-0.5">{val.toFixed(1)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-3 mt-3 text-xs text-muted">
          {comparisonData.map((entry, i) => {
            const run = comparisonRuns.find(r => r.id === entry.runId);
            return (
              <div key={i} className="flex items-center gap-1">
                <div className={`w-3 h-3 rounded-full ${i === 0 ? 'bg-blue-500' : i === 1 ? 'bg-emerald-500' : 'bg-purple-500'}`} />
                {entry.promptVersionLabel || run?.name || `Run ${i + 1}`}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    running: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
    completed: 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400',
    failed: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[status] || styles.pending}`}>
      {status}
    </span>
  );
}

function ScoreCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-3">
      <p className="text-xs text-muted mb-1">{label}</p>
      <p className={`text-xl font-bold ${scoreColor(value)}`}>{value.toFixed(1)}<span className="text-xs text-muted">/10</span></p>
    </div>
  );
}

function ScoreBar({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-xs w-20 ${bold ? 'font-semibold text-heading' : 'text-muted'}`}>{label}</span>
      <div className="flex-1 h-2 bg-surface-secondary rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${value >= 8 ? 'bg-green-500' : value >= 6 ? 'bg-yellow-500' : 'bg-red-500'}`}
          style={{ width: `${(value / 10) * 100}%` }}
        />
      </div>
      <span className={`text-xs w-8 text-right ${bold ? 'font-semibold' : ''} ${scoreColor(value)}`}>
        {value.toFixed(1)}
      </span>
    </div>
  );
}

function scoreColor(score: number): string {
  if (score >= 8) return 'text-green-600 dark:text-green-400';
  if (score >= 6) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
}

function difficultyColor(d: string): string {
  if (d === 'easy') return 'text-green-600';
  if (d === 'hard') return 'text-red-600';
  return 'text-yellow-600';
}

function difficultyBg(d: string): string {
  if (d === 'easy') return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  if (d === 'hard') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
  return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400';
}
