import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Plus, Pencil, Trash2, X, Bot } from 'lucide-react';

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
  created_at: string;
}

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'];
const MODELS = ['gpt-4o-realtime-preview', 'gpt-4o-mini-realtime-preview'];
const AGENT_TYPES = [
  'general', 'answering-service', 'medical-after-hours', 'outbound-scheduling',
  'appointment-confirmation', 'custom', 'dental', 'property-management',
  'home-services', 'legal', 'customer-support', 'outbound-sales',
  'technical-support', 'collections',
];

interface AgentFormData {
  name: string;
  type: string;
  voice: string;
  model: string;
  system_prompt: string;
  welcome_greeting: string;
  temperature: number;
}

function AgentModal({ agentId, onClose, onSaved }: { agentId?: string; onClose: () => void; onSaved: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<AgentFormData>({
    name: '',
    type: 'general',
    voice: 'alloy',
    model: 'gpt-4o-realtime-preview',
    system_prompt: '',
    welcome_greeting: '',
    temperature: 0.7,
  });
  const [loaded, setLoaded] = useState(!agentId);

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
      });
      setLoaded(true);
    });
  }, [agentId]);

  const mutation = useMutation({
    mutationFn: (data: AgentFormData) =>
      agentId ? api.patch(`/agents/${agentId}`, data) : api.post('/agents', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      onSaved();
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
      </div>
    </div>
  );
}

export default function Agents() {
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ agents: Agent[]; total: number }>('/agents?limit=100'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/agents/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agents'] }),
  });

  const agents = data?.agents ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Agents</h1>
          <p className="text-sm text-text-secondary mt-1">Manage your AI voice agents</p>
        </div>
        <button onClick={() => setEditingId('new')}
          className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2.5 rounded-lg transition">
          <Plus className="h-4 w-4" /> New Agent
        </button>
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
          {agents.map((agent) => (
            <div key={agent.id} className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-text-primary">{agent.name}</h3>
                  <p className="text-xs text-text-secondary mt-0.5">{agent.type} &middot; {agent.voice} &middot; {agent.model.replace('gpt-4o-', '').replace('-preview', '')}</p>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${agent.status === 'active' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}>
                  {agent.status}
                </span>
              </div>
              {agent.system_prompt && (
                <p className="text-xs text-text-secondary line-clamp-2 mb-4">{agent.system_prompt}</p>
              )}
              <div className="flex items-center gap-2 pt-2 border-t border-border">
                <button onClick={() => setEditingId(agent.id)} className="text-text-secondary hover:text-primary text-xs font-medium inline-flex items-center gap-1 transition">
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </button>
                <button onClick={() => { if (confirm('Delete this agent?')) deleteMut.mutate(agent.id); }}
                  className="text-text-secondary hover:text-danger text-xs font-medium inline-flex items-center gap-1 transition ml-auto">
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editingId && (
        <AgentModal
          agentId={editingId === 'new' ? undefined : editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => {}}
        />
      )}
    </div>
  );
}
