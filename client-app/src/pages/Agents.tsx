import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Plus, Pencil, Trash2, X, Bot, Wrench, Workflow, Globe, Calendar, AlertTriangle } from 'lucide-react';
import TooltipWalkthrough from '../components/TooltipWalkthrough';
import { useRole } from '../lib/useRole';
import { EmptyState, SkeletonGrid } from '../components/state';
import { PageHeader } from '../components/ui';
import Modal from '../components/Modal';
import VoicePicker from '../components/VoicePicker';
import {
  AGENT_LANGUAGES,
  DEFAULT_AGENT_LANGUAGE,
  getAgentLanguageLabel,
  getDefaultVoiceForLanguage,
  isVoiceRecommendedForLanguage,
  normalizeAgentLanguage,
} from '../lib/agentLanguages';
import {
  type AgentBuilderTKey,
  type IndustryTemplateKey,
  getDefaultWelcomeGreeting,
  getDefaultSystemPrompt,
  getIndustryTemplateCopy,
  isDefaultGreeting,
  isDefaultSystemPrompt,
  isTemplateOrDefaultGreeting,
  isTemplateOrDefaultSystemPrompt,
  makeBuilderT,
} from '../lib/agentBuilderI18n';
import { useTenantPrimaryLanguage } from '../hooks/useTenantPrimaryLanguage';

/**
 * Maps the quick-create agent-type slug to an industry template key when one
 * exists. When the type maps to a template we seed the welcome greeting and
 * system prompt with the localized industry copy (falling back to English
 * with a hint when the language has no translation yet). Types not listed
 * here keep the generic localized defaults.
 */
const AGENT_TYPE_TO_TEMPLATE: Record<string, IndustryTemplateKey> = {
  'medical-after-hours': 'medical',
  'dental': 'dental',
  'home-services': 'hvac',
  'legal': 'legal',
  'customer-support': 'support',
  'technical-support': 'support',
  'real-estate': 'realestate',
  'restaurant': 'restaurant',
  'salon': 'salon',
};

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
  language?: string;
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

const MODELS = ['gpt-4o-realtime-preview', 'gpt-4o-mini-realtime-preview'];
const AGENT_TYPES = [
  'general', 'answering-service', 'medical-after-hours', 'outbound-scheduling',
  'appointment-confirmation', 'custom', 'dental', 'property-management',
  'home-services', 'legal', 'customer-support', 'outbound-sales',
  'technical-support', 'collections', 'real-estate', 'restaurant', 'salon',
];

/**
 * Maps each agent-type slug to its localized label key in the Agent Builder
 * i18n table. Keeps the underlying slug intact for backend validation while
 * showing friendly, translated names in the dropdown.
 */
const AGENT_TYPE_LABEL_KEYS: Record<string, AgentBuilderTKey> = {
  'general': 'agentTypeGeneral',
  'answering-service': 'agentTypeAnsweringService',
  'medical-after-hours': 'agentTypeMedicalAfterHours',
  'outbound-scheduling': 'agentTypeOutboundScheduling',
  'appointment-confirmation': 'agentTypeAppointmentConfirmation',
  'custom': 'agentTypeCustom',
  'dental': 'agentTypeDental',
  'property-management': 'agentTypePropertyManagement',
  'home-services': 'agentTypeHomeServices',
  'legal': 'agentTypeLegal',
  'customer-support': 'agentTypeCustomerSupport',
  'outbound-sales': 'agentTypeOutboundSales',
  'technical-support': 'agentTypeTechnicalSupport',
  'collections': 'agentTypeCollections',
  'real-estate': 'agentTypeRealEstate',
  'restaurant': 'agentTypeRestaurant',
  'salon': 'agentTypeSalon',
};

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
  language: string;
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
  prefillRecommendedVoice = false,
  onClose,
  onSaved,
}: {
  agentId?: string;
  schedulingOptions: SchedulingConnectorOption[];
  prefillRecommendedVoice?: boolean;
  onClose: () => void;
  onSaved: (newAgentId?: string) => void;
}) {
  const tenantPrimaryLanguage = useTenantPrimaryLanguage();
  const [form, setForm] = useState<AgentFormData>(() => {
    const initialLanguage = agentId ? DEFAULT_AGENT_LANGUAGE : tenantPrimaryLanguage;
    return {
      name: '',
      type: 'general',
      voice: getDefaultVoiceForLanguage(initialLanguage),
      model: 'gpt-4o-realtime-preview',
      language: initialLanguage,
      system_prompt: getDefaultSystemPrompt(initialLanguage),
      welcome_greeting: getDefaultWelcomeGreeting(initialLanguage),
      temperature: 0.7,
      scheduling_provider: '',
    };
  });
  const [loaded, setLoaded] = useState(!agentId);

  // For new agents, sync the default language (and the localized greeting /
  // system prompt) once the tenant's primary language resolves — the initial
  // value may have been the English fallback if the tenant query was still
  // in-flight on first render.
  useEffect(() => {
    if (agentId) return;
    setForm((f) => {
      if (f.language !== DEFAULT_AGENT_LANGUAGE) return f;
      if (tenantPrimaryLanguage === DEFAULT_AGENT_LANGUAGE) return f;
      const next: AgentFormData = {
        ...f,
        language: tenantPrimaryLanguage,
        voice: getDefaultVoiceForLanguage(tenantPrimaryLanguage),
      };
      if (!f.welcome_greeting || isDefaultGreeting(f.welcome_greeting)) {
        next.welcome_greeting = getDefaultWelcomeGreeting(tenantPrimaryLanguage);
      }
      if (!f.system_prompt || isDefaultSystemPrompt(f.system_prompt)) {
        next.system_prompt = getDefaultSystemPrompt(tenantPrimaryLanguage);
      }
      return next;
    });
  }, [agentId, tenantPrimaryLanguage]);
  const [activeTab, setActiveTab] = useState<'general' | 'tools'>('general');

  useEffect(() => {
    if (!agentId) return;
    api.get<{ agent: Agent & { language?: string } }>(`/agents/${agentId}`).then((res) => {
      const a = res.agent;
      const language = normalizeAgentLanguage(a.language);
      const savedVoice = a.voice ?? getDefaultVoiceForLanguage(language);
      const voice = prefillRecommendedVoice && !isVoiceRecommendedForLanguage(savedVoice, language)
        ? getDefaultVoiceForLanguage(language)
        : savedVoice;
      setForm({
        name: a.name ?? '',
        type: a.type ?? 'general',
        voice,
        model: a.model ?? 'gpt-4o-realtime-preview',
        language,
        system_prompt: a.system_prompt ?? '',
        welcome_greeting: a.welcome_greeting ?? '',
        temperature: a.temperature ?? 0.7,
        scheduling_provider: a.scheduling_provider ?? '',
      });
      setLoaded(true);
    });
  }, [agentId, prefillRecommendedVoice]);

  const queryClient = useQueryClient();

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

  const isNewAgent = !agentId;
  const [templateFallbackHint, setTemplateFallbackHint] = useState<string | null>(null);
  const set = (key: keyof AgentFormData, val: string | number) =>
    setForm((f) => {
      if (key === 'language' && typeof val === 'string') {
        const newLang = normalizeAgentLanguage(val);
        const next = { ...f, language: newLang };
        if (isNewAgent) {
          next.voice = getDefaultVoiceForLanguage(newLang);
        }
        // If the agent type maps to an industry template, prefer the
        // industry-localized copy so the greeting and prompt stay aligned
        // with the chosen language and template.
        const templateKey = AGENT_TYPE_TO_TEMPLATE[f.type];
        if (templateKey) {
          const copy = getIndustryTemplateCopy(newLang, templateKey);
          if (!f.welcome_greeting || isTemplateOrDefaultGreeting(f.welcome_greeting)) {
            next.welcome_greeting = copy.welcomeGreeting;
          }
          if (!f.system_prompt || isTemplateOrDefaultSystemPrompt(f.system_prompt)) {
            next.system_prompt = copy.systemPrompt;
          }
          setTemplateFallbackHint(
            copy.usedEnglishFallback
              ? makeBuilderT(newLang)('templateFallbackHint', {
                  language: getAgentLanguageLabel(newLang),
                })
              : null,
          );
        } else {
          if (!f.welcome_greeting || isDefaultGreeting(f.welcome_greeting)) {
            next.welcome_greeting = getDefaultWelcomeGreeting(newLang);
          }
          if (!f.system_prompt || isDefaultSystemPrompt(f.system_prompt)) {
            next.system_prompt = getDefaultSystemPrompt(newLang);
          }
          setTemplateFallbackHint(null);
        }
        return next;
      }
      if (key === 'type' && typeof val === 'string') {
        const next = { ...f, type: val };
        const templateKey = AGENT_TYPE_TO_TEMPLATE[val];
        if (templateKey) {
          const copy = getIndustryTemplateCopy(f.language, templateKey);
          if (!f.welcome_greeting || isTemplateOrDefaultGreeting(f.welcome_greeting)) {
            next.welcome_greeting = copy.welcomeGreeting;
          }
          if (!f.system_prompt || isTemplateOrDefaultSystemPrompt(f.system_prompt)) {
            next.system_prompt = copy.systemPrompt;
          }
          setTemplateFallbackHint(
            copy.usedEnglishFallback
              ? makeBuilderT(f.language)('templateFallbackHint', {
                  language: getAgentLanguageLabel(f.language),
                })
              : null,
          );
        } else {
          setTemplateFallbackHint(null);
        }
        return next;
      }
      return { ...f, [key]: val };
    });

  if (!loaded) {
    return (
      <Modal open onClose={onClose} ariaLabel="Loading agent" panelClassName="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg p-8 text-center text-text-secondary">
        Loading agent...
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} ariaLabel={agentId ? 'Edit Agent' : 'Create Agent'} panelClassName="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">{agentId ? 'Edit Agent' : 'Create Agent'}</h2>
          <button onClick={onClose} aria-label="Close" className="text-text-secondary hover:text-text-primary"><X className="h-5 w-5" /></button>
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
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Type</label>
                <select value={form.type} onChange={(e) => set('type', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                  {AGENT_TYPES.map((slug) => {
                    const labelKey = AGENT_TYPE_LABEL_KEYS[slug];
                    const label = labelKey ? makeBuilderT(form.language)(labelKey) : slug;
                    return <option key={slug} value={slug}>{label}</option>;
                  })}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Language</label>
                <select value={form.language} onChange={(e) => set('language', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                  {AGENT_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}{l.nativeLabel !== l.label ? ` (${l.nativeLabel})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Model</label>
              <select value={form.model} onChange={(e) => set('model', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            {templateFallbackHint && (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                {templateFallbackHint}
              </div>
            )}
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
            <VoicePicker
              voice={form.voice}
              language={form.language}
              welcomeGreeting={form.welcome_greeting}
              onChange={(next) => set('voice', next)}
              labelClassName="block text-sm font-medium text-text-primary mb-1"
            />
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
    </Modal>
  );
}

export default function Agents() {
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [prefillRecommendedVoice, setPrefillRecommendedVoice] = useState(false);
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

  const mismatchedAgents = agents
    .filter((agent) => {
      const isFederated = agent.execution_mode === 'federated';
      if (isFederated || !agent.voice) return false;
      const language = normalizeAgentLanguage(agent.language);
      return !isVoiceRecommendedForLanguage(agent.voice, language);
    })
    .map((agent) => ({
      id: agent.id,
      recommendedVoice: getDefaultVoiceForLanguage(normalizeAgentLanguage(agent.language)),
    }));

  const [bulkFixState, setBulkFixState] = useState<
    { status: 'idle' } | { status: 'running' } | { status: 'error'; message: string }
  >({ status: 'idle' });

  const BULK_FIX_CONCURRENCY = 5;

  const bulkFixMutation = useMutation({
    mutationFn: async (
      targets: Array<{ id: string; recommendedVoice: string }>,
    ) => {
      let failureCount = 0;
      for (let i = 0; i < targets.length; i += BULK_FIX_CONCURRENCY) {
        const slice = targets.slice(i, i + BULK_FIX_CONCURRENCY);
        const results = await Promise.allSettled(
          slice.map((t) => api.patch(`/agents/${t.id}`, { voice: t.recommendedVoice })),
        );
        failureCount += results.filter((r) => r.status === 'rejected').length;
      }
      return { total: targets.length, failureCount };
    },
    onMutate: () => setBulkFixState({ status: 'running' }),
    onSuccess: ({ failureCount, total }) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      if (failureCount > 0) {
        setBulkFixState({
          status: 'error',
          message: `Updated ${total - failureCount} of ${total} agents. ${failureCount} failed — please retry.`,
        });
      } else {
        setBulkFixState({ status: 'idle' });
      }
    },
    onError: (err: unknown) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      const message = err instanceof Error ? err.message : 'Bulk fix failed';
      setBulkFixState({ status: 'error', message });
    },
  });

  const handleBulkFixVoices = () => {
    if (mismatchedAgents.length === 0) return;
    const confirmed = window.confirm(
      mismatchedAgents.length === 1
        ? `Switch 1 agent to its recommended voice?`
        : `Switch all ${mismatchedAgents.length} agents to their recommended voices?`,
    );
    if (!confirmed) return;
    bulkFixMutation.mutate(
      mismatchedAgents.map((a) => ({ id: a.id, recommendedVoice: a.recommendedVoice })),
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        description="Manage your AI voice agents"
        actions={isManager ? (
          <TooltipWalkthrough
            tooltipKey="agents-create"
            title="Create Your First Agent"
            description="Start by creating an AI voice agent. Choose a template that matches your business type, then customize the greeting, tools, and escalation rules."
            position="left"
          >
            <button onClick={() => setEditingId('new')}
              className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
              <Plus className="h-4 w-4" /> New Agent
            </button>
          </TooltipWalkthrough>
        ) : undefined}
      />

      {!isLoading && isManager && mismatchedAgents.length > 0 && (
        <div
          role="status"
          className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-800/50 dark:bg-amber-900/20"
        >
          <div className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">
                {mismatchedAgents.length === 1
                  ? '1 agent is using a voice not recommended for its language.'
                  : `${mismatchedAgents.length} agents are using a voice not recommended for their language.`}
              </p>
              {bulkFixState.status === 'error' && (
                <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                  {bulkFixState.message}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={handleBulkFixVoices}
            disabled={bulkFixState.status === 'running'}
            className="inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-600 text-white hover:bg-amber-700 transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {bulkFixState.status === 'running'
              ? 'Switching voices…'
              : 'Switch all to recommended voices'}
          </button>
        </div>
      )}

      {isLoading ? (
        <SkeletonGrid count={6} />
      ) : agents.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl">
          <EmptyState
            icon={Bot}
            title="No agents yet"
            description="Create your first agent to start handling calls."
            primaryAction={{
              label: 'New Agent',
              icon: Plus,
              onClick: () => setEditingId('new'),
            }}
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => {
            const isFederated = agent.execution_mode === 'federated';
            const schedulingDrift = !!(
              agent.scheduling_provider &&
              !enabledSchedulingProviders.has(agent.scheduling_provider)
            );
            const agentLanguage = normalizeAgentLanguage(agent.language);
            const voiceMismatch =
              !isFederated &&
              !!agent.voice &&
              !isVoiceRecommendedForLanguage(agent.voice, agentLanguage);
            const recommendedVoice = voiceMismatch ? getDefaultVoiceForLanguage(agentLanguage) : null;
            const languageLabel = getAgentLanguageLabel(agentLanguage);
            const openVoiceFix = () => {
              setPrefillRecommendedVoice(true);
              setEditingId(agent.id);
            };
            return (
            <div key={agent.id} className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-text-primary">{agent.name}</h3>
                  <p className="text-xs text-text-secondary mt-0.5">{agent.type} &middot; {agent.voice} &middot; {agent.model.replace('gpt-4o-', '').replace('-preview', '')}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  {voiceMismatch && isManager && (
                    <button
                      type="button"
                      onClick={openVoiceFix}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800/50 hover:bg-amber-200 dark:hover:bg-amber-900/50 transition cursor-pointer"
                      title={`"${agent.voice}" isn't recommended for ${languageLabel}. Click to switch to "${recommendedVoice}".`}
                      aria-label={`Voice ${agent.voice} not recommended for ${languageLabel}. Switch to ${recommendedVoice}.`}
                    >
                      <AlertTriangle className="h-3 w-3" />
                      Voice mismatch
                    </button>
                  )}
                  {voiceMismatch && !isManager && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800/50"
                      title={`"${agent.voice}" isn't recommended for ${languageLabel}. Recommended: "${recommendedVoice}".`}
                    >
                      <AlertTriangle className="h-3 w-3" />
                      Voice mismatch
                    </span>
                  )}
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
          prefillRecommendedVoice={prefillRecommendedVoice}
          onClose={() => {
            setEditingId(null);
            setPrefillRecommendedVoice(false);
          }}
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
