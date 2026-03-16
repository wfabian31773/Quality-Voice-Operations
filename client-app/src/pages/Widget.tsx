import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  MessageSquare, Mic, Copy, Check, Plus, Trash2, Eye, EyeOff,
  Save, AlertCircle, CheckCircle, RefreshCw, Code, Palette,
} from 'lucide-react';

interface WidgetConfig {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  enabled: boolean;
  greeting: string;
  lead_capture_fields: string[];
  primary_color: string;
  allowed_domains: string[];
  text_chat_enabled: boolean;
  voice_enabled: boolean;
}

interface Agent {
  id: string;
  name: string;
  type: string;
  status: string;
}

interface WidgetToken {
  id: string;
  label: string;
  revoked_at: string | null;
  created_at: string;
}

const LEAD_FIELD_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
];

const ADMIN_ROLES = ['tenant_owner', 'operations_manager', 'billing_admin', 'agent_developer'];

export default function Widget() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = ADMIN_ROLES.includes(user?.role ?? '');
  const [saved, setSaved] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [newTokenLabel, setNewTokenLabel] = useState('');
  const [showNewTokenDialog, setShowNewTokenDialog] = useState(false);
  const [newPlaintextToken, setNewPlaintextToken] = useState<string | null>(null);

  const { data: configData, isLoading: configLoading } = useQuery({
    queryKey: ['widget-config'],
    queryFn: () => api.get<{ config: WidgetConfig | null }>('/widget/config'),
  });

  const { data: agentsData } = useQuery({
    queryKey: ['agents-list'],
    queryFn: () => api.get<{ agents: Agent[] }>('/agents'),
  });

  const { data: tokensData } = useQuery({
    queryKey: ['widget-tokens'],
    queryFn: () => api.get<{ tokens: WidgetToken[] }>('/widget/tokens'),
    enabled: isAdmin,
  });

  const [form, setForm] = useState({
    enabled: false,
    agent_id: '',
    greeting: 'Hello! How can I help you today?',
    lead_capture_fields: ['name', 'email'] as string[],
    primary_color: '#6366f1',
    text_chat_enabled: true,
    voice_enabled: true,
    allowed_domains: '',
  });

  useEffect(() => {
    if (configData?.config) {
      const c = configData.config;
      setForm({
        enabled: c.enabled,
        agent_id: c.agent_id ?? '',
        greeting: c.greeting,
        lead_capture_fields: c.lead_capture_fields,
        primary_color: c.primary_color,
        text_chat_enabled: c.text_chat_enabled,
        voice_enabled: c.voice_enabled,
        allowed_domains: (c.allowed_domains || []).join(', '),
      });
    }
  }, [configData]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.put('/widget/config', {
        ...form,
        agent_id: form.agent_id || null,
        allowed_domains: form.allowed_domains
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['widget-config'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  const generateTokenMutation = useMutation({
    mutationFn: (label: string) => api.post<{ token: WidgetToken; plaintextToken: string }>('/widget/tokens', { label }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['widget-tokens'] });
      setNewPlaintextToken(data.plaintextToken);
      setShowNewTokenDialog(false);
      setNewTokenLabel('');
    },
  });

  const revokeTokenMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/widget/tokens/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['widget-tokens'] });
    },
  });

  if (configLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  const set = (key: keyof typeof form, value: unknown) => setForm((f) => ({ ...f, [key]: value }));

  const activeTokens = (tokensData?.tokens ?? []).filter((t) => !t.revoked_at);
  const firstToken = activeTokens[0];

  const embedSnippet = firstToken
    ? `<script src="${window.location.origin}/api/widget/embed.js" data-token="${firstToken ? 'YOUR_WIDGET_TOKEN' : ''}" data-api="${window.location.origin}"></script>`
    : 'Generate a widget token first to get the embed snippet.';

  const toggleLeadField = (field: string) => {
    setForm((f) => ({
      ...f,
      lead_capture_fields: f.lead_capture_fields.includes(field)
        ? f.lead_capture_fields.filter((ff) => ff !== field)
        : [...f.lead_capture_fields, field],
    }));
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-text-primary">Website Widget</h1>
        <p className="text-sm text-text-muted mt-0.5">
          Configure and embed a voice/chat widget on your website
        </p>
      </div>

      {saveMutation.error && (
        <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg flex items-center gap-2 mb-4">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {saveMutation.error.message}
        </div>
      )}

      {saved && (
        <div className="bg-success/10 text-success text-sm px-4 py-3 rounded-lg flex items-center gap-2 mb-4">
          <CheckCircle className="h-4 w-4 shrink-0" />
          Widget settings saved successfully
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-surface border border-border rounded-xl divide-y divide-border">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-semibold text-text-primary">Widget Configuration</h2>
                  <p className="text-sm text-text-muted mt-0.5">Configure how the widget appears and behaves</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => set('enabled', e.target.checked)}
                    disabled={!isAdmin}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-300 peer-focus:outline-none rounded-full peer peer-checked:bg-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
                  <span className="ml-2 text-sm font-medium text-text-primary">
                    {form.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </label>
              </div>
            </div>

            <div className="p-6">
              <label className="block text-sm font-medium text-text-primary mb-1.5">Assigned Agent</label>
              <select
                value={form.agent_id}
                onChange={(e) => set('agent_id', e.target.value)}
                disabled={!isAdmin}
                className="w-full max-w-md px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
              >
                <option value="">Select an agent...</option>
                {(agentsData?.agents ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.type})
                  </option>
                ))}
              </select>
              <p className="text-xs text-text-muted mt-1.5">The AI agent that handles widget conversations</p>
            </div>

            <div className="p-6">
              <label className="block text-sm font-medium text-text-primary mb-1.5">Greeting Message</label>
              <textarea
                value={form.greeting}
                onChange={(e) => set('greeting', e.target.value)}
                disabled={!isAdmin}
                rows={2}
                className="w-full max-w-md px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 resize-none"
              />
              <p className="text-xs text-text-muted mt-1.5">Shown when a visitor opens the widget</p>
            </div>

            <div className="p-6">
              <label className="block text-sm font-medium text-text-primary mb-3">Interaction Modes</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.text_chat_enabled}
                    onChange={(e) => set('text_chat_enabled', e.target.checked)}
                    disabled={!isAdmin}
                    className="rounded border-border"
                  />
                  <MessageSquare className="h-4 w-4 text-text-muted" />
                  <span className="text-sm text-text-primary">Text Chat</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.voice_enabled}
                    onChange={(e) => set('voice_enabled', e.target.checked)}
                    disabled={!isAdmin}
                    className="rounded border-border"
                  />
                  <Mic className="h-4 w-4 text-text-muted" />
                  <span className="text-sm text-text-primary">Voice</span>
                </label>
              </div>
            </div>

            <div className="p-6">
              <label className="block text-sm font-medium text-text-primary mb-3">Lead Capture Fields</label>
              <div className="flex gap-4">
                {LEAD_FIELD_OPTIONS.map((f) => (
                  <label key={f.value} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.lead_capture_fields.includes(f.value)}
                      onChange={() => toggleLeadField(f.value)}
                      disabled={!isAdmin}
                      className="rounded border-border"
                    />
                    <span className="text-sm text-text-primary">{f.label}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-text-muted mt-1.5">Fields collected before starting the conversation</p>
            </div>

            <div className="p-6">
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                <Palette className="h-4 w-4 inline-block mr-1.5 -mt-0.5 text-text-muted" />
                Brand Color
              </label>
              <div className="flex items-center gap-3 max-w-md">
                <input
                  type="color"
                  value={form.primary_color}
                  onChange={(e) => set('primary_color', e.target.value)}
                  disabled={!isAdmin}
                  className="w-10 h-10 rounded border border-border cursor-pointer disabled:opacity-60"
                />
                <input
                  type="text"
                  value={form.primary_color}
                  onChange={(e) => set('primary_color', e.target.value)}
                  disabled={!isAdmin}
                  className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
                  placeholder="#6366f1"
                />
              </div>
            </div>
          </div>

          {isAdmin && (
            <div className="flex justify-end">
              <button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                {saveMutation.isPending ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          )}

          {isAdmin && (
            <div className="bg-surface border border-border rounded-xl">
              <div className="p-6 border-b border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-text-primary">Widget Tokens</h2>
                    <p className="text-sm text-text-muted mt-0.5">
                      Tokens authenticate your widget embed on external websites
                    </p>
                  </div>
                  <button
                    onClick={() => setShowNewTokenDialog(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg"
                  >
                    <Plus className="h-4 w-4" />
                    Generate Token
                  </button>
                </div>
              </div>

              {showNewTokenDialog && (
                <div className="p-6 border-b border-border bg-surface-hover">
                  <div className="flex items-end gap-3 max-w-md">
                    <div className="flex-1">
                      <label className="block text-sm font-medium text-text-primary mb-1.5">Token Label</label>
                      <input
                        type="text"
                        value={newTokenLabel}
                        onChange={(e) => setNewTokenLabel(e.target.value)}
                        placeholder="e.g. Production Website"
                        className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                      />
                    </div>
                    <button
                      onClick={() => generateTokenMutation.mutate(newTokenLabel || 'Default')}
                      disabled={generateTokenMutation.isPending}
                      className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50"
                    >
                      {generateTokenMutation.isPending ? 'Generating...' : 'Create'}
                    </button>
                    <button
                      onClick={() => setShowNewTokenDialog(false)}
                      className="px-4 py-2 border border-border text-text-primary text-sm font-medium rounded-lg hover:bg-surface-hover"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {newPlaintextToken && (
                <div className="p-6 border-b border-border bg-warning/5">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-text-primary mb-2">
                        Copy this token now — it won't be shown again
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-xs font-mono text-text-primary break-all">
                          {newPlaintextToken}
                        </code>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(newPlaintextToken);
                            setCopiedToken(newPlaintextToken);
                            setTimeout(() => setCopiedToken(null), 2000);
                          }}
                          className="p-2 hover:bg-surface-hover rounded-lg"
                        >
                          {copiedToken === newPlaintextToken ? (
                            <Check className="h-4 w-4 text-success" />
                          ) : (
                            <Copy className="h-4 w-4 text-text-muted" />
                          )}
                        </button>
                      </div>
                      <button
                        onClick={() => setNewPlaintextToken(null)}
                        className="mt-2 text-xs text-text-muted hover:text-text-primary"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="divide-y divide-border">
                {activeTokens.length === 0 && (
                  <div className="p-6 text-center text-sm text-text-muted">
                    No active tokens. Generate one to embed the widget.
                  </div>
                )}
                {activeTokens.map((t) => (
                  <div key={t.id} className="p-4 px-6 flex items-center justify-between">
                    <div>
                      <span className="text-sm font-medium text-text-primary">{t.label}</span>
                      <span className="ml-3 text-xs text-text-muted">
                        Created {new Date(t.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    <button
                      onClick={() => revokeTokenMutation.mutate(t.id)}
                      disabled={revokeTokenMutation.isPending}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-danger hover:bg-danger/10 rounded-lg"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Revoke
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="bg-surface border border-border rounded-xl p-6">
            <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
              <Code className="h-4 w-4 text-text-muted" />
              Embed Snippet
            </h3>
            <p className="text-xs text-text-muted mb-3">
              Add this script tag to your website to display the widget.
            </p>
            <div className="relative">
              <pre className="bg-surface-hover border border-border rounded-lg p-3 text-xs font-mono text-text-primary whitespace-pre-wrap break-all overflow-x-auto">
                {embedSnippet}
              </pre>
              {firstToken && (
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(embedSnippet);
                    setCopiedSnippet(true);
                    setTimeout(() => setCopiedSnippet(false), 2000);
                  }}
                  className="absolute top-2 right-2 p-1.5 hover:bg-surface rounded"
                >
                  {copiedSnippet ? (
                    <Check className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 text-text-muted" />
                  )}
                </button>
              )}
            </div>
          </div>

          <div className="bg-surface border border-border rounded-xl p-6">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Widget Preview</h3>
            <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-4 relative" style={{ minHeight: '200px' }}>
              <div className="text-center text-xs text-text-muted mt-8">
                Widget preview shows a floating chat button in the bottom-right corner of your website.
              </div>
              <div
                className="absolute bottom-4 right-4 w-12 h-12 rounded-full flex items-center justify-center shadow-lg cursor-pointer"
                style={{ backgroundColor: form.primary_color }}
              >
                <MessageSquare className="h-5 w-5 text-white" />
              </div>
            </div>
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-muted">Status</span>
                <span className={`font-medium ${form.enabled ? 'text-success' : 'text-text-muted'}`}>
                  {form.enabled ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-muted">Voice</span>
                <span className="font-medium text-text-primary">
                  {form.voice_enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-muted">Text Chat</span>
                <span className="font-medium text-text-primary">
                  {form.text_chat_enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-muted">Lead Capture</span>
                <span className="font-medium text-text-primary">
                  {form.lead_capture_fields.length > 0
                    ? form.lead_capture_fields.join(', ')
                    : 'None'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
