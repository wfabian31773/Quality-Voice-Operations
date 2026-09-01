import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { formatDistanceToNow } from 'date-fns';
import { Bot, ChevronDown, Plus, Search } from 'lucide-react';
import { api } from '../lib/api';
import { useRole } from '../lib/useRole';
import { PageHeader } from '../components/ui';
import { EmptyState, Skeleton } from '../components/state';
import BuildVoiceAgentModal from '../components/voice-agents/BuildVoiceAgentModal';
import { VOICE_AGENT_TEMPLATE_CHIPS } from '../lib/voiceAgentTemplates';

interface AgentRow {
  id: string;
  name: string;
  status: string;
  updated_at: string;
  created_at: string;
}

export default function Agents() {
  const { t } = useTranslation('tenant');
  const navigate = useNavigate();
  const { isManager } = useRole();
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ agents: AgentRow[]; total: number }>('/agents'),
  });

  const agents = useMemo(() => {
    const rows = data?.agents ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((agent) => agent.name.toLowerCase().includes(needle));
  }, [data?.agents, query]);

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('agents.page_title')}
        description="Build, configure, and test real-time voice agents."
        actions={isManager ? (
          <div className="relative">
            <div className="inline-flex overflow-hidden rounded-full bg-primary">
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-hover"
              >
                <Plus className="h-4 w-4" />
                Create agent
              </button>
              <button
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                className="border-l border-on-primary/30 px-2.5 text-on-primary hover:bg-primary-hover"
                aria-label="More create options"
                aria-expanded={menuOpen}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
            {menuOpen && (
              <div className="absolute right-0 z-20 mt-2 w-72 rounded-xl border border-border bg-surface p-2 shadow-lg">
                <button
                  type="button"
                  className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-hover"
                  onClick={() => {
                    setMenuOpen(false);
                    setCreateOpen(true);
                  }}
                >
                  <Plus className="mt-0.5 h-4 w-4 text-text-muted" />
                  <span>
                    <span className="block font-medium text-text-primary">Blank agent</span>
                    <span className="block text-xs text-text-muted">Start from scratch</span>
                  </span>
                </button>
                <div className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-muted">
                  Templates
                </div>
                {VOICE_AGENT_TEMPLATE_CHIPS.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className="flex w-full rounded-lg px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-hover"
                    onClick={() => {
                      setMenuOpen(false);
                      setCreateOpen(true);
                    }}
                  >
                    {template.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : undefined}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search agents"
            className="w-full rounded-full border border-border bg-surface py-2.5 pl-10 pr-4 text-sm text-text-primary placeholder:text-text-muted"
          />
        </label>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : agents.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface" data-testid="tenant-agents-list">
          <EmptyState
            icon={Bot}
            title={t('agents.empty_state.title')}
            description={t('agents.empty_state.description')}
            primaryAction={isManager ? {
              label: t('agents.actions.create'),
              icon: Plus,
              onClick: () => setCreateOpen(true),
            } : undefined}
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface" data-testid="tenant-agents-list">
          <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-border px-5 py-3 text-xs font-medium uppercase tracking-wide text-text-muted">
            <span>Agent</span>
            <span>Updated</span>
          </div>
          <ul>
            {agents.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/agents/${agent.id}`)}
                  className="grid w-full grid-cols-[1fr_auto] items-center gap-4 px-5 py-4 text-left hover:bg-surface-hover"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-light text-sm font-semibold text-primary">
                      {agent.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="truncate font-medium text-text-primary">{agent.name}</span>
                  </span>
                  <span className="text-sm text-text-muted">
                    {formatDistanceToNow(new Date(agent.updated_at || agent.created_at), { addSuffix: true })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <BuildVoiceAgentModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(agentId) => {
          setCreateOpen(false);
          navigate(`/agents/${agentId}`);
        }}
      />
    </div>
  );
}
