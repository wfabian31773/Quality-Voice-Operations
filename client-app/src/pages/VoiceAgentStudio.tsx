import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  ArrowLeft, AudioLines, Check, Loader2, Pencil, Phone, RefreshCw, Sparkles,
} from 'lucide-react';
import { api } from '../lib/api';
import { useRole } from '../lib/useRole';
import { XAI_BUILTIN_VOICES } from '../../../platform/agent-runtime/xaiSessionConfig';
import { MASTER_VOICE_AGENT_MODEL } from '../../../platform/agent-runtime/masterVoiceAgent';
import { AGENT_LANGUAGES, normalizeAgentLanguage } from '../lib/agentLanguages';

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

interface CallRow {
  id: string;
  start_time: string;
  caller_number?: string | null;
  lifecycle_state?: string;
  duration_seconds?: number | null;
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
  const [saved, setSaved] = useState(false);

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
          <Link
            to="/phone-numbers"
            className="inline-flex items-center gap-2 rounded-full border border-primary/40 px-4 py-2 text-sm font-medium text-primary hover:bg-primary-light"
          >
            <AudioLines className="h-4 w-4" />
            Try it live
          </Link>
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
      {tab === 'deployment' && <DeploymentTab agentId={agent.id} isStaff={isPlatformAdmin} />}
      {tab === 'conversations' && <ConversationsTab agentId={agent.id} />}
      {tab === 'insights' && <InsightsTab agentId={agent.id} />}
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
}) {
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between rounded-xl border border-border bg-surface-secondary px-4 py-3">
        <p className="text-sm text-text-secondary">Set up a phone number to call your agent.</p>
        <Link to="/phone-numbers" className="rounded-full bg-primary px-3 py-1.5 text-sm font-medium text-on-primary">
          Set up
        </Link>
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">Instructions</h3>
          <span className="inline-flex items-center gap-1 text-xs text-text-muted">
            <Sparkles className="h-3.5 w-3.5" />
            Improve with Grok
          </span>
        </div>
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

function DeploymentTab({ agentId, isStaff }: { agentId: string; isStaff: boolean }) {
  return (
    <div className="space-y-8">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">Phone numbers</h3>
          <Link to="/phone-numbers" className="text-sm font-medium text-primary">Add number</Link>
        </div>
        <p className="mb-4 text-sm text-text-muted">
          Let callers reach this agent on a number routed to the Master Voice Agent runtime.
        </p>
        <div className="flex flex-col items-center gap-3 rounded-xl border border-border px-6 py-10 text-center">
          <Phone className="h-6 w-6 text-text-muted" />
          <p className="text-sm text-text-secondary">Set up a phone number. Enable your agent to serve customers by phone.</p>
        </div>
      </section>
      <section>
        <h3 className="text-sm font-semibold text-text-primary">Post-call notifications</h3>
        <p className="mt-1 text-sm text-text-muted">No email is sent when a call ends.</p>
      </section>
      {isStaff && (
        <p className="text-sm">
          <Link to={`/agents/${agentId}/builder`} className="text-primary hover:underline">
            Open advanced workflow canvas
          </Link>
        </p>
      )}
    </div>
  );
}

function ConversationsTab({ agentId }: { agentId: string }) {
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['agent-calls', agentId],
    queryFn: () => api.get<{ calls?: CallRow[]; sessions?: CallRow[] }>(`/calls?agent_id=${agentId}&limit=20`),
  });
  const rows = data?.calls ?? data?.sessions ?? [];

  return (
    <div className="space-y-4">
      <p className="rounded-xl bg-surface-secondary px-4 py-3 text-sm text-text-secondary">
        Conversations are retained with the rest of your call history.
      </p>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void refetch()}
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <AudioLines className="h-8 w-8 text-text-muted" />
          <p className="text-sm text-text-secondary">
            No conversations yet. Conversations will appear here after callers reach this agent.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <Link to={`/calls?q=${row.id}`} className="font-mono text-primary hover:underline">{row.id}</Link>
              <span className="text-text-muted">{row.caller_number || '—'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InsightsTab({ agentId }: { agentId: string }) {
  const { data } = useQuery({
    queryKey: ['agent-insights', agentId],
    queryFn: () => api.get<{ calls?: CallRow[]; sessions?: CallRow[] }>(`/calls?agent_id=${agentId}&limit=100`),
  });
  const rows = data?.calls ?? data?.sessions ?? [];
  const minutes = useMemo(
    () => rows.reduce((sum, row) => sum + (row.duration_seconds ?? 0), 0) / 60,
    [rows],
  );

  const cards = [
    { label: 'Conversations', value: String(rows.length) },
    { label: 'Total minutes', value: minutes.toFixed(1) },
    { label: 'Cost (USD)', value: '—' },
    { label: 'Tool calls', value: '—' },
    { label: 'Duration (p50)', value: '—' },
    { label: 'Time to first audio (p50)', value: '—' },
    { label: 'Error rate', value: '—' },
    { label: 'Transfer rate', value: '—' },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-success">Live calls: {rows.filter((row) => row.lifecycle_state === 'in_progress').length}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {cards.map((card) => (
          <div key={card.label} className="rounded-xl border border-border bg-surface px-4 py-5">
            <p className="text-xs uppercase tracking-wide text-text-muted">{card.label}</p>
            <p className="mt-2 text-2xl font-semibold text-text-primary">{card.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
