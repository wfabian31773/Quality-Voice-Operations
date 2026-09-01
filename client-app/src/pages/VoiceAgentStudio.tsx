import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  ArrowLeft, AudioLines, Check, Loader2, Pencil, Sparkles,
} from 'lucide-react';
import { api } from '../lib/api';
import { useRole } from '../lib/useRole';
import { XAI_BUILTIN_VOICES } from '../../../platform/agent-runtime/xaiSessionConfig';
import { MASTER_VOICE_AGENT_MODEL } from '../../../platform/agent-runtime/masterVoiceAgent';
import { AGENT_LANGUAGES, normalizeAgentLanguage } from '../lib/agentLanguages';
import VoiceAgentDeploymentTab from '../components/voice-agents/VoiceAgentDeploymentTab';
import VoiceAgentConversationsTab from '../components/voice-agents/VoiceAgentConversationsTab';
import VoiceAgentInsightsTab from '../components/voice-agents/VoiceAgentInsightsTab';
import TryItLiveModal from '../components/voice-agents/TryItLiveModal';
import {
  formatAssignedNumbers,
  phonesRoutedToAgent,
  readPostCallPreference,
  type StudioPhoneNumber,
} from '../lib/voiceAgentStudioMetrics';

type StudioTab = 'configuration' | 'speech' | 'deployment' | 'conversations' | 'insights';

interface AgentRecord {
  id: string;
  name: string;
  status: string;
  voice: string;
  model: string;
  language?: string;
  system_prompt: string | null;
  welcome_greeting: string | null;
  metadata: Record<string, unknown> | null;
  updated_at: string;
}

interface LibraryTool {
  name: string;
  description: string;
  category: string;
}

const TABS: { id: StudioTab; label: string }[] = [
  { id: 'configuration', label: 'Configuration' },
  { id: 'speech', label: 'Speech' },
  { id: 'deployment', label: 'Deployment' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'insights', label: 'Insights' },
];

function isStudioTab(value: string | null): value is StudioTab {
  return TABS.some((tab) => tab.id === value);
}

export default function VoiceAgentStudio() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isManager, isPlatformAdmin } = useRole();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = isStudioTab(searchParams.get('tab')) ? searchParams.get('tab') as StudioTab : 'configuration';

  const agentQuery = useQuery({
    queryKey: ['agent', id],
    enabled: Boolean(id),
    queryFn: () => api.get<{ agent: AgentRecord }>(`/agents/${id}`),
  });
  const libraryQuery = useQuery({
    queryKey: ['agent-library'],
    queryFn: () => api.get<{ tools: LibraryTool[]; model: string; voice: string }>('/agents/library'),
  });

  const agent = agentQuery.data?.agent;
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [greeting, setGreeting] = useState('');
  const [welcomeOn, setWelcomeOn] = useState(true);
  const [voice, setVoice] = useState('eve');
  const [language, setLanguage] = useState('en');
  const [enabledTools, setEnabledTools] = useState<string[]>([]);
  const [postCallNotify, setPostCallNotify] = useState(false);
  const [postCallEmail, setPostCallEmail] = useState('');
  const [saved, setSaved] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const [improveError, setImproveError] = useState<string | null>(null);

  const phonesQuery = useQuery({
    queryKey: ['phone-numbers'],
    queryFn: () => api.get<{ phoneNumbers: StudioPhoneNumber[] }>('/phone-numbers?limit=100'),
  });
  const assignedPhones = phonesRoutedToAgent(phonesQuery.data?.phoneNumbers ?? [], id ?? '');

  useEffect(() => {
    if (!agent) return;
    setName(agent.name);
    setInstructions(agent.system_prompt ?? '');
    setGreeting(agent.welcome_greeting ?? '');
    setWelcomeOn(Boolean(agent.welcome_greeting));
    setVoice(agent.voice || 'eve');
    setLanguage(normalizeAgentLanguage(agent.language));
    const stored = agent.metadata?.enabledLibraryTools;
    setEnabledTools(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : []);
    const postCall = readPostCallPreference(agent.metadata);
    setPostCallNotify(postCall.enabled);
    setPostCallEmail(postCall.email);
  }, [agent]);

  const save = useMutation({
    mutationFn: async () => {
      if (!id) return;
      await api.patch(`/agents/${id}`, {
        name,
        system_prompt: instructions,
        welcome_greeting: welcomeOn ? greeting : '',
        voice,
        language,
        model: MASTER_VOICE_AGENT_MODEL,
        metadata: {
          ...(agent?.metadata ?? {}),
          enabledLibraryTools: enabledTools,
          postCallNotify,
          postCallEmail: postCallEmail.trim(),
        },
      });
    },
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['agent', id] });
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
      window.setTimeout(() => setSaved(false), 1600);
    },
  });

  const publish = useMutation({
    mutationFn: () => api.post(`/agents/${id}/publish`, {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['agent', id] });
    },
  });

  const improve = useMutation({
    mutationFn: () => api.post<{ instructions: string }>(`/agents/${id}/improve`, { instructions }),
    onSuccess: (result) => {
      setInstructions(result.instructions);
      setImproveError(null);
    },
    onError: (err) => {
      setImproveError(err instanceof Error ? err.message : 'Could not improve instructions.');
    },
  });

  if (agentQuery.isLoading) {
    return <div className="text-sm text-text-muted">Loading agent…</div>;
  }
  if (!agent) {
    return <div className="text-sm text-danger">This agent could not be found.</div>;
  }

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={() => navigate('/agents')}
        className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </button>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-light text-lg font-semibold text-primary">
            {name.slice(0, 1).toUpperCase() || 'A'}
          </span>
          <div>
            <div className="flex items-center gap-2">
              {isManager ? (
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="bg-transparent text-2xl font-semibold tracking-tight text-text-primary focus:outline-none"
                  aria-label="Agent name"
                />
              ) : (
                <h1 className="text-2xl font-semibold tracking-tight text-text-primary">{name}</h1>
              )}
              <Pencil className="h-4 w-4 text-text-muted" aria-hidden="true" />
            </div>
            <p className="mt-1 flex items-center gap-2 text-sm text-text-muted">
              Last published {formatDistanceToNow(new Date(agent.updated_at), { addSuffix: true })}
              <span className="inline-flex items-center gap-1 text-success">
                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                {agent.status === 'inactive' ? 'Draft' : 'Live'}
              </span>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setLiveOpen(true)}
            className="inline-flex items-center gap-2 rounded-full border border-primary/40 px-4 py-2 text-sm font-medium text-primary hover:bg-primary-light"
          >
            <AudioLines className="h-4 w-4" />
            Try it live
          </button>
          {isManager && (
            <button
              type="button"
              onClick={() => publish.mutate()}
              disabled={publish.isPending}
              className="inline-flex items-center gap-2 rounded-full bg-surface-secondary px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-hover disabled:opacity-50"
            >
              {publish.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Publish
            </button>
          )}
          {isManager && (
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
            >
              {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
              {saved ? 'Saved' : 'Save'}
            </button>
          )}
        </div>
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setSearchParams(item.id === 'configuration' ? {} : { tab: item.id })}
            className={`rounded-t-lg px-4 py-2.5 text-sm ${
              tab === item.id
                ? 'bg-surface-secondary font-medium text-text-primary'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {tab === 'configuration' && (
        <ConfigurationTab
          instructions={instructions}
          greeting={greeting}
          welcomeOn={welcomeOn}
          enabledTools={enabledTools}
          tools={libraryQuery.data?.tools ?? []}
          canEdit={isManager}
          onInstructions={setInstructions}
          onGreeting={setGreeting}
          onWelcomeOn={setWelcomeOn}
          onToggleTool={(toolName) => {
            setEnabledTools((current) => (
              current.includes(toolName)
                ? current.filter((name) => name !== toolName)
                : [...current, toolName]
            ));
          }}
          assignedPhones={assignedPhones}
          onOpenDeployment={() => setSearchParams({ tab: 'deployment' })}
          onImprove={() => improve.mutate()}
          improving={improve.isPending}
          improveError={improveError}
          canImprove={isManager}
        />
      )}
      {tab === 'speech' && (
        <SpeechTab
          voice={voice}
          language={language}
          canEdit={isManager}
          onVoice={setVoice}
          onLanguage={setLanguage}
        />
      )}
      {tab === 'deployment' && (
        <VoiceAgentDeploymentTab
          agentId={agent.id}
          phones={phonesQuery.data?.phoneNumbers ?? []}
          canEdit={isManager}
          isStaff={isPlatformAdmin}
          postCallNotify={postCallNotify}
          postCallEmail={postCallEmail}
          onPostCallNotify={setPostCallNotify}
          onPostCallEmail={setPostCallEmail}
          onSave={() => save.mutate()}
          saving={save.isPending}
        />
      )}
      {tab === 'conversations' && <VoiceAgentConversationsTab agentId={agent.id} />}
      {tab === 'insights' && <VoiceAgentInsightsTab agentId={agent.id} />}
      {liveOpen ? <TryItLiveModal agentId={agent.id} onClose={() => setLiveOpen(false)} /> : null}
    </div>
  );
}

function SettingRow({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border py-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="max-w-xl">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <p className="mt-1 text-sm text-text-muted">{body}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ConfigurationTab({
  instructions,
  greeting,
  welcomeOn,
  enabledTools,
  tools,
  canEdit,
  onInstructions,
  onGreeting,
  onWelcomeOn,
  onToggleTool,
  assignedPhones,
  onOpenDeployment,
  onImprove,
  improving,
  improveError,
  canImprove,
}: {
  instructions: string;
  greeting: string;
  welcomeOn: boolean;
  enabledTools: string[];
  tools: LibraryTool[];
  canEdit: boolean;
  onInstructions: (value: string) => void;
  onGreeting: (value: string) => void;
  onWelcomeOn: (value: boolean) => void;
  onToggleTool: (name: string) => void;
  assignedPhones: StudioPhoneNumber[];
  onOpenDeployment: () => void;
  onImprove: () => void;
  improving: boolean;
  improveError: string | null;
  canImprove: boolean;
}) {
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-secondary px-4 py-3">
        <p className="text-sm text-text-secondary">
          {assignedPhones.length > 0
            ? `This agent is reachable at ${formatAssignedNumbers(assignedPhones)}.`
            : 'Set up a phone number to call your agent.'}
        </p>
        <button
          type="button"
          onClick={onOpenDeployment}
          className="shrink-0 rounded-full bg-primary px-3 py-1.5 text-sm font-medium text-on-primary"
        >
          {assignedPhones.length > 0 ? 'Manage' : 'Set up'}
        </button>
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Instructions</h3>
          <button
            type="button"
            disabled={!canImprove || improving}
            onClick={onImprove}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:text-text-muted disabled:no-underline"
          >
            {improving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Improve with Grok
          </button>
        </div>
        {improveError ? <p className="text-xs text-danger">{improveError}</p> : null}
        <textarea
          value={instructions}
          onChange={(event) => onInstructions(event.target.value)}
          disabled={!canEdit}
          rows={8}
          className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary"
        />
      </section>

      <SettingRow
        title="Welcome message"
        body="When on, the agent opens with a greeting. When off, it waits for the caller to speak."
      >
        <button
          type="button"
          role="switch"
          aria-checked={welcomeOn}
          disabled={!canEdit}
          onClick={() => onWelcomeOn(!welcomeOn)}
          className={`relative h-6 w-11 rounded-full transition ${welcomeOn ? 'bg-primary' : 'bg-border'}`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${welcomeOn ? 'left-5' : 'left-0.5'}`} />
        </button>
      </SettingRow>
      {welcomeOn && (
        <textarea
          value={greeting}
          onChange={(event) => onGreeting(event.target.value)}
          disabled={!canEdit}
          rows={3}
          placeholder="Optional: write an exact greeting, or leave blank for the agent to choose what to say."
          className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary"
        />
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">Tools ({enabledTools.length})</h3>
        </div>
        <p className="text-sm text-text-muted">
          These are the shared library tools the Master Voice Agent can invoke. New tools are not invented here.
        </p>
        <ul className="divide-y divide-border rounded-xl border border-border">
          {tools.map((tool) => {
            const enabled = enabledTools.includes(tool.name);
            return (
              <li key={tool.name} className="flex items-start justify-between gap-3 px-4 py-3">
                <div>
                  <p className="font-mono text-sm text-text-primary">{tool.name}</p>
                  <p className="mt-0.5 text-xs text-text-muted">{tool.description}</p>
                </div>
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => onToggleTool(tool.name)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${
                    enabled
                      ? 'border-primary bg-primary-light text-primary'
                      : 'border-border text-text-secondary'
                  }`}
                >
                  {enabled ? 'On' : 'Add'}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function SpeechTab({
  voice,
  language,
  canEdit,
  onVoice,
  onLanguage,
}: {
  voice: string;
  language: string;
  canEdit: boolean;
  onVoice: (value: string) => void;
  onLanguage: (value: string) => void;
}) {
  return (
    <div>
      <SettingRow title="Voice" body="Choose a built-in voice to match your brand.">
        <select
          value={voice}
          disabled={!canEdit}
          onChange={(event) => onVoice(event.target.value)}
          className="rounded-full border border-border bg-surface px-3 py-2 text-sm"
        >
          {XAI_BUILTIN_VOICES.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
      </SettingRow>
      <SettingRow title="Language" body="Improve recognition when callers speak a specific language.">
        <select
          value={language}
          disabled={!canEdit}
          onChange={(event) => onLanguage(event.target.value)}
          className="rounded-full border border-border bg-surface px-3 py-2 text-sm"
        >
          {AGENT_LANGUAGES.map((item) => (
            <option key={item.code} value={item.code}>{item.label}</option>
          ))}
        </select>
      </SettingRow>
      <SettingRow title="Speaking speed" body="Speed up or slow down the agent's speech.">
        <select disabled className="rounded-full border border-border bg-surface px-3 py-2 text-sm text-text-muted">
          <option>1.0x</option>
        </select>
      </SettingRow>
    </div>
  );
}
