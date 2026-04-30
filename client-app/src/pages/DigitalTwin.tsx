import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../lib/api';
import { formatCents as formatCentsHelper } from '../lib/formatCurrency';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
import {
  Cpu, Plus, Play, BarChart3, TrendingUp, Clock, ChevronDown, ChevronRight,
  Layers, Zap, AlertTriangle, CheckCircle, ArrowUpRight, ArrowDownRight,
  RefreshCw, Trash2, Eye, Activity, DollarSign, Users, PhoneCall, StopCircle,
} from 'lucide-react';
import TourLauncher from '../components/TourLauncher';
import { digitalTwinTour } from '../components/tours';
import { PageHeader, OperationStatusPanel, type OperationStatus } from '../components/ui';
import Modal from '../components/Modal';

interface DigitalTwinModel {
  id: string;
  name: string;
  version: number;
  status: string;
  snapshotData: OperationalSnapshot;
  dataRangeStart: string | null;
  dataRangeEnd: string | null;
  createdAt: string;
}

interface OperationalSnapshot {
  avgDailyCallVolume: number;
  avgWeeklyCallVolume: number;
  avgMonthlyCallVolume: number;
  bookingConversionRate: number;
  avgCallDurationSeconds: number;
  escalationRate: number;
  inboundOutboundRatio: number;
  peakHours: number[];
  agentPerformance: { agentId: string; agentName: string; callsHandled: number; bookingRate: number }[];
  seasonalPatterns: { month: number; avgCallVolume: number; avgBookingRate: number }[];
}

interface DTScenario {
  id: string;
  name: string;
  description: string | null;
  category: string;
  scenarioType: string;
  parameters: Record<string, unknown>;
  isPredefined: boolean;
}

interface SimulationRun {
  id: string;
  modelId: string;
  scenarioId: string;
  name: string | null;
  status: string;
  parameters: Record<string, unknown>;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface SimulationMetrics {
  projectedDailyCallVolume: number;
  projectedBookingRate: number;
  projectedRevenuePerDayCents: number;
  projectedEscalationRate: number;
  projectedAvgCallDuration: number;
  projectedStaffingNeeded: number;
  projectedMonthlyRevenueCents: number;
  conversionRateDelta: number;
  revenueDeltaCents: number;
  callVolumeDelta: number;
  riskLevel: string;
  insights: string[];
}

interface ConversationQualityScores {
  avgOverall: number;
  avgHelpfulness: number;
  avgTone: number;
  avgResolution: number;
  passRate: number;
  totalScenarios: number;
  completedScenarios: number;
  failedScenarios: number;
}

interface ConversationQualityResults {
  baselineRunId?: string;
  variantRunId?: string;
  baseline?: ConversationQualityScores;
  variant?: ConversationQualityScores;
  comparison?: {
    overallImprovement: number;
    passRateImprovement: number;
    helpfulnessImprovement: number;
    toneImprovement: number;
    resolutionImprovement: number;
  };
  frictionPoints?: string[];
}

interface SimulationResult {
  id: string;
  runId: string;
  resultType: string;
  metrics: SimulationMetrics;
  comparisonBaseline: SimulationMetrics;
  summary: string | null;
  conversationQuality: ConversationQualityResults | null;
}

interface ForecastModel {
  id: string;
  modelId: string | null;
  forecastType: string;
  horizonDays: number;
  generatedAt: string;
  projections: { date: string; value: number; lowerBound: number; upperBound: number }[];
  confidenceLevel: number;
}

type TabType = 'overview' | 'scenarios' | 'results' | 'forecasts';

export default function DigitalTwin() {
  const [tab, setTab] = useState<TabType>('overview');
  const [models, setModels] = useState<DigitalTwinModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<DigitalTwinModel | null>(null);
  const [scenarios, setScenarios] = useState<DTScenario[]>([]);
  const [runs, setRuns] = useState<SimulationRun[]>([]);
  const [forecasts, setForecasts] = useState<ForecastModel[]>([]);
  const [selectedResult, setSelectedResult] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreateModel, setShowCreateModel] = useState(false);
  const [showRunSim, setShowRunSim] = useState(false);
  const [simRunning, setSimRunning] = useState(false);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [simStatus, setSimStatus] = useState<OperationStatus>('idle');
  const [simContext, setSimContext] = useState<{ scenarioName: string; modelName: string } | null>(null);
  const [simStartedAt, setSimStartedAt] = useState<number | null>(null);
  const [simFinishedAt, setSimFinishedAt] = useState<number | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [simProcessed, setSimProcessed] = useState(0);
  const [simTotal, setSimTotal] = useState(0);
  const [simPhase, setSimPhase] = useState<string | null>(null);
  const [simRunId, setSimRunId] = useState<string | null>(null);
  const simPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (simStatus !== 'running') return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [simStatus]);

  useEffect(() => {
    return () => {
      if (simPollRef.current) clearInterval(simPollRef.current);
    };
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const data = await api.get<{ models: DigitalTwinModel[] }>('/digital-twin/models');
      setModels(data.models);
      if (data.models.length > 0 && !selectedModel) {
        setSelectedModel(data.models[0]);
      }
    } catch (err) {
      setError('Failed to load models');
    }
  }, [selectedModel]);

  const loadScenarios = useCallback(async () => {
    try {
      const data = await api.get<{ scenarios: DTScenario[] }>('/digital-twin/scenarios');
      setScenarios(data.scenarios);
    } catch (err) {
      setError('Failed to load scenarios');
    }
  }, []);

  const loadRuns = useCallback(async () => {
    if (!selectedModel) return;
    try {
      const data = await api.get<{ runs: SimulationRun[] }>(`/digital-twin/runs?modelId=${selectedModel.id}`);
      setRuns(data.runs);
    } catch (err) {
      setError('Failed to load simulation runs');
    }
  }, [selectedModel]);

  const loadForecasts = useCallback(async () => {
    if (!selectedModel) return;
    try {
      const data = await api.get<{ forecasts: ForecastModel[] }>(`/digital-twin/forecasts?modelId=${selectedModel.id}`);
      setForecasts(data.forecasts);
    } catch (err) {
      setError('Failed to load forecasts');
    }
  }, [selectedModel]);

  useEffect(() => {
    Promise.all([loadModels(), loadScenarios()]).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (selectedModel) {
      loadRuns();
      loadForecasts();
    }
  }, [selectedModel]);

  const createModel = async (name: string, startDate: string, endDate: string) => {
    setError(null);
    try {
      const data = await api.post<{ model: DigitalTwinModel }>('/digital-twin/models', {
        name, dataRangeStart: startDate, dataRangeEnd: endDate,
      });
      setModels(prev => [data.model, ...prev]);
      setSelectedModel(data.model);
      setShowCreateModel(false);
    } catch (err) {
      setError('Failed to create model. Please try again.');
    }
  };

  const deleteModel = async (id: string) => {
    setError(null);
    try {
      await api.delete(`/digital-twin/models/${id}`);
      setModels(prev => {
        const remaining = prev.filter(m => m.id !== id);
        if (selectedModel?.id === id) {
          setSelectedModel(remaining.length > 0 ? remaining[0] : null);
        }
        return remaining;
      });
    } catch (err) {
      setError('Failed to delete model');
    }
  };

  const stopPolling = () => {
    if (simPollRef.current) {
      clearInterval(simPollRef.current);
      simPollRef.current = null;
    }
  };

  const startPolling = useCallback((runId: string) => {
    stopPolling();
    simPollRef.current = setInterval(async () => {
      try {
        const status = await api.get<{
          status: 'running' | 'completed' | 'failed' | 'cancelled';
          phase: string;
          processed: number;
          total: number;
          error: string | null;
        }>(`/digital-twin/runs/${runId}/status`);

        setSimProcessed(status.processed);
        setSimTotal(status.total);
        setSimPhase(status.phase);

        if (status.status === 'running') return;

        stopPolling();
        setSimRunning(false);
        setSimFinishedAt(Date.now());

        if (status.status === 'completed') {
          try {
            const [runResp, resultsResp] = await Promise.all([
              api.get<{ run: SimulationRun }>(`/digital-twin/runs/${runId}`),
              api.get<{ results: SimulationResult[] }>(`/digital-twin/runs/${runId}/results`),
            ]);
            setRuns(prev => [runResp.run, ...prev.filter(r => r.id !== runResp.run.id)]);
            if (resultsResp.results.length > 0) {
              setSelectedResult(resultsResp.results[0]);
            }
            setShowRunSim(false);
            setTab('results');
            setSimStatus('success');
          } catch {
            setSimStatus('failed');
            setSimError('Simulation completed but results could not be loaded.');
          }
        } else if (status.status === 'cancelled') {
          setSimStatus('cancelled');
          loadRuns();
        } else {
          setSimStatus('failed');
          setSimError(status.error ?? 'Simulation failed');
          setError('Simulation failed. Please try again.');
        }
      } catch {
        // Transient polling error — keep trying until the next tick or cancel.
      }
    }, 1000);
  }, [loadRuns]);

  const runSimulation = async (scenarioId: string, name?: string) => {
    if (!selectedModel) return;
    const scenario = scenarios.find((s) => s.id === scenarioId);
    setSimRunning(true);
    setSimStatus('running');
    setSimContext({
      scenarioName: scenario?.name ?? scenarioId,
      modelName: selectedModel.name,
    });
    setSimStartedAt(Date.now());
    setSimFinishedAt(null);
    setSimError(null);
    setSimProcessed(0);
    setSimTotal(0);
    setSimPhase('queued');
    setSimRunId(null);
    setError(null);
    stopPolling();

    let runId: string;
    let total: number;
    try {
      const startResp = await api.post<{ runId: string; total: number }>(
        '/digital-twin/simulate',
        { modelId: selectedModel.id, scenarioId, name, async: true },
      );
      runId = startResp.runId;
      total = startResp.total;
      setSimRunId(runId);
      setSimTotal(total);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Simulation failed';
      setSimStatus('failed');
      setSimError(msg);
      setSimFinishedAt(Date.now());
      setError('Simulation failed. Please try again.');
      setSimRunning(false);
      return;
    }

    startPolling(runId);
  };

  const cancelSimulation = async () => {
    if (!simRunId || simStatus !== 'running') return;
    try {
      await api.post(`/digital-twin/runs/${simRunId}/cancel`, {});
    } catch {
      // The polling loop will still surface the final status.
    }
  };

  const dismissSimPanel = () => {
    if (simStatus === 'running') return;
    setSimStatus('idle');
    setSimContext(null);
    setSimStartedAt(null);
    setSimFinishedAt(null);
    setSimError(null);
    setSimProcessed(0);
    setSimTotal(0);
    setSimPhase(null);
    setSimRunId(null);
  };

  useEffect(() => {
    if (!selectedModel || simStatus === 'running') return;
    const inFlight = runs.find((r) => r.status === 'running');
    if (!inFlight || inFlight.id === simRunId) return;
    const scenario = scenarios.find((s) => s.id === inFlight.scenarioId);
    setSimRunning(true);
    setSimStatus('running');
    setSimContext({
      scenarioName: scenario?.name ?? inFlight.name ?? inFlight.scenarioId,
      modelName: selectedModel.name,
    });
    setSimStartedAt(inFlight.startedAt ? new Date(inFlight.startedAt).getTime() : Date.now());
    setSimFinishedAt(null);
    setSimError(null);
    setSimProcessed(0);
    setSimTotal(0);
    setSimPhase('running');
    setSimRunId(inFlight.id);
    startPolling(inFlight.id);
  }, [runs, scenarios, selectedModel, simStatus, simRunId, startPolling]);

  const generateForecast = async (forecastType: string, horizonDays: number = 30) => {
    if (!selectedModel) return;
    setForecastLoading(true);
    setError(null);
    try {
      const data = await api.post<{ forecast: ForecastModel }>('/digital-twin/forecasts', {
        modelId: selectedModel.id, forecastType, horizonDays,
      });
      setForecasts(prev => [data.forecast, ...prev]);
      setTab('forecasts');
    } catch (err) {
      setError('Failed to generate forecast. Please try again.');
    } finally {
      setForecastLoading(false);
    }
  };

  const viewRunResult = async (runId: string) => {
    try {
      const data = await api.get<{ results: SimulationResult[] }>(`/digital-twin/runs/${runId}/results`);
      if (data.results.length > 0) {
        setSelectedResult(data.results[0]);
      }
    } catch (err) {
      setError('Failed to load simulation results');
    }
  };

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <RefreshCw className="w-6 h-6 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {error && (
        <div className="flex items-center justify-between p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500" />
            <span className="text-sm text-red-700 dark:text-red-300">{error}</span>
          </div>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 text-sm font-medium">Dismiss</button>
        </div>
      )}

      <div data-tour="twin-header">
        <PageHeader
          icon={<Cpu className="w-5 h-5" />}
          title={
            <span className="inline-flex items-center gap-2">
              Digital Twin
              <TourLauncher tourId="digital-twin" steps={digitalTwinTour} />
            </span>
          }
          description="Simulate, forecast, and validate operational changes"
          actions={
            <button
              onClick={() => setShowCreateModel(true)}
              data-tour="twin-new-model"
              className="inline-flex items-center gap-2 px-3 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" /> New Model
            </button>
          }
        />
      </div>

      {models.length === 0 ? (
        <EmptyState onCreateModel={() => setShowCreateModel(true)} />
      ) : (
        <>
          <ModelSelector
            models={models}
            selected={selectedModel}
            onSelect={setSelectedModel}
            onDelete={deleteModel}
          />

          {selectedModel && (
            <>
              {(simStatus === 'running' || simStatus === 'success' || simStatus === 'failed' || simStatus === 'cancelled') && simContext && simStartedAt && (
                <SimulationProgressPanel
                  status={simStatus}
                  context={simContext}
                  startedAt={simStartedAt}
                  finishedAt={simFinishedAt}
                  error={simError}
                  processed={simProcessed}
                  total={simTotal}
                  phase={simPhase}
                  onCancel={cancelSimulation}
                  onDismiss={dismissSimPanel}
                />
              )}

              <div className="flex gap-1 bg-surface-hover rounded-lg p-1" data-tour="twin-tabs">
                {(['overview', 'scenarios', 'results', 'forecasts'] as TabType[]).map(t => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                      tab === t
                        ? 'bg-surface text-purple-600 dark:text-purple-400 shadow-sm'
                        : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {t === 'overview' ? 'Model Overview' : t === 'scenarios' ? 'Run Simulation' : t === 'results' ? 'Results' : 'Forecasts'}
                  </button>
                ))}
              </div>

              {tab === 'overview' && <ModelOverview model={selectedModel} />}
              {tab === 'scenarios' && (
                <ScenarioLauncher
                  scenarios={scenarios}
                  onRun={runSimulation}
                  running={simRunning}
                />
              )}
              {tab === 'results' && (
                <ResultsView
                  runs={runs}
                  selectedResult={selectedResult}
                  onViewResult={viewRunResult}
                />
              )}
              {tab === 'forecasts' && (
                <ForecastsView
                  forecasts={forecasts}
                  onGenerate={generateForecast}
                  loading={forecastLoading}
                />
              )}
            </>
          )}
        </>
      )}

      {showCreateModel && (
        <CreateModelModal
          onClose={() => setShowCreateModel(false)}
          onCreate={createModel}
        />
      )}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

function formatPhase(phase: string | null): string {
  if (!phase) return '—';
  return phase
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function SimulationProgressPanel({
  status, context, startedAt, finishedAt, error, processed, total, phase, onCancel, onDismiss,
}: {
  status: OperationStatus;
  context: { scenarioName: string; modelName: string };
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  processed: number;
  total: number;
  phase: string | null;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const endTime = finishedAt ?? Date.now();
  const elapsedMs = endTime - startedAt;
  const phaseLabel = formatPhase(phase);
  const description =
    status === 'running'
      ? `Running scenario "${context.scenarioName}" against ${context.modelName}.`
      : status === 'success'
        ? `Scenario "${context.scenarioName}" completed. The latest result is shown below in the Results tab.`
        : status === 'cancelled'
          ? `Scenario "${context.scenarioName}" was cancelled.`
          : `Scenario "${context.scenarioName}" failed before producing a result.`;

  const ratio = total > 0 ? Math.min(1, processed / total) : undefined;

  return (
    <OperationStatusPanel
      title="Digital Twin simulation"
      description={description}
      status={status}
      processed={status === 'running' ? processed : undefined}
      total={status === 'running' ? total : undefined}
      progress={status === 'running' ? ratio : status === 'success' ? 1 : undefined}
      eta={status === 'running' ? `Elapsed ${formatElapsed(elapsedMs)}` : undefined}
      meta={[
        { label: 'Scenario', value: context.scenarioName },
        { label: 'Model', value: context.modelName },
        { label: 'Phase', value: phaseLabel },
        { label: 'Elapsed', value: formatElapsed(elapsedMs) },
      ]}
      error={error ?? undefined}
      actions={
        status === 'running' ? (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-warning/40 bg-warning-light text-warning text-xs font-medium hover:bg-warning/10 transition-colors"
          >
            <StopCircle className="h-3.5 w-3.5" /> Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-text-secondary text-xs font-medium hover:bg-surface-hover transition-colors"
          >
            Dismiss
          </button>
        )
      }
      testId="digital-twin-sim-panel"
    />
  );
}

function EmptyState({ onCreateModel }: { onCreateModel: () => void }) {
  return (
    <div className="text-center py-16 bg-surface rounded-xl border border-border">
      <Cpu className="w-16 h-16 text-text-muted mx-auto mb-4" />
      <h3 className="text-lg font-semibold text-text-primary mb-2">No Digital Twin Models</h3>
      <p className="text-text-secondary mb-6 max-w-md mx-auto">
        Create a digital twin model from your operational history to simulate changes, run forecasts, and validate recommendations.
      </p>
      <button
        onClick={onCreateModel}
        className="px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
      >
        Create Your First Model
      </button>
    </div>
  );
}

function ModelSelector({
  models, selected, onSelect, onDelete,
}: {
  models: DigitalTwinModel[];
  selected: DigitalTwinModel | null;
  onSelect: (m: DigitalTwinModel) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 bg-surface rounded-xl border border-border hover:border-purple-300"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-purple-100 dark:bg-purple-900 rounded-lg flex items-center justify-center">
            <Layers className="w-5 h-5 text-purple-600 dark:text-purple-400" />
          </div>
          <div className="text-left">
            <p className="font-medium text-text-primary">{selected?.name ?? 'Select a model'}</p>
            <p className="text-xs text-text-secondary">
              {selected ? `v${selected.version} - ${selected.status}` : ''}
              {selected?.dataRangeStart && selected?.dataRangeEnd
                ? ` | ${new Date(selected.dataRangeStart).toLocaleDateString()} - ${new Date(selected.dataRangeEnd).toLocaleDateString()}`
                : ''}
            </p>
          </div>
        </div>
        {open ? <ChevronDown className="w-5 h-5 text-text-muted" /> : <ChevronRight className="w-5 h-5 text-text-muted" />}
      </button>
      {open && (
        <div className="absolute z-10 w-full mt-1 bg-surface rounded-xl border border-border shadow-lg max-h-64 overflow-y-auto">
          {models.map(m => (
            <div
              key={m.id}
              className={`flex items-center justify-between p-3 hover:bg-surface-hover cursor-pointer ${
                selected?.id === m.id ? 'bg-purple-50 dark:bg-purple-900/20' : ''
              }`}
            >
              <div onClick={() => { onSelect(m); setOpen(false); }} className="flex-1">
                <p className="font-medium text-sm text-text-primary">{m.name}</p>
                <p className="text-xs text-text-secondary">v{m.version} - {new Date(m.createdAt).toLocaleDateString()}</p>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(m.id); }}
                className="p-1 text-text-muted hover:text-red-500"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModelOverview({ model }: { model: DigitalTwinModel }) {
  const s = model.snapshotData;
  const stats = [
    { label: 'Avg Daily Calls', value: s.avgDailyCallVolume, icon: PhoneCall, color: 'blue' },
    { label: 'Booking Rate', value: `${(s.bookingConversionRate * 100).toFixed(1)}%`, icon: CheckCircle, color: 'green' },
    { label: 'Avg Call Duration', value: `${Math.round(s.avgCallDurationSeconds)}s`, icon: Clock, color: 'yellow' },
    { label: 'Escalation Rate', value: `${(s.escalationRate * 100).toFixed(1)}%`, icon: AlertTriangle, color: 'red' },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {stats.map(st => (
          <div key={st.label} className="bg-surface rounded-xl border border-border p-4">
            <div className="flex items-center gap-2 mb-2">
              <st.icon className={`w-4 h-4 text-${st.color}-500`} />
              <span className="text-xs text-text-secondary">{st.label}</span>
            </div>
            <p className="text-xl font-bold text-text-primary">{st.value}</p>
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-surface rounded-xl border border-border p-5">
          <h3 className="font-semibold text-text-primary mb-3">Peak Hours</h3>
          <div className="flex gap-2 flex-wrap">
            {(s.peakHours || []).map(h => (
              <span key={h} className="px-3 py-1 bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 rounded-full text-sm">
                {h}:00
              </span>
            ))}
            {(!s.peakHours || s.peakHours.length === 0) && <span className="text-text-muted text-sm">No data</span>}
          </div>
        </div>

        <div className="bg-surface rounded-xl border border-border p-5">
          <h3 className="font-semibold text-text-primary mb-3">Volume Summary</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-text-secondary">Weekly Avg</span>
              <span className="font-medium text-text-primary">{s.avgWeeklyCallVolume} calls</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-secondary">Monthly Avg</span>
              <span className="font-medium text-text-primary">{s.avgMonthlyCallVolume} calls</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-secondary">In/Out Ratio</span>
              <span className="font-medium text-text-primary">
                {s.inboundOutboundRatio === Infinity ? 'All Inbound' : s.inboundOutboundRatio.toFixed(1)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {s.agentPerformance && s.agentPerformance.length > 0 && (
        <div className="bg-surface rounded-xl border border-border p-5">
          <h3 className="font-semibold text-text-primary mb-3">Agent Performance Snapshot</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-secondary border-b border-border">
                  <th className="pb-2 font-medium">Agent</th>
                  <th className="pb-2 font-medium">Calls</th>
                  <th className="pb-2 font-medium">Booking Rate</th>
                </tr>
              </thead>
              <tbody>
                {s.agentPerformance.map(a => (
                  <tr key={a.agentId} className="border-b border-border/50">
                    <td className="py-2 text-text-primary">{a.agentName}</td>
                    <td className="py-2 text-text-secondary">{a.callsHandled}</td>
                    <td className="py-2 text-text-secondary">{(a.bookingRate * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ScenarioLauncher({
  scenarios, onRun, running,
}: {
  scenarios: DTScenario[];
  onRun: (scenarioId: string, name?: string) => void;
  running: boolean;
}) {
  const categories = [...new Set(scenarios.map(s => s.category))];

  return (
    <div className="space-y-6">
      <div className="bg-surface rounded-xl border border-border p-5">
        <h3 className="font-semibold text-text-primary mb-1">Scenario Library</h3>
        <p className="text-sm text-text-secondary mb-4">Select a scenario to simulate against your digital twin model</p>

        {categories.map(cat => (
          <div key={cat} className="mb-4">
            <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">{cat}</h4>
            <div className="grid md:grid-cols-2 gap-3">
              {scenarios.filter(s => s.category === cat).map(scenario => (
                <div
                  key={scenario.id}
                  className="flex items-start justify-between p-3 bg-surface-hover rounded-lg border border-border"
                >
                  <div className="flex-1 mr-3">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-sm text-text-primary">{scenario.name}</p>
                      {scenario.isPredefined && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded">
                          Built-in
                        </span>
                      )}
                    </div>
                    {scenario.description && (
                      <p className="text-xs text-text-secondary mt-1">{scenario.description}</p>
                    )}
                  </div>
                  <button
                    onClick={() => onRun(scenario.id)}
                    disabled={running}
                    className="flex items-center gap-1 px-3 py-1.5 bg-purple-600 text-white text-xs rounded-lg hover:bg-purple-700 disabled:opacity-50 whitespace-nowrap"
                  >
                    {running ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                    Run
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}

        {scenarios.length === 0 && (
          <p className="text-center text-text-muted py-8">No scenarios available. They will be seeded on first load.</p>
        )}
      </div>
    </div>
  );
}

function ResultsView({
  runs, selectedResult, onViewResult,
}: {
  runs: SimulationRun[];
  selectedResult: SimulationResult | null;
  onViewResult: (runId: string) => void;
}) {
  return (
    <div className="space-y-6">
      {selectedResult && (
        <ResultDetail result={selectedResult} />
      )}

      <div className="bg-surface rounded-xl border border-border p-5">
        <h3 className="font-semibold text-text-primary mb-3">Simulation History</h3>
        {runs.length === 0 ? (
          <p className="text-center text-text-muted py-8">No simulations run yet. Go to Run Simulation to get started.</p>
        ) : (
          <div className="space-y-2">
            {runs.map(run => (
              <div
                key={run.id}
                onClick={() => onViewResult(run.id)}
                className="flex items-center justify-between p-3 bg-surface-hover rounded-lg cursor-pointer hover:bg-surface-hover"
              >
                <div>
                  <p className="font-medium text-sm text-text-primary">{run.name || `Run ${run.id.slice(0, 8)}`}</p>
                  <p className="text-xs text-text-secondary">{new Date(run.createdAt).toLocaleString()}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    run.status === 'completed' ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300' :
                    run.status === 'running' ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300' :
                    'bg-surface-hover text-text-primary'
                  }`}>
                    {run.status}
                  </span>
                  <Eye className="w-4 h-4 text-text-muted" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ResultDetail({ result }: { result: SimulationResult }) {
  const m = result.metrics;
  const b = result.comparisonBaseline;
  const currency = useTenantCurrency();

  const comparisons = [
    {
      label: 'Daily Call Volume',
      baseline: b.projectedDailyCallVolume,
      simulated: m.projectedDailyCallVolume,
      delta: m.callVolumeDelta,
      format: (v: number) => String(v),
      icon: PhoneCall,
    },
    {
      label: 'Booking Rate',
      baseline: b.projectedBookingRate,
      simulated: m.projectedBookingRate,
      delta: m.conversionRateDelta,
      format: (v: number) => `${(v * 100).toFixed(1)}%`,
      icon: CheckCircle,
    },
    {
      label: 'Daily Revenue',
      baseline: b.projectedRevenuePerDayCents,
      simulated: m.projectedRevenuePerDayCents,
      delta: m.revenueDeltaCents,
      format: (v: number) => formatCentsHelper(v, { currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }),
      icon: DollarSign,
    },
    {
      label: 'Monthly Revenue',
      baseline: b.projectedMonthlyRevenueCents,
      simulated: m.projectedMonthlyRevenueCents,
      delta: m.projectedMonthlyRevenueCents - b.projectedMonthlyRevenueCents,
      format: (v: number) => formatCentsHelper(v, { currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }),
      icon: TrendingUp,
    },
    {
      label: 'Escalation Rate',
      baseline: b.projectedEscalationRate,
      simulated: m.projectedEscalationRate,
      delta: m.projectedEscalationRate - b.projectedEscalationRate,
      format: (v: number) => `${(v * 100).toFixed(1)}%`,
      icon: AlertTriangle,
      invertColor: true,
    },
    {
      label: 'Staffing Needed',
      baseline: b.projectedStaffingNeeded,
      simulated: m.projectedStaffingNeeded,
      delta: m.projectedStaffingNeeded - b.projectedStaffingNeeded,
      format: (v: number) => String(v),
      icon: Users,
    },
  ];

  return (
    <div className="bg-surface rounded-xl border border-border p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-text-primary">Simulation Results</h3>
        <span className={`px-3 py-1 rounded-full text-xs font-medium ${
          m.riskLevel === 'low' ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300' :
          m.riskLevel === 'medium' ? 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300' :
          'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300'
        }`}>
          {m.riskLevel.toUpperCase()} RISK
        </span>
      </div>

      {result.summary && (
        <p className="text-sm text-text-secondary bg-surface-hover rounded-lg p-3">{result.summary}</p>
      )}

      <div className="grid md:grid-cols-3 gap-4">
        {comparisons.map(c => {
          const isPositive = c.invertColor ? c.delta < 0 : c.delta > 0;
          const isNeutral = c.delta === 0;
          return (
            <div key={c.label} className="p-3 bg-surface-hover rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <c.icon className="w-4 h-4 text-text-muted" />
                <span className="text-xs text-text-secondary">{c.label}</span>
              </div>
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-xs text-text-muted">Baseline</p>
                  <p className="text-sm font-medium text-text-secondary">{c.format(c.baseline)}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-text-muted">Simulated</p>
                  <p className="text-sm font-bold text-text-primary">{c.format(c.simulated)}</p>
                </div>
              </div>
              {!isNeutral && (
                <div className={`flex items-center gap-1 mt-1 text-xs font-medium ${
                  isPositive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                }`}>
                  {isPositive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                  {c.label.includes('Rate') ? `${(Math.abs(c.delta) * 100).toFixed(1)}pp` : c.format(Math.abs(c.delta))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {m.insights && m.insights.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-text-primary mb-2">Insights</h4>
          <ul className="space-y-1">
            {m.insights.map((insight, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-text-secondary">
                <Zap className="w-3 h-3 text-yellow-500 mt-0.5 flex-shrink-0" />
                {insight}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.conversationQuality && (
        <ConversationQualityPanel quality={result.conversationQuality} />
      )}
    </div>
  );
}

function ConversationQualityPanel({ quality }: { quality: ConversationQualityResults }) {
  const cmp = quality.comparison;

  return (
    <div className="border-t border-border pt-4 mt-4">
      <h4 className="text-sm font-medium text-text-primary mb-3 flex items-center gap-2">
        <Activity className="w-4 h-4 text-blue-500" />
        Conversation Quality Comparison
      </h4>

      {quality.baseline && quality.variant && cmp && (
        <div className="grid md:grid-cols-5 gap-3 mb-3">
          {[
            { label: 'Overall', baseline: quality.baseline.avgOverall, variant: quality.variant.avgOverall, delta: cmp.overallImprovement },
            { label: 'Pass Rate', baseline: quality.baseline.passRate, variant: quality.variant.passRate, delta: cmp.passRateImprovement, suffix: '%' },
            { label: 'Helpfulness', baseline: quality.baseline.avgHelpfulness, variant: quality.variant.avgHelpfulness, delta: cmp.helpfulnessImprovement },
            { label: 'Tone', baseline: quality.baseline.avgTone, variant: quality.variant.avgTone, delta: cmp.toneImprovement },
            { label: 'Resolution', baseline: quality.baseline.avgResolution, variant: quality.variant.avgResolution, delta: cmp.resolutionImprovement },
          ].map(item => (
            <div key={item.label} className="p-2 bg-surface-hover rounded-lg text-center">
              <p className="text-xs text-text-muted mb-1">{item.label}</p>
              <div className="flex items-center justify-center gap-2 text-xs">
                <span className="text-text-secondary">{item.baseline.toFixed(1)}{item.suffix || ''}</span>
                <span className="text-text-muted">→</span>
                <span className="font-bold text-text-primary">{item.variant.toFixed(1)}{item.suffix || ''}</span>
              </div>
              {item.delta !== 0 && (
                <div className={`flex items-center justify-center gap-1 mt-1 text-xs font-medium ${
                  item.delta > 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                }`}>
                  {item.delta > 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                  {item.delta > 0 ? '+' : ''}{item.delta.toFixed(1)}{item.suffix || ''}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {quality.frictionPoints && quality.frictionPoints.length > 0 && (
        <div className="mt-3">
          <h5 className="text-xs font-medium text-red-600 dark:text-red-400 mb-1">Friction Points</h5>
          <ul className="space-y-1">
            {quality.frictionPoints.map((fp, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-red-600 dark:text-red-300">
                <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                {fp}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ForecastsView({
  forecasts, onGenerate, loading,
}: {
  forecasts: ForecastModel[];
  onGenerate: (type: string, days: number) => void;
  loading: boolean;
}) {
  const forecastTypes = [
    { type: 'call_volume', label: 'Call Volume', icon: PhoneCall },
    { type: 'booking_rate', label: 'Booking Rate', icon: CheckCircle },
    { type: 'revenue', label: 'Revenue', icon: DollarSign },
    { type: 'staffing_needs', label: 'Staffing Needs', icon: Users },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-surface rounded-xl border border-border p-5">
        <h3 className="font-semibold text-text-primary mb-1">Generate Forecast</h3>
        <p className="text-sm text-text-secondary mb-4">Project future operational metrics based on historical patterns</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {forecastTypes.map(ft => (
            <button
              key={ft.type}
              onClick={() => onGenerate(ft.type, 30)}
              disabled={loading}
              className="flex flex-col items-center gap-2 p-4 bg-surface-hover rounded-lg border border-border hover:border-purple-300 transition-colors disabled:opacity-50"
            >
              {loading ? <RefreshCw className="w-5 h-5 animate-spin text-purple-500" /> : <ft.icon className="w-5 h-5 text-purple-500" />}
              <span className="text-sm font-medium text-text-primary">{ft.label}</span>
              <span className="text-xs text-text-muted">30-day forecast</span>
            </button>
          ))}
        </div>
      </div>

      {forecasts.length > 0 && (
        <div className="space-y-4">
          {forecasts.map(f => (
            <ForecastCard key={f.id} forecast={f} />
          ))}
        </div>
      )}

      {forecasts.length === 0 && (
        <p className="text-center text-text-muted py-8">No forecasts generated yet. Click a forecast type above to begin.</p>
      )}
    </div>
  );
}

function ForecastCard({ forecast }: { forecast: ForecastModel }) {
  const [expanded, setExpanded] = useState(false);
  const currency = useTenantCurrency();
  const p = forecast.projections;
  const typeLabels: Record<string, string> = {
    call_volume: 'Call Volume Forecast',
    booking_rate: 'Booking Rate Forecast',
    revenue: 'Revenue Forecast',
    staffing_needs: 'Staffing Needs Forecast',
  };

  const first = p[0];
  const last = p[p.length - 1];
  const trend = last && first ? ((last.value - first.value) / Math.max(first.value, 1)) * 100 : 0;
  const avg = p.length > 0 ? p.reduce((sum, pp) => sum + pp.value, 0) / p.length : 0;

  const formatValue = (v: number) => {
    if (forecast.forecastType === 'booking_rate') return `${(v * 100).toFixed(1)}%`;
    if (forecast.forecastType === 'revenue') return formatCentsHelper(v, { currency, minimumFractionDigits: 0, maximumFractionDigits: 0 });
    return String(Math.round(v));
  };

  return (
    <div className="bg-surface rounded-xl border border-border p-5">
      <div className="flex items-center justify-between mb-3 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div>
          <h4 className="font-semibold text-text-primary">{typeLabels[forecast.forecastType] || forecast.forecastType}</h4>
          <p className="text-xs text-text-secondary">
            {forecast.horizonDays}-day forecast | {(forecast.confidenceLevel * 100).toFixed(0)}% confidence | Generated {new Date(forecast.generatedAt).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-1 text-sm font-medium ${trend >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {trend >= 0 ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
            {Math.abs(trend).toFixed(1)}%
          </div>
          {expanded ? <ChevronDown className="w-5 h-5 text-text-muted" /> : <ChevronRight className="w-5 h-5 text-text-muted" />}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-3">
        <div className="text-center p-2 bg-surface-hover rounded">
          <p className="text-xs text-text-muted">Start</p>
          <p className="font-medium text-sm text-text-primary">{first ? formatValue(first.value) : '-'}</p>
        </div>
        <div className="text-center p-2 bg-surface-hover rounded">
          <p className="text-xs text-text-muted">Average</p>
          <p className="font-medium text-sm text-text-primary">{formatValue(avg)}</p>
        </div>
        <div className="text-center p-2 bg-surface-hover rounded">
          <p className="text-xs text-text-muted">End</p>
          <p className="font-medium text-sm text-text-primary">{last ? formatValue(last.value) : '-'}</p>
        </div>
      </div>

      {expanded && p.length > 0 && (
        <div className="mt-4">
          <div className="h-32 flex items-end gap-0.5">
            {p.map((point, i) => {
              const maxVal = Math.max(...p.map(pp => pp.upperBound || pp.value));
              const height = maxVal > 0 ? (point.value / maxVal) * 100 : 0;
              return (
                <div key={i} className="flex-1 group relative" title={`${point.date}: ${formatValue(point.value)}`}>
                  <div
                    className="bg-purple-500 dark:bg-purple-400 rounded-t-sm transition-all hover:bg-purple-600"
                    style={{ height: `${height}%`, minHeight: '2px' }}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-[10px] text-text-muted">{first?.date}</span>
            <span className="text-[10px] text-text-muted">{last?.date}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateModelModal({
  onClose, onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, start: string, end: string) => void;
}) {
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [creating, setCreating] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  useEffect(() => {
    setStartDate(thirtyDaysAgo);
    setEndDate(today);
    setName(`Digital Twin ${new Date().toLocaleDateString()}`);
  }, []);

  const handleSubmit = async () => {
    if (!name || !startDate || !endDate) return;
    setCreating(true);
    await onCreate(name, startDate, endDate);
    setCreating(false);
  };

  return (
    <Modal open onClose={onClose} ariaLabel="Create Digital Twin Model" panelClassName="bg-surface rounded-xl p-6 w-full max-w-md shadow-xl">
        <h2 className="text-lg font-bold text-text-primary mb-4">Create Digital Twin Model</h2>
        <p className="text-sm text-text-secondary mb-4">
          Snapshot your operational history to create a simulation baseline.
        </p>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Model Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">End Date</label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary"
              />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-text-secondary hover:text-text-primary">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name || !startDate || !endDate || creating}
            className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create Model'}
          </button>
        </div>
    </Modal>
  );
}
