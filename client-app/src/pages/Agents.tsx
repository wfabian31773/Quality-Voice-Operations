import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../lib/api';
import { Plus, Pencil, Trash2, X, Bot, Wrench, Workflow, Globe, Calendar, AlertTriangle } from 'lucide-react';
import TooltipWalkthrough from '../components/TooltipWalkthrough';
import { useRole } from '../lib/useRole';
import { EmptyState, Skeleton, SkeletonGrid } from '../components/state';
import { PageHeader } from '../components/ui';
import Modal from '../components/Modal';
import SchedulingDriftBanner from '../components/SchedulingDriftBanner';
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
  getDefaultWelcomeGreeting,
  getDefaultSystemPrompt,
  getIndustryTemplateCopy,
  isDefaultGreeting,
  isDefaultSystemPrompt,
  isTemplateOrDefaultGreeting,
  isTemplateOrDefaultSystemPrompt,
  makeBuilderT,
} from '../lib/agentBuilderI18n';
import { AGENT_TYPE_TO_TEMPLATE } from '../lib/agentTypeTemplate';
import { buildIndustryTemplateDefinition } from '../lib/industryTemplates';
import { useTenantPrimaryLanguage } from '../hooks/useTenantPrimaryLanguage';

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

const TOOL_LABEL_KEYS: Record<string, string> = {
  createServiceTicket: 'agents.tools_section.tool_create_service_ticket',
  createAfterHoursTicket: 'agents.tools_section.tool_create_after_hours_ticket',
  triageEscalate: 'agents.tools_section.tool_triage_escalate',
  scheduleDentalAppointment: 'agents.tools_section.tool_schedule_dental_appointment',
  scheduleConsultation: 'agents.tools_section.tool_schedule_consultation',
  submitMaintenanceRequest: 'agents.tools_section.tool_submit_maintenance_request',
  bookServiceAppointment: 'agents.tools_section.tool_book_service_appointment',
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

function ToolsConfigSection({ agentId, t }: { agentId: string; t: TFunction }) {
  const [tools, setTools] = useState<AgentToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    api.get<AgentToolsResponse>(`/agents/${agentId}/tools`).then((res) => {
      setTools(res.tools);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [agentId]);

  const handleToggle = (toolName: string) => {
    setTools((prev) =>
      prev.map((tool) =>
        tool.name === toolName ? { ...tool, enabled: !tool.enabled, hasOverride: true } : tool,
      ),
    );
    setSaveMessage(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      const overrides = tools.map((tool) => ({ toolName: tool.name, enabled: tool.enabled }));
      await api.patch(`/agents/${agentId}/tools`, { overrides });
      setSaveMessage({ kind: 'success', text: t('agents.tools_section.save_success') });
      setTools((prev) => prev.map((tool) => ({ ...tool, hasOverride: true })));
    } catch (err) {
      setSaveMessage({ kind: 'error', text: t('agents.tools_section.save_error') });
    }
    setSaving(false);
  };

  if (loading) {
    return <div className="text-sm text-text-secondary py-2">{t('agents.tools_section.loading')}</div>;
  }

  if (tools.length === 0) {
    return <div className="text-sm text-text-secondary py-2">{t('agents.tools_section.empty')}</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-text-primary">{t('agents.tools_section.label')}</label>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="text-xs font-medium text-primary hover:text-primary-hover transition disabled:opacity-50"
        >
          {saving ? t('agents.tools_section.saving') : t('agents.tools_section.save_button')}
        </button>
      </div>
      <div className="space-y-1">
        {tools.map((tool) => {
          const labelKey = TOOL_LABEL_KEYS[tool.name];
          const label = labelKey ? t(labelKey) : tool.name;
          return (
            <div
              key={tool.name}
              className="flex items-center justify-between px-3 py-2 rounded-lg border border-border bg-surface hover:bg-surface-hover transition"
            >
              <div className="flex-1 min-w-0">
                <span className="text-sm text-text-primary">{label}</span>
                {tool.allowedByTemplate && !tool.hasOverride && (
                  <span className="ml-2 text-xs text-success dark:text-success">{t('agents.tools_section.template_default')}</span>
                )}
                {tool.hasOverride && (
                  <span className="ml-2 text-xs text-info dark:text-info">{t('agents.tools_section.custom')}</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => handleToggle(tool.name)}
                className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  tool.enabled ? 'bg-primary' : 'bg-border'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-surface shadow ring-0 transition duration-200 ease-in-out ${
                    tool.enabled ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          );
        })}
      </div>
      {saveMessage && (
        <p className={`text-xs ${saveMessage.kind === 'error' ? 'text-danger' : 'text-success dark:text-success'}`}>
          {saveMessage.text}
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
  const { t } = useTranslation('tenant');
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
      // For new agents, scaffold the matching starter graph so picking an
      // agent type here yields the same result as picking the template in
      // the visual builder. Existing agents are left alone so we don't
      // clobber operator-customised workflows on edit.
      if (!agentId) {
        const templateKey = AGENT_TYPE_TO_TEMPLATE[data.type];
        if (templateKey) {
          const def = buildIndustryTemplateDefinition(data.language, templateKey);
          if (def) payload.workflow_definition = def;
        }
      }
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
      <Modal open onClose={onClose} ariaLabel={t('agents.modal.loading_aria')} panelClassName="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg p-6">
        <div className="space-y-3" role="status" aria-busy="true" aria-live="polite" aria-label={t('agents.modal.loading_aria')}>
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-24 w-full" rounded="lg" />
        </div>
      </Modal>
    );
  }

  const modalTitle = agentId ? t('agents.modal.edit_title') : t('agents.modal.create_title');

  return (
    <Modal open onClose={onClose} ariaLabel={modalTitle} panelClassName="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">{modalTitle}</h2>
          <button onClick={onClose} aria-label={t('agents.modal.close_aria')} className="text-text-secondary hover:text-text-primary"><X className="h-5 w-5" /></button>
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
              {t('agents.modal.tab_general')}
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
              <Wrench className="h-3.5 w-3.5" /> {t('agents.modal.tab_tools')}
            </button>
          </div>
        )}

        {activeTab === 'general' ? (
          <form
            onSubmit={(e) => { e.preventDefault(); mutation.mutate(form); }}
            className="p-5 space-y-4"
          >
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">{t('agents.modal.field_name')}</label>
              <input value={form.name} onChange={(e) => set('name', e.target.value)} required
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">{t('agents.modal.field_type')}</label>
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
                <label className="block text-sm font-medium text-text-primary mb-1">{t('agents.modal.field_language')}</label>
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
              <label className="block text-sm font-medium text-text-primary mb-1">{t('agents.modal.field_model')}</label>
              <select value={form.model} onChange={(e) => set('model', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            {templateFallbackHint && (
              <div className="text-xs text-warning bg-warning-light border border-warning/30 rounded-md px-3 py-2">
                {templateFallbackHint}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">{t('agents.modal.field_system_prompt')}</label>
              <textarea value={form.system_prompt} onChange={(e) => set('system_prompt', e.target.value)} rows={6}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">{t('agents.modal.field_welcome_greeting')}</label>
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
              <label className="block text-sm font-medium text-text-primary mb-1">{t('agents.modal.field_temperature', { value: form.temperature })}</label>
              <input type="range" min="0" max="1" step="0.1" value={form.temperature}
                onChange={(e) => set('temperature', parseFloat(e.target.value))}
                className="w-full" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">{t('agents.modal.field_scheduling_calendar')}</label>
              <select
                value={form.scheduling_provider}
                onChange={(e) => set('scheduling_provider', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">{t('agents.modal.scheduling_default_option')}</option>
                {schedulingOptions.map((opt) => (
                  <option key={opt.provider} value={opt.provider}>
                    {opt.name}
                  </option>
                ))}
                {form.scheduling_provider &&
                  !schedulingOptions.some((o) => o.provider === form.scheduling_provider) && (
                    <option value={form.scheduling_provider}>
                      {t('agents.modal.scheduling_not_connected_suffix', { provider: formatSchedulingProvider(form.scheduling_provider) })}
                    </option>
                  )}
              </select>
              <p className="mt-1 text-xs text-text-secondary">
                {t('agents.modal.scheduling_help')}
              </p>
            </div>
            {mutation.error && <p className="text-danger text-sm">{(mutation.error as Error).message}</p>}
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary rounded-lg border border-border hover:bg-surface-hover transition">{t('agents.modal.cancel')}</button>
              <button type="submit" disabled={mutation.isPending}
                className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition disabled:opacity-50">
                {mutation.isPending ? t('agents.modal.saving') : agentId ? t('agents.modal.update') : t('agents.modal.create')}
              </button>
            </div>
          </form>
        ) : (
          <div className="p-5">
            {agentId && <ToolsConfigSection agentId={agentId} t={t} />}
          </div>
        )}
    </Modal>
  );
}

export default function Agents() {
  const { t: tenantT } = useTranslation('tenant');
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

  const agentsWithDisconnectedCalendar = connectorsLoaded
    ? agents.filter(
        (a) =>
          !!a.scheduling_provider &&
          !enabledSchedulingProviders.has(a.scheduling_provider),
      )
    : [];
  const disconnectedAgentProviders = Array.from(
    new Set(
      agentsWithDisconnectedCalendar
        .map((a) => a.scheduling_provider)
        .filter((p): p is string => !!p),
    ),
  );

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
          slice.map((target) => api.patch(`/agents/${target.id}`, { voice: target.recommendedVoice })),
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
          message: tenantT('agents.bulk_voice_fix.error_partial', {
            success: total - failureCount,
            total,
            failed: failureCount,
          }),
        });
      } else {
        setBulkFixState({ status: 'idle' });
      }
    },
    onError: (err: unknown) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      const message = err instanceof Error ? err.message : tenantT('agents.bulk_voice_fix.error_default');
      setBulkFixState({ status: 'error', message });
    },
  });

  const handleBulkFixVoices = () => {
    if (mismatchedAgents.length === 0) return;
    const confirmed = window.confirm(
      tenantT('agents.bulk_voice_fix.confirm', { count: mismatchedAgents.length }),
    );
    if (!confirmed) return;
    bulkFixMutation.mutate(
      mismatchedAgents.map((a) => ({ id: a.id, recommendedVoice: a.recommendedVoice })),
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={tenantT('agents.page_title')}
        description={tenantT('agents.page_subtitle')}
        actions={isManager ? (
          <TooltipWalkthrough
            tooltipKey="agents-create"
            title={tenantT('agents.walkthrough.title')}
            description={tenantT('agents.walkthrough.description')}
            position="left"
          >
            <button onClick={() => setEditingId('new')}
              className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
              <Plus className="h-4 w-4" /> {tenantT('agents.new_agent')}
            </button>
          </TooltipWalkthrough>
        ) : undefined}
      />

      {!isLoading && (
        <SchedulingDriftBanner
          count={agentsWithDisconnectedCalendar.length}
          disconnectedProviders={disconnectedAgentProviders}
          subjectSingular={tenantT('agents.scheduling_drift.subject_singular')}
          subjectPlural={tenantT('agents.scheduling_drift.subject_plural')}
          storageKey="agents"
        />
      )}

      {!isLoading && isManager && mismatchedAgents.length > 0 && (
        <div
          role="status"
          className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-warning bg-warning-light px-4 py-3 dark:border-warning dark:bg-warning"
        >
          <div className="flex items-start gap-2 text-sm text-warning dark:text-warning">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">
                {tenantT('agents.bulk_voice_fix.title', { count: mismatchedAgents.length })}
              </p>
              {bulkFixState.status === 'error' && (
                <p className="mt-1 text-xs text-warning dark:text-warning">
                  {bulkFixState.message}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={handleBulkFixVoices}
            disabled={bulkFixState.status === 'running'}
            className="inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-warning text-white hover:bg-warning transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {bulkFixState.status === 'running'
              ? tenantT('agents.bulk_voice_fix.fix_button_running')
              : tenantT('agents.bulk_voice_fix.fix_button')}
          </button>
        </div>
      )}

      {isLoading ? (
        <SkeletonGrid count={6} />
      ) : agents.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl" data-testid="tenant-agents-list">
          <EmptyState
            icon={Bot}
            title={tenantT('agents.empty_state.title')}
            description={tenantT('agents.empty_state.description')}
            primaryAction={{
              label: tenantT('agents.new_agent'),
              icon: Plus,
              onClick: () => setEditingId('new'),
            }}
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="tenant-agents-list">
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
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-warning-light text-warning border border-warning dark:bg-warning dark:text-warning dark:border-warning hover:bg-warning-light dark:hover:bg-warning transition cursor-pointer"
                      title={tenantT('agents.card.voice_mismatch_tooltip_action', { voice: agent.voice, language: languageLabel, recommended: recommendedVoice })}
                      aria-label={tenantT('agents.card.voice_mismatch_aria', { voice: agent.voice, language: languageLabel, recommended: recommendedVoice })}
                    >
                      <AlertTriangle className="h-3 w-3" />
                      {tenantT('agents.card.voice_mismatch_label')}
                    </button>
                  )}
                  {voiceMismatch && !isManager && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-warning-light text-warning border border-warning dark:bg-warning dark:text-warning dark:border-warning"
                      title={tenantT('agents.card.voice_mismatch_tooltip_static', { voice: agent.voice, language: languageLabel, recommended: recommendedVoice })}
                    >
                      <AlertTriangle className="h-3 w-3" />
                      {tenantT('agents.card.voice_mismatch_label')}
                    </span>
                  )}
                  {isFederated && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-info-light text-info dark:bg-info dark:text-info">
                      <Globe className="h-3 w-3" /> {tenantT('agents.card.external_label')}
                    </span>
                  )}
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${agent.status === 'active' ? 'bg-success-light text-success dark:bg-success dark:text-success' : 'bg-surface-hover text-text-secondary'}`}>
                    {agent.status}
                  </span>
                </div>
              </div>
              {isFederated && (
                <div className="flex items-center gap-2 text-xs text-info dark:text-info mb-3 bg-info-light dark:bg-info rounded-lg px-3 py-2 border border-info dark:border-info">
                  <Globe className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    {agent.last_sync_at
                      ? tenantT('agents.card.external_managed_with_sync', {
                          system: agent.remote_system ?? tenantT('agents.card.external_remote_default'),
                          date: new Date(agent.last_sync_at).toLocaleDateString(),
                        })
                      : tenantT('agents.card.external_managed', {
                          system: agent.remote_system ?? tenantT('agents.card.external_remote_default'),
                        })}
                  </span>
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
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-warning-light text-warning border border-warning dark:bg-warning dark:text-warning dark:border-warning hover:bg-warning-light dark:hover:bg-warning transition cursor-pointer"
                        title={tenantT('agents.card.scheduling_disconnected_tooltip', { provider: formatSchedulingProvider(provider) })}
                      >
                        <AlertTriangle className="h-3 w-3" />
                        {tenantT('agents.card.scheduling_disconnected_label', { provider: formatSchedulingProvider(provider) })}
                      </button>
                    );
                  }
                  return (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-surface-hover text-text-secondary border border-border"
                      title={
                        provider
                          ? tenantT('agents.card.scheduling_books_into', { provider: formatSchedulingProvider(provider) })
                          : tenantT('agents.card.scheduling_uses_default')
                      }
                    >
                      <Calendar className="h-3 w-3" />
                      {provider ? formatSchedulingProvider(provider) : tenantT('agents.card.scheduling_default')}
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
                  className="w-full text-left flex items-start gap-2 text-xs mb-3 bg-warning-light dark:bg-warning border border-warning dark:border-warning rounded-lg px-3 py-2 hover:bg-warning-light dark:hover:bg-warning transition"
                  title={tenantT('agents.card.scheduling_drift_open_tooltip')}
                >
                  <AlertTriangle className="h-3.5 w-3.5 text-warning dark:text-warning mt-0.5 shrink-0" />
                  <span className="text-warning dark:text-warning">
                    {tenantT('agents.card.scheduling_drift_message', { provider: formatSchedulingProvider(agent.scheduling_provider!) })}
                    <span className="ml-1 font-semibold underline">{tenantT('agents.card.scheduling_drift_reconnect_link')}</span>
                  </span>
                </button>
              )}
              {!isFederated && agent.system_prompt && (
                <p className="text-xs text-text-secondary line-clamp-2 mb-4">{agent.system_prompt}</p>
              )}
              {isManager && !isFederated && (
                <div className="flex items-center gap-2 pt-2 border-t border-border">
                  <button onClick={() => navigate(`/agents/${agent.id}/builder`)} className="text-text-secondary hover:text-primary text-xs font-medium inline-flex items-center gap-1 transition">
                    <Pencil className="h-3.5 w-3.5" /> {tenantT('agents.card.edit')}
                  </button>
                  <button onClick={() => setEditingId(agent.id)} className="text-text-secondary hover:text-primary text-xs font-medium inline-flex items-center gap-1 transition">
                    <Workflow className="h-3.5 w-3.5" /> {tenantT('agents.card.quick_settings')}
                  </button>
                  <button onClick={() => { if (confirm(tenantT('agents.card.delete_confirm'))) deleteMut.mutate(agent.id); }}
                    className="text-text-secondary hover:text-danger text-xs font-medium inline-flex items-center gap-1 transition ml-auto">
                    <Trash2 className="h-3.5 w-3.5" /> {tenantT('agents.card.delete')}
                  </button>
                </div>
              )}
              {isFederated && (
                <div className="pt-2 border-t border-border">
                  <p className="text-xs text-text-muted">
                    {tenantT('agents.card.external_config_note', {
                      system: agent.remote_system ?? tenantT('agents.card.external_config_note_default'),
                    })}
                  </p>
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
