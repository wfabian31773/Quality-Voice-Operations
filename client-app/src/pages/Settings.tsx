import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useRole, ROLE_LABELS, PERMISSIONS_MATRIX, type SimpleRole } from '../lib/useRole';
import {
  Settings2, Shield, Key, Save, CheckCircle, AlertCircle, Globe, Clock, Users,
  Lock, Download, Trash2, Bell,
} from 'lucide-react';
import ApiKeys from './ApiKeys';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  status: string;
  plan: string;
  settings: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

const VOICE_MODELS = [
  { value: 'gpt-4o-realtime-preview', label: 'GPT-4o Realtime' },
  { value: 'gpt-4o-mini-realtime-preview', label: 'GPT-4o Mini Realtime' },
];

const VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse',
];

const ALL_TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
      'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu',
      'Europe/London', 'Europe/Paris', 'Europe/Berlin',
      'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata',
      'Australia/Sydney', 'UTC',
    ];
  }
})();

type Tab = 'general' | 'security' | 'api-keys' | 'roles' | 'privacy' | 'notifications';

const TABS: { key: Tab; label: string; icon: typeof Settings2 }[] = [
  { key: 'general', label: 'General', icon: Settings2 },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'roles', label: 'Roles & Permissions', icon: Users },
  { key: 'security', label: 'Security', icon: Shield },
  { key: 'api-keys', label: 'API Keys', icon: Key },
  { key: 'privacy', label: 'Privacy & Data', icon: Lock },
];

interface AgentType {
  value: string;
  label: string;
}

function GeneralSettings() {
  const queryClient = useQueryClient();
  const { isOwner } = useRole();
  const [saved, setSaved] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: () => api.get<{ tenant: Tenant }>('/tenants/me'),
  });

  const { data: agentTypesData } = useQuery({
    queryKey: ['agent-types'],
    queryFn: () => api.get<{ agentTypes: AgentType[] }>('/agent-types'),
    staleTime: 5 * 60 * 1000,
  });

  const agentTypes = agentTypesData?.agentTypes ?? [{ value: 'general', label: 'General' }];

  const [form, setForm] = useState({
    name: '',
    timezone: '',
    defaultVoiceModel: '',
    defaultVoice: '',
    defaultAgentType: '',
  });

  useEffect(() => {
    if (data?.tenant) {
      const t = data.tenant;
      const s = (t.settings ?? {}) as Record<string, string>;
      setForm({
        name: t.name ?? '',
        timezone: s.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        defaultVoiceModel: s.defaultVoiceModel ?? 'gpt-4o-realtime-preview',
        defaultVoice: s.defaultVoice ?? 'sage',
        defaultAgentType: s.defaultAgentType ?? 'general',
      });
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: () =>
      api.patch('/tenants/me', {
        name: form.name,
        settings: {
          ...(data?.tenant?.settings ?? {}),
          timezone: form.timezone,
          defaultVoiceModel: form.defaultVoiceModel,
          defaultVoice: form.defaultVoice,
          defaultAgentType: form.defaultAgentType,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenant-settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg flex items-center gap-2">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Failed to load organization settings. Please check your connection and try again.</span>
        <button
          onClick={() => queryClient.invalidateQueries({ queryKey: ['tenant-settings'] })}
          className="ml-auto text-xs font-medium underline hover:no-underline"
        >
          Retry
        </button>
      </div>
    );
  }

  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">General Settings</h2>
        <p className="text-sm text-text-muted mt-0.5">Configure your organization-wide preferences</p>
      </div>

      {mutation.error && (
        <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {mutation.error.message}
        </div>
      )}

      {saved && (
        <div className="bg-success/10 text-success text-sm px-4 py-3 rounded-lg flex items-center gap-2">
          <CheckCircle className="h-4 w-4 shrink-0" />
          Settings saved successfully
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl divide-y divide-border">
        <div className="p-6">
          <label className="block text-sm font-medium text-text-primary mb-1.5">Organization Name</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            disabled={!isOwner}
            className="w-full max-w-md px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 disabled:cursor-not-allowed"
          />
          <p className="text-xs text-text-muted mt-1.5">This name appears throughout the platform</p>
        </div>

        <div className="p-6">
          <label className="block text-sm font-medium text-text-primary mb-1.5">
            <Globe className="h-4 w-4 inline-block mr-1.5 -mt-0.5 text-text-muted" />
            Default Timezone
          </label>
          <select
            value={form.timezone}
            onChange={(e) => set('timezone', e.target.value)}
            disabled={!isOwner}
            className="w-full max-w-md px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {ALL_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
            ))}
          </select>
          <p className="text-xs text-text-muted mt-1.5">Used for campaign scheduling and report generation</p>
        </div>

        <div className="p-6">
          <label className="block text-sm font-medium text-text-primary mb-1.5">Default Voice Model</label>
          <select
            value={form.defaultVoiceModel}
            onChange={(e) => set('defaultVoiceModel', e.target.value)}
            disabled={!isOwner}
            className="w-full max-w-md px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {VOICE_MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <p className="text-xs text-text-muted mt-1.5">Model used for new agents by default</p>
        </div>

        <div className="p-6">
          <label className="block text-sm font-medium text-text-primary mb-1.5">Default Voice</label>
          <select
            value={form.defaultVoice}
            onChange={(e) => set('defaultVoice', e.target.value)}
            disabled={!isOwner}
            className="w-full max-w-md px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {VOICES.map((v) => (
              <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
            ))}
          </select>
          <p className="text-xs text-text-muted mt-1.5">Voice used for new agents by default</p>
        </div>

        <div className="p-6">
          <label className="block text-sm font-medium text-text-primary mb-1.5">Default Agent Type</label>
          <select
            value={form.defaultAgentType}
            onChange={(e) => set('defaultAgentType', e.target.value)}
            disabled={!isOwner}
            className="w-full max-w-md px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {agentTypes.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <p className="text-xs text-text-muted mt-1.5">Template used when creating new agents</p>
        </div>
      </div>

      {isOwner && (
        <div className="flex justify-end">
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {mutation.isPending ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      )}

      {!isOwner && (
        <p className="text-sm text-text-muted">Contact your organization owner to change settings.</p>
      )}
    </div>
  );
}

function RolesPermissions() {
  const { role: currentRole } = useRole();
  const roles: SimpleRole[] = ['owner', 'manager', 'operator', 'viewer'];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Roles & Permissions</h2>
        <p className="text-sm text-text-muted mt-0.5">
          View what each role can access. Your current role: <span className="font-medium text-text-primary">{ROLE_LABELS[currentRole]}</span>
        </p>
      </div>

      <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="px-5 py-3 text-left text-text-secondary font-medium min-w-[200px]">Capability</th>
                {roles.map((r) => (
                  <th key={r} className={`px-5 py-3 text-center font-medium min-w-[100px] ${r === currentRole ? 'text-primary bg-primary/5' : 'text-text-secondary'}`}>
                    {ROLE_LABELS[r]}
                    {r === currentRole && <span className="block text-[10px] font-normal text-primary mt-0.5">(You)</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISSIONS_MATRIX.map((cap, i) => (
                <tr key={i} className="border-b border-border last:border-0 hover:bg-surface-hover transition-colors">
                  <td className="px-5 py-2.5 text-text-primary">{cap.label}</td>
                  {roles.map((r) => (
                    <td key={r} className={`px-5 py-2.5 text-center ${r === currentRole ? 'bg-primary/5' : ''}`}>
                      {cap[r] ? (
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-success/10 text-success text-xs font-bold">&#10003;</span>
                      ) : (
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-surface-hover text-text-muted dark:text-gray-600 text-xs">&mdash;</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-surface-hover border border-border rounded-lg p-4">
        <p className="text-xs text-text-muted">
          Roles are hierarchical: each role inherits all permissions from roles below it. Owner permissions cannot be edited.
          Contact your organization owner to change your role.
        </p>
      </div>
    </div>
  );
}

function SecuritySettings() {
  const { data, isLoading } = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: () => api.get<{ tenant: Tenant }>('/tenants/me'),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  const tenant = data?.tenant;
  const settings = (tenant?.settings ?? {}) as Record<string, unknown>;
  const sessionTimeoutMinutes = (settings.sessionTimeoutMinutes as number) ?? 480;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Security Settings</h2>
        <p className="text-sm text-text-muted mt-0.5">Review your organization's security configuration</p>
      </div>

      <div className="bg-surface border border-border rounded-xl divide-y divide-border">
        <div className="p-6">
          <h3 className="text-sm font-medium text-text-primary mb-3">Authentication</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">Authentication Method</span>
              <span className="text-sm text-text-primary font-medium">Email / Password (JWT)</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">Session Duration</span>
              <span className="text-sm text-text-primary font-medium">
                <Clock className="h-3.5 w-3.5 inline-block mr-1 -mt-0.5" />
                {sessionTimeoutMinutes >= 60 ? `${Math.floor(sessionTimeoutMinutes / 60)}h` : `${sessionTimeoutMinutes}m`}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">Token Type</span>
              <span className="text-sm text-text-primary font-medium">JWT (Bearer)</span>
            </div>
          </div>
        </div>

        <div className="p-6">
          <h3 className="text-sm font-medium text-text-primary mb-3">Password Policy</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">Minimum Length</span>
              <span className="text-sm text-text-primary font-medium">8 characters</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">Complexity Requirements</span>
              <span className="text-sm text-text-primary font-medium">Standard</span>
            </div>
          </div>
        </div>

        <div className="p-6">
          <h3 className="text-sm font-medium text-text-primary mb-3">Access Control</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">Role-Based Access</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-success/10 text-success">Enabled</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">Row-Level Security</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-success/10 text-success">Enabled</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">PHI Protection</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-success/10 text-success">Active</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">API Key Authentication</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-success/10 text-success">Available</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">Audit Logging</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-success/10 text-success">Enabled</span>
            </div>
          </div>
        </div>

        <div className="p-6">
          <h3 className="text-sm font-medium text-text-primary mb-3">Data Protection</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">Encryption at Rest</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-success/10 text-success">Enabled</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">Encryption in Transit</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-success/10 text-success">TLS 1.2+</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">Connector Secret Encryption</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-success/10 text-success">AES-256</span>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-surface-hover border border-border rounded-lg p-4">
        <p className="text-xs text-text-muted">
          Values shown reflect platform-level defaults for your current plan. Contact support for SSO/SAML configuration,
          custom IP allowlists, or advanced security policy changes.
        </p>
      </div>
    </div>
  );
}

interface DeletionRequest {
  id: string;
  requested_at: string;
  scheduled_for: string;
  status: string;
  reason: string | null;
}

function PrivacySettings() {
  const queryClient = useQueryClient();
  const { isOwner } = useRole();
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [reason, setReason] = useState('');
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['deletion-request'],
    queryFn: () => api.get<{ request: DeletionRequest | null }>('/privacy/deletion-request'),
  });

  const pending = data?.request ?? null;

  const requestDeletion = useMutation({
    mutationFn: () =>
      api.post('/privacy/deletion-request', { confirmation: confirmText, reason: reason || null }),
    onSuccess: () => {
      setShowDeleteConfirm(false);
      setConfirmText('');
      setReason('');
      setActionMsg('Deletion scheduled. You can cancel within 30 days.');
      queryClient.invalidateQueries({ queryKey: ['deletion-request'] });
    },
    onError: (err: Error) => setActionMsg(err.message),
  });

  const cancelDeletion = useMutation({
    mutationFn: (id: string) => api.delete(`/privacy/deletion-request/${id}`),
    onSuccess: () => {
      setActionMsg('Deletion request cancelled.');
      queryClient.invalidateQueries({ queryKey: ['deletion-request'] });
    },
  });

  const exportData = async () => {
    setExportError(null);
    setExporting(true);
    try {
      const token = localStorage.getItem('auth_token');
      const res = await fetch('/api/privacy/export', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Export failed: ${res.status} ${txt}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `qvo-data-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Privacy & Data</h2>
        <p className="text-sm text-text-muted mt-0.5">
          Exercise your data rights under GDPR, CCPA, and other privacy laws.
        </p>
      </div>

      {actionMsg && (
        <div className="bg-success/10 text-success text-sm px-4 py-3 rounded-lg flex items-center gap-2">
          <CheckCircle className="h-4 w-4 shrink-0" />
          {actionMsg}
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl p-6">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Download className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-text-primary">Export your data</h3>
            <p className="text-sm text-text-muted mt-1 mb-4">
              Download a JSON bundle containing your tenant configuration, users, agents, phone numbers,
              call sessions (last 5,000), and audit logs (last 5,000). This action is recorded in your audit log.
            </p>
            {exportError && (
              <div className="bg-danger/10 text-danger text-xs px-3 py-2 rounded mb-3">{exportError}</div>
            )}
            {isOwner ? (
              <button
                onClick={exportData}
                disabled={exporting}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                {exporting ? 'Generating export…' : 'Export my data'}
              </button>
            ) : (
              <p className="text-xs text-text-muted">Only the account owner can request an export.</p>
            )}
          </div>
        </div>
      </div>

      <div className="bg-surface border border-danger/30 rounded-xl p-6">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-lg bg-danger/10 flex items-center justify-center flex-shrink-0">
            <Trash2 className="h-5 w-5 text-danger" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-text-primary">Delete account</h3>
            <p className="text-sm text-text-muted mt-1 mb-4">
              Schedule deletion of your QVO account and all associated data. Deletion takes effect after a
              <strong> 30-day cool-off period</strong>, during which you can cancel. After deletion, data may
              persist in encrypted backups for up to 30 additional days before being purged.
            </p>

            {pending ? (
              <div className="bg-warning/10 border border-warning/30 rounded-lg p-4 mb-3">
                <p className="text-sm font-medium text-text-primary mb-1">Deletion scheduled</p>
                <p className="text-xs text-text-muted mb-3">
                  Requested {new Date(pending.requested_at).toLocaleString()} —
                  scheduled for {new Date(pending.scheduled_for).toLocaleDateString()}.
                </p>
                {isOwner && (
                  <button
                    onClick={() => cancelDeletion.mutate(pending.id)}
                    disabled={cancelDeletion.isPending}
                    className="text-xs font-medium px-3 py-1.5 bg-surface border border-border rounded text-text-primary hover:bg-surface-hover"
                  >
                    Cancel deletion request
                  </button>
                )}
              </div>
            ) : isOwner ? (
              showDeleteConfirm ? (
                <div className="bg-danger/5 border border-danger/30 rounded-lg p-4 space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-text-primary mb-1">
                      Reason (optional)
                    </label>
                    <textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      rows={2}
                      className="w-full px-3 py-2 rounded border border-border bg-surface text-text-primary text-sm"
                      placeholder="Help us improve…"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-text-primary mb-1">
                      Type <span className="font-mono bg-surface-hover px-1.5 py-0.5 rounded">DELETE MY ACCOUNT</span> to confirm
                    </label>
                    <input
                      type="text"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      className="w-full px-3 py-2 rounded border border-border bg-surface text-text-primary text-sm font-mono"
                    />
                  </div>
                  {requestDeletion.error && (
                    <div className="text-xs text-danger">{(requestDeletion.error as Error).message}</div>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => requestDeletion.mutate()}
                      disabled={confirmText !== 'DELETE MY ACCOUNT' || requestDeletion.isPending}
                      className="px-4 py-2 bg-danger hover:bg-danger/90 text-white text-sm font-medium rounded-lg disabled:opacity-50"
                    >
                      {requestDeletion.isPending ? 'Scheduling…' : 'Confirm deletion'}
                    </button>
                    <button
                      onClick={() => { setShowDeleteConfirm(false); setConfirmText(''); }}
                      className="px-4 py-2 bg-surface border border-border text-text-primary text-sm font-medium rounded-lg"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-surface border border-danger/40 text-danger text-sm font-medium rounded-lg hover:bg-danger/5"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete my account
                </button>
              )
            ) : (
              <p className="text-xs text-text-muted">Only the account owner can request deletion.</p>
            )}
          </div>
        </div>
      </div>

      <div className="bg-surface-hover border border-border rounded-lg p-4">
        <p className="text-xs text-text-muted">
          Need a Data Processing Addendum, sub-processor list, or other compliance documentation?
          See our <a href="/security" target="_blank" rel="noreferrer" className="text-primary hover:underline">Security page</a> or
          contact privacy@qvo.example.
        </p>
      </div>
    </div>
  );
}

type NotificationCategory = 'call' | 'billing' | 'sms' | 'integration' | 'escalation';
type NotificationChannel = 'in_app' | 'email';
type PreferenceMatrix = Record<NotificationCategory, Record<NotificationChannel, boolean>>;

interface PreferencesResponse {
  preferences: PreferenceMatrix;
  categories: NotificationCategory[];
  channels: NotificationChannel[];
}

const CATEGORY_META: Record<NotificationCategory, { label: string; description: string }> = {
  call: {
    label: 'Calls',
    description: 'Saved-view subscriptions, transcript-ready alerts, and other call activity.',
  },
  billing: {
    label: 'Billing & usage',
    description: 'Plan limit warnings, usage spikes, and account-status changes.',
  },
  sms: {
    label: 'SMS alerts',
    description: 'Outbound SMS escalations and text-channel incident alerts.',
  },
  integration: {
    label: 'Integrations',
    description: 'Connector sync errors, OAuth re-auth requests, and integration outages.',
  },
  escalation: {
    label: 'Escalations',
    description: 'High-priority operator escalations from agent runs and tickets.',
  },
};

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  in_app: 'In-app inbox',
  email: 'Email',
};

function NotificationSettings() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<PreferenceMatrix | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  const { data, isLoading, error } = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => api.get<PreferencesResponse>('/platform/notifications/preferences'),
  });

  useEffect(() => {
    if (data?.preferences) setDraft(data.preferences);
  }, [data]);

  const mutation = useMutation({
    mutationFn: (preferences: PreferenceMatrix) =>
      api.put<PreferencesResponse>('/platform/notifications/preferences', { preferences }),
    onSuccess: (resp) => {
      if (resp.preferences) setDraft(resp.preferences);
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ['notification-preferences'] });
    },
  });

  if (error) {
    return (
      <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg flex items-center gap-2">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Couldn't load your notification preferences. Please try again.</span>
      </div>
    );
  }

  if (isLoading || !draft) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  const categories = (data?.categories ?? (Object.keys(draft) as NotificationCategory[]));
  const channels = (data?.channels ?? (['in_app', 'email'] as NotificationChannel[]));

  const dirty =
    !!data?.preferences &&
    JSON.stringify(draft) !== JSON.stringify(data.preferences);
  const showSaved = savedAt > 0 && Date.now() - savedAt < 3000;

  const toggle = (category: NotificationCategory, channel: NotificationChannel) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next: PreferenceMatrix = { ...prev };
      const row = { ...(next[category] ?? { in_app: true, email: true }) };
      row[channel] = !(row[channel] ?? true);
      next[category] = row;
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Notification preferences</h2>
        <p className="text-sm text-text-muted mt-0.5">
          Mute the categories you don't care about. Defaults are everything on, so changes only suppress
          the rows you turn off — your teammates' inboxes are unaffected.
        </p>
      </div>

      {mutation.error && (
        <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {(mutation.error as Error).message || 'Failed to save preferences'}
        </div>
      )}
      {showSaved && (
        <div className="bg-success/10 text-success text-sm px-4 py-3 rounded-lg flex items-center gap-2">
          <CheckCircle className="h-4 w-4 shrink-0" />
          Preferences saved
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="grid grid-cols-[1fr_repeat(2,minmax(110px,auto))] gap-x-4 px-5 py-3 border-b border-border bg-surface-hover text-xs font-semibold text-text-secondary uppercase tracking-wide">
          <div>Category</div>
          {channels.map((ch) => (
            <div key={ch} className="text-center">{CHANNEL_LABELS[ch]}</div>
          ))}
        </div>
        <div className="divide-y divide-border">
          {categories.map((cat) => {
            const meta = CATEGORY_META[cat] ?? { label: cat, description: '' };
            const row = draft[cat] ?? { in_app: true, email: true };
            return (
              <div
                key={cat}
                className="grid grid-cols-[1fr_repeat(2,minmax(110px,auto))] gap-x-4 px-5 py-4 items-center"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text-primary">{meta.label}</div>
                  <p className="text-xs text-text-muted mt-0.5">{meta.description}</p>
                </div>
                {channels.map((ch) => {
                  const enabled = row[ch] ?? true;
                  return (
                    <div key={ch} className="flex justify-center">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        aria-label={`${meta.label} — ${CHANNEL_LABELS[ch]}`}
                        onClick={() => toggle(cat, ch)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                          enabled ? 'bg-primary' : 'bg-surface-hover border border-border'
                        }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                            enabled ? 'translate-x-5' : 'translate-x-0.5'
                          }`}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        {dirty && (
          <button
            onClick={() => data?.preferences && setDraft(data.preferences)}
            className="px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            Discard changes
          </button>
        )}
        <button
          onClick={() => draft && mutation.mutate(draft)}
          disabled={!dirty || mutation.isPending}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {mutation.isPending ? 'Saving…' : 'Save preferences'}
        </button>
      </div>
    </div>
  );
}

export default function Settings() {
  const location = useLocation();
  const navigate = useNavigate();

  const pathSegment = location.pathname.replace('/settings/', '').replace('/settings', '') as Tab;
  const tab: Tab = TABS.some((t) => t.key === pathSegment) ? pathSegment : 'general';

  const setTab = (t: Tab) => {
    navigate(`/settings/${t}`, { replace: true });
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-text-primary">Settings</h1>
        <p className="text-sm text-text-muted mt-0.5">Manage your organization configuration</p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'general' && <GeneralSettings />}
      {tab === 'notifications' && <NotificationSettings />}
      {tab === 'roles' && <RolesPermissions />}
      {tab === 'security' && <SecuritySettings />}
      {tab === 'api-keys' && <ApiKeys />}
      {tab === 'privacy' && <PrivacySettings />}
    </div>
  );
}
