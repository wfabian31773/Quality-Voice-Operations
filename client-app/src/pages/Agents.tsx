import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Plus, Pencil, Trash2, X, Bot, Wrench, Workflow, Globe, Calendar, AlertTriangle } from 'lucide-react';
import TooltipWalkthrough from '../components/TooltipWalkthrough';
import { useRole } from '../lib/useRole';

interface Agent {
  id: string;
  name: string;
  type: string;
  status: string;
  voice: string;
  model: string;
  system_prompt: string;
  welcome_greeting: string;
  temperature: number;
  tools: Record<string, unknown>[];
  execution_mode?: string;
  remote_system?: string;
  remote_agent_id?: string;
  last_sync_at?: string;
  scheduling_provider?: string | null;
  created_at: string;
}

interface ConnectorListItem {
  integrationId: string;
  connectorType: string;
  provider: string;
  name?: string;
  isEnabled: boolean;
}

interface AgentToolInfo {
  name: string;
  enabled: boolean;
  allowedByTemplate: boolean;
  deniedByTemplate: boolean;
  hasOverride: boolean;
}

interface AgentToolsResponse {
  tools: AgentToolInfo[];
  agentType: string;
  templatePermissions: { allowedTools: string[]; deniedTools: string[] };
}

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'];
const MODELS = ['gpt-4o-realtime-preview', 'gpt-4o-mini-realtime-preview'];
const AGENT_TYPES = [
  'general', 'answering-service', 'medical-after-hours', 'outbound-scheduling',
  'appointment-confirmation', 'custom', 'dental', 'property-management',
  'home-services', 'legal', 'customer-support', 'outbound-sales',
  'technical-support', 'collections',
];

const TOOL_LABELS: Record<string, string> = {
  createServiceTicket: 'Create Service Ticket',
  createAfterHoursTicket: 'Create After-Hours Ticket',
  triageEscalate: 'Triage Escalation',
  scheduleDentalAppointment: 'Schedule Dental Appointment',
  scheduleConsultation: 'Schedule Legal Consultation',
  submitMaintenanceRequest: 'Submit Maintenance Request',
  bookServiceAppointment: 'Book Service Appointment',
};

interface AgentFormData {
  name: string;
  type: string;
  voice: string;
  model: string;
  system_prompt: string;
  welcome_greeting: string;
  temperature: number;
  scheduling_provider: string;
}

interface SchedulingConnectorOption {
  provider: string;
  name: string;
}

const SCHEDULING_PROVIDER_LABELS: Record<string, string> = {
  'google-calendar': 'Google Calendar',
  'outlook-calendar': 'Outlook Calendar',
};

function formatSchedulingProvider(provider: string, fallback?: string): string {
  return SCHEDULING_PROVIDER_LABELS[provider] ?? fallback ?? provider;
}

function fetchSchedulingConnectors(): Promise<SchedulingConnectorOption[]> {
  return api
    .get<{ connectors: ConnectorListItem[] }>('/connectors?limit=100')
    .then((res) => {
      const enabled = (res.connectors ?? []).filter(
        (c) => c.connectorType === 'scheduling' && c.isEnabled,
      );
      return enabled.map((c) => ({
        provider: c.provider,
        name: c.name && c.name !== c.provider ? c.name : formatSchedulingProvider(c.provider),
      }));
    });
}

function ToolsConfigSection({ agentId }: { agentId: string }) {
  const [tools, setTools] = useState<AgentToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    api.get<AgentToolsResponse>(`/agents/${agentId}/tools`).then((res) => {
      setTools(res.tools);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [agentId]);

  const handleToggle = (toolName: string) => {
    setTools((prev) =>
      prev.map((t) =>
        t.name === toolName ? { ...t, enabled: !t.enabled, hasOverride: true } : t,
      ),
    );
    setSaveMessage(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      const overrides = tools.map((t) => ({ toolName: t.name, enabled: t.enabled }));
      await api.patch(`/agents/${agentId}/tools`, { overrides });
      setSaveMessage('Tool permissions saved');
      setTools((prev) => prev.map((t) => ({ ...t, hasOverride: true })));
    } catch (err) {
      setSaveMessage('Failed to save tool permissions');
    }
    setSaving(false);
  };

  if (loading) {
    return <div className="text-sm text-text-secondary py-2">Loading tools...</div>;
  }

  if (tools.length === 0) {
    return <div className="text-sm text-text-secondary py-2">No tools available for this agent type.</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-text-primary">Tool Permissions</label>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="text-xs font-medium text-primary hover:text-primary-hover transition disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Tools'}
        </button>
      </div>
      <div className="space-y-1">
        {tools.map((t) => (
          <div
            key={t.name}
            className="flex items-center justify-between px-3 py-2 rounded-lg border border-border bg-surface hover:bg-surface-hover transition"
          >
            <div className="flex-1 min-w-0">
              <span className="text-sm text-text-primary">{TOOL_LABELS[t.name] ?? t.name}</span>
              {t.allowedByTemplate && !t.hasOverride && (
                <span className="ml-2 text-xs text-green-600 dark:text-green-400">(template default)</span>
              )}
              {t.hasOverride && (
                <span className="ml-2 text-xs text-blue-600 dark:text-blue-400">(custom)</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => handleToggle(t.name)}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                t.enabled ? 'bg-primary' : 'bg-gray-300'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-surface shadow ring-0 transition duration-200 ease-in-out ${
                  t.enabled ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        ))}
      </div>
      {saveMessage && (
        <p className={`text-xs ${saveMessage.includes('Failed') ? 'text-danger' : 'text-green-600 dark:text-green-400'}`}>
          {saveMessage}
        </p>
      )}
    </div>
  );
}

function AgentModal({
  agentId,
  schedulingOptions,
  onClose,
  onSaved,
}: {
  agentId?: string;
  schedulingOptions: SchedulingConnectorOption[];
  onClose: () => void;
  onSaved: (newAgentId?: string) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<AgentFormData>({
    name: '',
    type: 'general',
    voice: 'alloy',
    model: 'gpt-4o-realtime-preview',
    system_prompt: '',
    welcome_greeting: '',
    temperature: 0.7,
    scheduling_provider: '',
  });
  const [loaded, setLoaded] = useState(!agentId);
  const [activeTab, setActiveTab] = useState<'general' | 'tools'>('general');

  useEffect(() => {
    if (!agentId) return;
    api.get<{ agent: Agent }>(`/agents/${agentId}`).then((res) => {
      const a = res.agent;
      setForm({
        name: a.name ?? '',
        type: a.type ?? 'general',
        voice: a.voice ?? 'alloy',
        model: a.model ?? 'gpt-4o-realtime-preview',
        system_prompt: a.system_prompt ?? '',
        welcome_greeting: a.welcome_greeting ?? '',
        temperature: a.temperature ?? 0.7,
        scheduling_provider: a.scheduling_provider ?? '',
      });
      setLoaded(true);
    });
  }, [agentId]);

  const mutation = useMutation({
    mutationFn: (data: AgentFormData) => {
      const payload: Record<string, unknown> = {
        ...data,
        scheduling_provider: data.scheduling_provider || null,
      };
      return agentId
        ? api.patch<Record<string, unknown>>(`/agents/${agentId}`, payload)
        : api.post<{ agent: { id: string } }>('/agents', payload);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      const newId = !agentId && result && typeof result === 'object' && 'agent' in result
        ? (result as { agent: { id: string } }).agent.id
        : undefined;
      onSaved(newId);
      onClose();
    },
  });

  const set = (key: keyof AgentFormData, val: string | number) => setForm((f) => ({ ...f, [key]: val }));

  if (!loaded) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
        <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg p-8 text-center text-text-secondary">
          Loading agent...
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">{agentId ? 'Edit Agent' : 'Create Agent'}</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary"><X className="h-5 w-5" /></button>
        </div>

        {agentId && (
          <div className="flex border-b border-border px-5">
            <button
              type="button"
              onClick={() => setActiveTab('general')}
              className={`px-3 py-2 text-sm font-medium border-b-2 transition ${
                activeTab === 'general'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              General
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('tools')}
              className={`px-3 py-2 text-sm font-medium border-b-2 transition inline-flex items-center gap-1.5 ${
                activeTab === 'tools'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              <Wrench className="h-3.5 w-3.5" /> Tools
            </button>
          </div>
        )}

        {activeTab === 'general' ? (
          <form
            onSubmit={(e) => { e.preventDefault(); mutation.mutate(form); }}
            className="p-5 space-y-4"
          >
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Name</label>
              <input value={form.name} onChange={(e) => set('name', e.target.value)} required
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Type</label>
                <select value={form.type} onChange={(e) => set('type', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                  {AGENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Voice</label>
                <select value={form.voice} onChange={(e) => set('voice', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                  {VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Model</label>
                <select value={form.model} onChange={(e) => set('model', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                  {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">System Prompt</label>
              <textarea value={form.system_prompt} onChange={(e) => set('system_prompt', e.target.value)} rows={6}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Welcome Greeting</label>
              <input value={form.welcome_greeting} onChange={(e) => set('welcome_greeting', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Temperature: {form.temperature}</label>
              <input type="range" min="0" max="1" step="0.1" value={form.temperature}
                onChange={(e) => set('temperature', parseFloat(e.target.value))}
                className="w-full" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Scheduling Calendar</label>
              <select
                value={form.scheduling_provider}
                onChange={(e) => set('scheduling_provider', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Tenant default (any enabled)</option>
                {schedulingOptions.map((opt) => (
                  <option key={opt.provider} value={opt.provider}>
                    {opt.name}
                  </option>
                ))}
                {form.scheduling_provider &&
                  !schedulingOptions.some((o) => o.provider === form.scheduling_provider) && (
                    <option value={form.scheduling_provider}>
                      {formatSchedulingProvider(form.scheduling_provider)} (not connected)
                    </option>
                  )}
              </select>
              <p className="mt-1 text-xs text-text-secondary">
                Appointments booked by this agent are sent only to the chosen calendar. Phone-number setting overrides this.
              </p>
            </div>
            {mutation.error && <p className="text-danger text-sm">{(mutation.error as Error).message}</p>}
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary rounded-lg border border-border hover:bg-surface-hover transition">Cancel</button>
              <button type="submit" disabled={mutation.isPending}
                className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition disabled:opacity-50">
                {mutation.isPending ? 'Saving...' : agentId ? 'Update' : 'Create'}
              </button>
            </div>
          </form>
        ) : (
          <div className="p-5">
            {agentId && <ToolsConfigSection agentId={agentId} />}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Agents() {
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isManager } = useRole();
  const { data, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ agents: Agent[]; total: number }>('/agents?limit=100'),
  });

  const {
    data: schedulingOptions = [],
    isSuccess: connectorsLoaded,
  } = useQuery({
    queryKey: ['scheduling-connectors'],
    queryFn: fetchSchedulingConnectors,
  });

  const connectedProviders = new Set(schedulingOptions.map((o) => o.provider));


  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/agents/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agents'] }),
  });

  const agents = data?.agents ?? [];
  const enabledSchedulingProviders = connectedProviders;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Agents</h1>
          <p className="text-sm text-text-secondary mt-1">Manage your AI voice agents</p>
        </div>
        {isManager && (
          <TooltipWalkthrough
            tooltipKey="agents-create"
            title="Create Your First Agent"
            description="Start by creating an AI voice agent. Choose a template that matches your business type, then customize the greeting, tools, and escalation rules."
            position="left"
          >
            <button onClick={() => setEditingId('new')}
              className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2.5 rounded-lg transition">
              <Plus className="h-4 w-4" /> New Agent
            </button>
          </TooltipWalkthrough>
        )}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-text-secondary">Loading...</div>
      ) : agents.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <Bot className="h-12 w-12 text-text-muted mx-auto mb-3" />
          <p className="text-text-secondary">No agents yet. Create your first agent to get started.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => {
            const isFederated = agent.execution_mode === 'federated';
            const schedulingDrift = !!(
              agent.scheduling_provider &&
              !enabledSchedulingProviders.has(agent.scheduling_provider)
            );
            return (
            <div key={agent.id} className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-text-primary">{agent.name}</h3>
                  <p className="text-xs text-text-secondary mt-0.5">{agent.type} &middot; {agent.voice} &middot; {agent.model.replace('gpt-4o-', '').replace('-preview', '')}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  {isFederated && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                      <Globe className="h-3 w-3" /> External
                    </span>
                  )}
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${agent.status === 'active' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-surface-hover text-text-secondary'}`}>
                    {agent.status}
                  </span>
                </div>
              </div>
              {isFederated && (
                <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 mb-3 bg-blue-50 dark:bg-blue-900/10 rounded-lg px-3 py-2 border border-blue-200 dark:border-blue-800/30">
                  <Globe className="h-3.5 w-3.5 shrink-0" />
                  <span>Managed externally via {agent.remote_system ?? 'remote system'}{agent.last_sync_at ? ` · Last sync: ${new Date(agent.last_sync_at).toLocaleDateString()}` : ''}</span>
                </div>
              )}
              <div className="flex items-center gap-2 mb-3">
                {(() => {
                  const provider = agent.scheduling_provider;
                  const isDisconnected =
                    !!provider && connectorsLoaded && !connectedProviders.has(provider);
                  if (isDisconnected) {
                    return (
                      <button
                        type="button"
                        onClick={() =>
                          navigate(`/connectors?provider=${encodeURIComponent(provider)}`)
                        }
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800/50 hover:bg-amber-200 dark:hover:bg-amber-900/50 transition cursor-pointer"
                        title={`${formatSchedulingProvider(provider)} is no longer connected. Click to reconnect this calendar in Integrations.`}
                      >
                        <AlertTriangle className="h-3 w-3" />
                        {formatSchedulingProvider(provider)} (not connected)
                      </button>
                    );
                  }
                  return (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-surface-hover text-text-secondary border border-border"
                      title={
                        provider
                          ? `Books appointments into ${formatSchedulingProvider(provider)}`
                          : 'Uses the tenant default scheduling calendar'
                      }
                    >
                      <Calendar className="h-3 w-3" />
                      {provider ? formatSchedulingProvider(provider) : 'Default'}
                    </span>
                  );
                })()}
              </div>
              {schedulingDrift && (
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      `/connectors?provider=${encodeURIComponent(agent.scheduling_provider!)}`,
                    )
                  }
                  className="w-full text-left flex items-start gap-2 text-xs mb-3 bg-amber-50 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-800/40 rounded-lg px-3 py-2 hover:bg-amber-100 dark:hover:bg-amber-900/25 transition"
                  title="Open Integrations to reconnect this calendar"
                >
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                  <span className="text-amber-800 dark:text-amber-200">
                    {formatSchedulingProvider(agent.scheduling_provider!)} isn't connected.
                    Appointments booked by this agent won't sync until you reconnect it.
                    <span className="ml-1 font-semibold underline">Reconnect →</span>
                  </span>
                </button>
              )}
              {!isFederated && agent.system_prompt && (
                <p className="text-xs text-text-secondary line-clamp-2 mb-4">{agent.system_prompt}</p>
              )}
              {isManager && !isFederated && (
                <div className="flex items-center gap-2 pt-2 border-t border-border">
                  <button onClick={() => navigate(`/agents/${agent.id}/builder`)} className="text-text-secondary hover:text-primary text-xs font-medium inline-flex items-center gap-1 transition">
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                  <button onClick={() => setEditingId(agent.id)} className="text-text-secondary hover:text-primary text-xs font-medium inline-flex items-center gap-1 transition">
                    <Workflow className="h-3.5 w-3.5" /> Quick Settings
                  </button>
                  <button onClick={() => { if (confirm('Delete this agent?')) deleteMut.mutate(agent.id); }}
                    className="text-text-secondary hover:text-danger text-xs font-medium inline-flex items-center gap-1 transition ml-auto">
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </button>
                </div>
              )}
              {isFederated && (
                <div className="pt-2 border-t border-border">
                  <p className="text-xs text-text-muted">Analytics and call logs are available. Agent configuration is managed in {agent.remote_system ?? 'the remote system'}.</p>
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}

      {editingId && (
        <AgentModal
          agentId={editingId === 'new' ? undefined : editingId}
          schedulingOptions={schedulingOptions}
          onClose={() => setEditingId(null)}
          onSaved={(newAgentId?: string) => {
            if (newAgentId) {
              navigate(`/agents/${newAgentId}/builder`);
            }
          }}
        />
      )}
    </div>
  );
}
