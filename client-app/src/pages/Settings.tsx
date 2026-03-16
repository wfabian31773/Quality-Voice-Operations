import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  Settings2, Shield, Key, Save, CheckCircle, AlertCircle, Globe, Clock,
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

const ADMIN_ROLES = ['tenant_owner', 'operations_manager', 'billing_admin', 'agent_developer'];

type Tab = 'general' | 'security' | 'api-keys';

const TABS: { key: Tab; label: string; icon: typeof Settings2 }[] = [
  { key: 'general', label: 'General', icon: Settings2 },
  { key: 'security', label: 'Security', icon: Shield },
  { key: 'api-keys', label: 'API Keys', icon: Key },
];

function GeneralSettings() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = ADMIN_ROLES.includes(user?.role ?? '');
  const [saved, setSaved] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: () => api.get<{ tenant: Tenant }>('/tenants/me'),
  });

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
        Failed to load organization settings
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
            disabled={!isAdmin}
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
            disabled={!isAdmin}
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
            disabled={!isAdmin}
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
            disabled={!isAdmin}
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
            disabled={!isAdmin}
            className="w-full max-w-md px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {['general', 'answering-service', 'medical-after-hours', 'outbound-scheduling', 'appointment-confirmation', 'custom'].map((t) => (
              <option key={t} value={t}>{t.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</option>
            ))}
          </select>
          <p className="text-xs text-text-muted mt-1.5">Template used when creating new agents</p>
        </div>
      </div>

      {isAdmin && (
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

      {!isAdmin && (
        <p className="text-sm text-text-muted">Contact your organization admin to change settings.</p>
      )}
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

export default function Settings() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const isApiKeysPath = location.pathname === '/settings/api-keys';
  const tabParam = searchParams.get('tab') as Tab | null;
  const tab = isApiKeysPath ? 'api-keys' : (tabParam && TABS.some((t) => t.key === tabParam) ? tabParam : 'general');

  const setTab = (t: Tab) => {
    navigate(`/settings?tab=${t}`, { replace: true });
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
      {tab === 'security' && <SecuritySettings />}
      {tab === 'api-keys' && <ApiKeys />}
    </div>
  );
}
