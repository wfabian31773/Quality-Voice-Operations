import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useContext,
  createContext,
  type ComponentType,
} from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, Navigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useRole, ROLE_LABELS, PERMISSIONS_MATRIX, type SimpleRole } from '../lib/useRole';
import {
  Settings2, Shield, Key, Save, CheckCircle, AlertCircle, Globe, Clock, Users,
  Lock, Download, Trash2, Bell, BellOff, Mail, Sparkles, Loader2,
  MessageSquareHeart, Star,
} from 'lucide-react';
import ApiKeys from './ApiKeys';
import VoicePicker from '../components/VoicePicker';
import { PageHeader } from '../components/ui';
import {
  AGENT_LANGUAGES,
  DEFAULT_AGENT_LANGUAGE,
  normalizeAgentLanguage,
} from '../lib/agentLanguages';
import { getDefaultWelcomeGreeting } from '../lib/agentBuilderI18n';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  status: string;
  plan: string;
  settings: Record<string, unknown> | null;
  // Top-level `timezone` mirrors the `tenants.timezone` column added in
  // migration 097. The scheduling code (`getTenantTimezone` in
  // `server/admin-api/routes/scheduling.ts`) reads this column directly when
  // expanding recurring series and checking override windows, so the General
  // Settings form writes it as a top-level field rather than nesting it
  // inside `settings.timezone` (which the scheduler never sees).
  timezone: string;
  created_at: string;
  updated_at: string;
}

const VOICE_MODELS = [
  { value: 'gpt-4o-realtime-preview', label: 'GPT-4o Realtime' },
  { value: 'gpt-4o-mini-realtime-preview', label: 'GPT-4o Mini Realtime' },
];

const ALL_TIMEZONES: string[] = (() => {
  const intlExt = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };
  try {
    if (typeof intlExt.supportedValuesOf === 'function') {
      return intlExt.supportedValuesOf('timeZone');
    }
  } catch {
    // fall through to fallback list
  }
  return [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin',
    'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata',
    'Australia/Sydney', 'UTC',
  ];
})();

type Tab = 'general' | 'security' | 'api-keys' | 'roles' | 'privacy' | 'notifications' | 'csat';

const TABS: { key: Tab; label: string; icon: typeof Settings2 }[] = [
  { key: 'general', label: 'General', icon: Settings2 },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'csat', label: 'Customer Satisfaction', icon: MessageSquareHeart },
  { key: 'roles', label: 'Roles & Permissions', icon: Users },
  { key: 'security', label: 'Security', icon: Shield },
  { key: 'api-keys', label: 'API Keys', icon: Key },
  { key: 'privacy', label: 'Privacy & Data', icon: Lock },
];

interface AgentType {
  value: string;
  label: string;
}

// ---- Per-tab "unsaved changes" dirty registry ----
//
// Each panel that has a save flow reports its dirty state via `useReportDirty`.
// The Settings parent renders a small dot on the tab button whenever any
// registration for that tab is currently dirty. Registration ids are namespaced
// as `<tab>` or `<tab>:<sub-panel>` so multiple sub-panels (e.g. the
// notification matrix and connector alert preferences) can both contribute to
// the same tab badge.

interface SettingsDirtyContextValue {
  setDirty: (id: string, dirty: boolean) => void;
}

const SettingsDirtyContext = createContext<SettingsDirtyContextValue>({
  setDirty: () => {},
});

function useReportDirty(id: string, dirty: boolean) {
  const { setDirty } = useContext(SettingsDirtyContext);
  useEffect(() => {
    setDirty(id, dirty);
    return () => setDirty(id, false);
  }, [id, dirty, setDirty]);
}

function GeneralSettings() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { isOwner } = useRole();
  const [saved, setSaved] = useState(false);
  const [restartingOnboarding, setRestartingOnboarding] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  const restartOnboarding = async () => {
    if (restartingOnboarding) return;
    setRestartError(null);
    setRestartingOnboarding(true);
    try {
      // Shallow-merge the wizard's resume keys back to a fresh state. The
      // PATCH endpoint only supports merge (not delete), so we explicitly
      // overwrite both keys with values that the wizard's resume logic
      // treats as "not started": `clampStep(null)` returns null, and
      // `!onboarding_completed` is truthy when set to false.
      await api.patch('/me/preferences', {
        onboarding_step: null,
        onboarding_completed: false,
      });
      navigate('/onboarding');
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : 'Failed to restart onboarding');
      setRestartingOnboarding(false);
    }
  };

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
    primaryLanguage: DEFAULT_AGENT_LANGUAGE,
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
        // The `/tenants/me` GET COALESCEs `tenants.timezone` to
        // 'America/New_York', so `t.timezone` is always populated. The
        // remaining fallbacks (`s.timezone` from the legacy JSON blob, then
        // the browser zone) are belt-and-suspenders defenses for any
        // hypothetical response that omits the column entirely.
        timezone:
          t.timezone ?? s.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        primaryLanguage: normalizeAgentLanguage(s.primaryLanguage ?? DEFAULT_AGENT_LANGUAGE),
        defaultVoiceModel: s.defaultVoiceModel ?? 'gpt-4o-realtime-preview',
        defaultVoice: s.defaultVoice ?? 'sage',
        defaultAgentType: s.defaultAgentType ?? 'general',
      });
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: () => {
      // Strip any legacy `timezone` entry from the JSON `settings` blob so
      // there's a single source of truth (the `tenants.timezone` column).
      // Without this, a stale `settings.timezone` could drift away from the
      // value the scheduler actually reads.
      const nextSettings: Record<string, unknown> = {
        ...(data?.tenant?.settings ?? {}),
        primaryLanguage: form.primaryLanguage,
        defaultVoiceModel: form.defaultVoiceModel,
        defaultVoice: form.defaultVoice,
        defaultAgentType: form.defaultAgentType,
      };
      delete nextSettings.timezone;
      return api.patch('/tenants/me', {
        name: form.name,
        timezone: form.timezone,
        settings: nextSettings,
      });
    },
    onSuccess: () => {
      // Update the cached tenant immediately so the dirty comparison
      // (form vs. baseline) flips to false right away — otherwise the
      // unsaved-changes dot can linger until the refetch resolves.
      const previous = queryClient.getQueryData<{ tenant: Tenant }>(['tenant-settings']);
      if (previous?.tenant) {
        const nextSettings: Record<string, unknown> = {
          ...((previous.tenant.settings ?? {}) as Record<string, unknown>),
          primaryLanguage: form.primaryLanguage,
          defaultVoiceModel: form.defaultVoiceModel,
          defaultVoice: form.defaultVoice,
          defaultAgentType: form.defaultAgentType,
        };
        delete nextSettings.timezone;
        queryClient.setQueryData(['tenant-settings'], {
          tenant: {
            ...previous.tenant,
            name: form.name,
            timezone: form.timezone,
            settings: nextSettings,
          },
        });
      }
      queryClient.invalidateQueries({ queryKey: ['tenant-settings'] });
      queryClient.invalidateQueries({ queryKey: ['tenant-primary-language'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  const dirty = useMemo(() => {
    if (!data?.tenant) return false;
    const t = data.tenant;
    const s = (t.settings ?? {}) as Record<string, string>;
    const original = {
      name: t.name ?? '',
      timezone:
        t.timezone ?? s.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      primaryLanguage: normalizeAgentLanguage(s.primaryLanguage ?? DEFAULT_AGENT_LANGUAGE),
      defaultVoiceModel: s.defaultVoiceModel ?? 'gpt-4o-realtime-preview',
      defaultVoice: s.defaultVoice ?? 'sage',
      defaultAgentType: s.defaultAgentType ?? 'general',
    };
    return (
      original.name !== form.name ||
      original.timezone !== form.timezone ||
      original.primaryLanguage !== form.primaryLanguage ||
      original.defaultVoiceModel !== form.defaultVoiceModel ||
      original.defaultVoice !== form.defaultVoice ||
      original.defaultAgentType !== form.defaultAgentType
    );
  }, [data, form]);
  useReportDirty('general', dirty);

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

  const set = (key: keyof typeof form, value: string) =>
    setForm((f) => {
      if (key === 'primaryLanguage') {
        return { ...f, primaryLanguage: normalizeAgentLanguage(value) };
      }
      return { ...f, [key]: value };
    });

  const previewGreeting = getDefaultWelcomeGreeting(form.primaryLanguage);

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
          <label className="block text-sm font-medium text-text-primary mb-1.5">
            <Globe className="h-4 w-4 inline-block mr-1.5 -mt-0.5 text-text-muted" />
            Primary Language
          </label>
          <select
            value={form.primaryLanguage}
            onChange={(e) => set('primaryLanguage', e.target.value)}
            disabled={!isOwner}
            className="w-full max-w-md px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {AGENT_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}{l.nativeLabel !== l.label ? ` (${l.nativeLabel})` : ''}
              </option>
            ))}
          </select>
          <p className="text-xs text-text-muted mt-1.5 max-w-md">
            New agents pre-fill with this language, and the Default Voice picker below recommends voices and previews greetings in this language.
          </p>
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
          <div
            className={`max-w-md ${!isOwner ? 'opacity-60 pointer-events-none' : ''}`}
            aria-disabled={!isOwner}
          >
            <VoicePicker
              voice={form.defaultVoice}
              language={form.primaryLanguage}
              welcomeGreeting={previewGreeting}
              onChange={(next) => {
                if (!isOwner) return;
                set('defaultVoice', next);
              }}
              labelClassName="block text-sm font-medium text-text-primary mb-1.5"
            />
          </div>
          <p className="text-xs text-text-muted mt-1.5 max-w-md">Voice used for new agents by default. Use the play buttons to preview each voice.</p>
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

      <div className="bg-surface border border-border rounded-xl p-6">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-text-primary">Onboarding wizard</h3>
            <p className="text-sm text-text-muted mt-1 mb-4">
              Replay the welcome wizard to revisit the agent template picker and walk through setup again.
              This affects only your account.
            </p>
            {restartError && (
              <div className="bg-danger/10 text-danger text-xs px-3 py-2 rounded mb-3">{restartError}</div>
            )}
            <button
              type="button"
              onClick={restartOnboarding}
              disabled={restartingOnboarding}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-surface border border-border text-text-primary text-sm font-medium rounded-lg hover:bg-surface-hover disabled:opacity-50"
            >
              {restartingOnboarding ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Restarting…
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" /> Restart onboarding
                </>
              )}
            </button>
          </div>
        </div>
      </div>
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

type NotificationCategory =
  | 'call'
  | 'billing'
  | 'sms'
  | 'integration'
  | 'integration_recovery'
  | 'escalation';
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
    label: 'Integration failures',
    description: 'Connector sync errors, OAuth re-auth requests, and integration outages.',
  },
  integration_recovery: {
    label: 'Integration recoveries',
    description: 'All-clear notifications when a previously-failing connector starts syncing again.',
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

// ---- Connector alert preferences (per-tenant) ----

type MuteScope = 'provider' | 'integration';

interface ConnectorAlertMute {
  scope: MuteScope;
  target: string;
}

interface ConnectorAlertSettingsResp {
  digestMode: boolean;
  digestLastSentAt: string | null;
  updatedAt: string | null;
}

interface ConnectorAlertPrefsResponse {
  settings: ConnectorAlertSettingsResp;
  mutes: ConnectorAlertMute[];
}

interface ConnectorListItem {
  integrationId: string;
  provider: string;
  name: string | null;
  integrationType?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  salesforce: 'Salesforce',
  hubspot: 'HubSpot',
  quickbooks: 'QuickBooks',
  google: 'Google',
  google_calendar: 'Google Calendar',
  outlook: 'Outlook',
  outlook_calendar: 'Outlook Calendar',
  microsoft: 'Microsoft',
  pipedrive: 'Pipedrive',
  slack: 'Slack',
  zapier: 'Zapier',
  twilio: 'Twilio',
};

function providerLabel(provider: string | null | undefined): string {
  if (!provider) return 'Integration';
  return PROVIDER_LABELS[provider.toLowerCase()] ?? provider;
}

function ConnectorAlertSettings() {
  const queryClient = useQueryClient();
  const { isManager } = useRole();
  const [savedAt, setSavedAt] = useState(0);

  const { data, isLoading, error } = useQuery({
    queryKey: ['connector-alert-prefs'],
    queryFn: () => api.get<ConnectorAlertPrefsResponse>('/platform/notifications/connector-alerts'),
  });
  const { data: connectorsData } = useQuery({
    queryKey: ['connectors-list-for-alerts'],
    queryFn: () =>
      api.get<{ connectors: ConnectorListItem[] }>('/connectors?limit=100'),
  });

  const [digestMode, setDigestMode] = useState(false);
  const [mutedProviders, setMutedProviders] = useState<Set<string>>(new Set());
  const [mutedIntegrations, setMutedIntegrations] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!data) return;
    setDigestMode(!!data.settings.digestMode);
    const provs = new Set<string>();
    const ints = new Set<string>();
    for (const m of data.mutes ?? []) {
      if (m.scope === 'provider') provs.add(m.target.toLowerCase());
      else if (m.scope === 'integration') ints.add(m.target);
    }
    setMutedProviders(provs);
    setMutedIntegrations(ints);
  }, [data]);

  const mutation = useMutation({
    mutationFn: (payload: { digestMode: boolean; mutes: ConnectorAlertMute[] }) =>
      api.put<ConnectorAlertPrefsResponse>(
        '/platform/notifications/connector-alerts',
        payload,
      ),
    onSuccess: (resp) => {
      setSavedAt(Date.now());
      queryClient.setQueryData(['connector-alert-prefs'], resp);
    },
  });

  const connectors = connectorsData?.connectors ?? [];
  const providersInUse = useMemo(() => {
    const seen = new Map<string, ConnectorListItem[]>();
    for (const c of connectors) {
      const key = (c.provider || '').toLowerCase();
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key)!.push(c);
    }
    return Array.from(seen.entries())
      .map(([provider, items]) => ({ provider, items }))
      .sort((a, b) => providerLabel(a.provider).localeCompare(providerLabel(b.provider)));
  }, [connectors]);

  const dirty = useMemo(() => {
    if (!data) return false;
    if (digestMode !== !!data.settings.digestMode) return true;
    const origProvs = new Set(
      (data.mutes ?? []).filter((m) => m.scope === 'provider').map((m) => m.target.toLowerCase()),
    );
    const origInts = new Set(
      (data.mutes ?? []).filter((m) => m.scope === 'integration').map((m) => m.target),
    );
    if (origProvs.size !== mutedProviders.size) return true;
    for (const p of mutedProviders) if (!origProvs.has(p)) return true;
    if (origInts.size !== mutedIntegrations.size) return true;
    for (const i of mutedIntegrations) if (!origInts.has(i)) return true;
    return false;
  }, [data, digestMode, mutedProviders, mutedIntegrations]);
  useReportDirty('notifications:connector-alerts', dirty);

  const showSaved = savedAt > 0 && Date.now() - savedAt < 3000;

  if (error) {
    return (
      <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg flex items-center gap-2">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Couldn't load connector alert preferences. Please try again.</span>
      </div>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin h-6 w-6 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  const toggleProvider = (provider: string) => {
    if (!isManager) return;
    setMutedProviders((prev) => {
      const next = new Set(prev);
      const key = provider.toLowerCase();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleIntegration = (integrationId: string) => {
    if (!isManager) return;
    setMutedIntegrations((prev) => {
      const next = new Set(prev);
      if (next.has(integrationId)) next.delete(integrationId);
      else next.add(integrationId);
      return next;
    });
  };

  const reset = () => {
    if (!data) return;
    setDigestMode(!!data.settings.digestMode);
    const provs = new Set<string>();
    const ints = new Set<string>();
    for (const m of data.mutes ?? []) {
      if (m.scope === 'provider') provs.add(m.target.toLowerCase());
      else if (m.scope === 'integration') ints.add(m.target);
    }
    setMutedProviders(provs);
    setMutedIntegrations(ints);
  };

  const save = () => {
    if (!isManager) return;
    const mutes: ConnectorAlertMute[] = [
      ...Array.from(mutedProviders).map<ConnectorAlertMute>((target) => ({
        scope: 'provider',
        target,
      })),
      ...Array.from(mutedIntegrations).map<ConnectorAlertMute>((target) => ({
        scope: 'integration',
        target,
      })),
    ];
    mutation.mutate({ digestMode, mutes });
  };

  return (
    <div className="space-y-5 mt-10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Connector alert preferences</h2>
          <p className="text-sm text-text-muted mt-0.5">
            Mute alerts for specific connectors, or batch every connector failure into a single
            daily digest email instead of one per integration. The 24-hour in-app throttle still
            applies on top of these settings.
          </p>
        </div>
      </div>

      {!isManager && (
        <div className="bg-amber-100/40 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200 text-xs px-3 py-2 rounded-lg flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          Only owners and managers can change these tenant-wide settings.
        </div>
      )}

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

      <div className="bg-surface border border-border rounded-xl p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-text-secondary" />
              <span className="text-sm font-medium text-text-primary">Daily digest mode</span>
            </div>
            <p className="text-xs text-text-muted mt-1 max-w-md">
              When on, connector failures stop sending one email per integration. Instead, every
              admin gets a single summary email at most once per 24 hours that lists every
              currently-failing connector. In-app notifications still fire normally.
            </p>
            {data.settings.digestLastSentAt && (
              <p className="text-[11px] text-text-muted mt-1.5">
                Last digest sent: {new Date(data.settings.digestLastSentAt).toLocaleString()}
              </p>
            )}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={digestMode}
            disabled={!isManager}
            onClick={() => isManager && setDigestMode((v) => !v)}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
              digestMode ? 'bg-primary' : 'bg-surface-hover border border-border'
            } ${isManager ? '' : 'opacity-60 cursor-not-allowed'}`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                digestMode ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-border bg-surface-hover">
          <div className="flex items-center gap-2">
            <BellOff className="h-4 w-4 text-text-secondary" />
            <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
              Mute alerts
            </span>
          </div>
          <p className="text-xs text-text-muted mt-1">
            Silence both email and in-app failure alerts for an entire provider, or a single
            connected integration. Recovery and SMS alerts honour the same mute.
          </p>
        </div>
        {providersInUse.length === 0 ? (
          <div className="px-5 py-6 text-center text-sm text-text-muted">
            You don't have any connected integrations yet.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {providersInUse.map(({ provider, items }) => {
              const provMuted = mutedProviders.has(provider);
              return (
                <div key={provider} className="px-5 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-text-primary">
                        {providerLabel(provider)}
                      </div>
                      <p className="text-xs text-text-muted mt-0.5">
                        {items.length === 1
                          ? '1 connected integration'
                          : `${items.length} connected integrations`}
                      </p>
                    </div>
                    <label className="inline-flex items-center gap-2 text-xs text-text-secondary">
                      <span>Mute provider</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={provMuted}
                        disabled={!isManager}
                        onClick={() => toggleProvider(provider)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                          provMuted ? 'bg-primary' : 'bg-surface-hover border border-border'
                        } ${isManager ? '' : 'opacity-60 cursor-not-allowed'}`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                            provMuted ? 'translate-x-5' : 'translate-x-0.5'
                          }`}
                        />
                      </button>
                    </label>
                  </div>
                  {!provMuted && items.length > 1 && (
                    <div className="mt-2 ml-1 space-y-1.5">
                      {items.map((item) => {
                        const intMuted = mutedIntegrations.has(item.integrationId);
                        return (
                          <label
                            key={item.integrationId}
                            className="flex items-center justify-between gap-2 text-xs text-text-secondary"
                          >
                            <span className="truncate">
                              {item.name?.trim() || providerLabel(item.provider)}
                            </span>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={intMuted}
                              disabled={!isManager}
                              onClick={() => toggleIntegration(item.integrationId)}
                              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                                intMuted ? 'bg-primary' : 'bg-surface-hover border border-border'
                              } ${isManager ? '' : 'opacity-60 cursor-not-allowed'}`}
                            >
                              <span
                                className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${
                                  intMuted ? 'translate-x-3.5' : 'translate-x-0.5'
                                }`}
                              />
                            </button>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {isManager && (
        <div className="flex items-center justify-end gap-3">
          {dirty && (
            <button
              onClick={reset}
              className="px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary"
            >
              Discard changes
            </button>
          )}
          <button
            onClick={save}
            disabled={!dirty || mutation.isPending}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {mutation.isPending ? 'Saving…' : 'Save connector preferences'}
          </button>
        </div>
      )}
    </div>
  );
}

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
      if (resp.preferences) {
        // Push the just-saved preferences into both the local draft and
        // the query cache so the dirty comparison clears the tab badge
        // immediately, without waiting for the background refetch.
        setDraft(resp.preferences);
        queryClient.setQueryData(['notification-preferences'], resp);
      }
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ['notification-preferences'] });
    },
  });

  const dirty =
    !!draft &&
    !!data?.preferences &&
    JSON.stringify(draft) !== JSON.stringify(data.preferences);
  useReportDirty('notifications:matrix', dirty);

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
      <NotificationCategoryMatrix
        data={data}
        draft={draft}
        categories={categories}
        channels={channels}
        dirty={dirty}
        showSaved={showSaved}
        mutationError={mutation.error as Error | null}
        isPending={mutation.isPending}
        onToggle={toggle}
        onReset={() => data?.preferences && setDraft(data.preferences)}
        onSave={() => draft && mutation.mutate(draft)}
      />
      <ConnectorAlertSettings />
    </div>
  );
}

interface NotificationCategoryMatrixProps {
  data: PreferencesResponse | undefined;
  draft: PreferenceMatrix;
  categories: NotificationCategory[];
  channels: NotificationChannel[];
  dirty: boolean;
  showSaved: boolean;
  mutationError: Error | null;
  isPending: boolean;
  onToggle: (category: NotificationCategory, channel: NotificationChannel) => void;
  onReset: () => void;
  onSave: () => void;
}

function NotificationCategoryMatrix({
  data,
  draft,
  categories,
  channels,
  dirty,
  showSaved,
  mutationError,
  isPending,
  onToggle,
  onReset,
  onSave,
}: NotificationCategoryMatrixProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Notification preferences</h2>
        <p className="text-sm text-text-muted mt-0.5">
          Mute the categories you don't care about. Defaults are everything on, so changes only suppress
          the rows you turn off — your teammates' inboxes are unaffected.
        </p>
      </div>

      {mutationError && (
        <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {mutationError.message || 'Failed to save preferences'}
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
                        onClick={() => onToggle(cat, ch)}
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
            onClick={onReset}
            className="px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            Discard changes
          </button>
        )}
        <button
          onClick={onSave}
          disabled={!dirty || isPending}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {isPending ? 'Saving…' : 'Save preferences'}
        </button>
      </div>
    </div>
  );
}

interface CsatSettingsPayload {
  enabled: boolean;
  channel: 'sms' | 'web' | 'email';
  scale: number;
  minDurationSeconds: number;
  smsTemplate: string | null;
}

interface CsatRecentResponse {
  id: string;
  callSessionId: string;
  requestChannel: 'sms' | 'ivr' | 'web' | 'email';
  responseChannel: 'sms' | 'ivr' | 'web' | 'email' | null;
  scoreRaw: number | null;
  scoreScale: number | null;
  scoreNormalized: number | null;
  comment: string | null;
  respondedAt: string | null;
}

// Labels intentionally mirror the SMS prompt format ("Reply 1-N (1=poor,
// N=great)") that buildCsatSmsBody actually sends, so the picker, the
// preview, and the customer's text match exactly.
const CSAT_SCALE_OPTIONS = [
  { value: 2, label: '1–2 (thumbs up/down)' },
  { value: 3, label: '1–3' },
  { value: 5, label: '1–5 (stars)' },
  { value: 7, label: '1–7' },
  { value: 10, label: '1–10 (NPS-style)' },
];

const CSAT_CHANNEL_OPTIONS: { value: CsatSettingsPayload['channel']; label: string; helper: string }[] = [
  { value: 'sms', label: 'SMS text', helper: 'Send a short text after the call asking for a rating reply.' },
  { value: 'web', label: 'Web link', helper: 'Generate a per-call survey link surfaced via integrations or follow-ups.' },
  { value: 'email', label: 'Email', helper: 'Include a survey link in a follow-up email (requires email integration).' },
];

function formatCsatChannel(channel: string | null): string {
  if (!channel) return '—';
  if (channel === 'sms') return 'SMS';
  if (channel === 'ivr') return 'IVR';
  if (channel === 'web') return 'Web';
  if (channel === 'email') return 'Email';
  return channel;
}

function formatCsatTimestamp(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function CsatSettings() {
  const queryClient = useQueryClient();
  const { isOwner } = useRole();
  const [saved, setSaved] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['csat-settings'],
    queryFn: () => api.get<{ settings: CsatSettingsPayload }>('/csat/settings'),
  });

  const responsesQuery = useQuery({
    queryKey: ['csat-recent-responses'],
    queryFn: () =>
      api.get<{ responses: CsatRecentResponse[] }>('/csat/responses/recent?limit=20'),
  });

  type CsatFormState = Omit<CsatSettingsPayload, 'smsTemplate'> & { smsTemplate: string };
  const [form, setForm] = useState<CsatFormState>({
    enabled: false,
    channel: 'sms',
    scale: 5,
    minDurationSeconds: 30,
    smsTemplate: '',
  });

  useEffect(() => {
    if (settingsQuery.data?.settings) {
      const s = settingsQuery.data.settings;
      const channel: CsatSettingsPayload['channel'] =
        s.channel === 'sms' || s.channel === 'web' || s.channel === 'email' ? s.channel : 'sms';
      setForm({
        enabled: s.enabled,
        channel,
        scale: s.scale,
        minDurationSeconds: s.minDurationSeconds,
        smsTemplate: s.smsTemplate ?? '',
      });
    }
  }, [settingsQuery.data]);

  const mutation = useMutation({
    mutationFn: (payload: Partial<CsatSettingsPayload>) =>
      api.patch<{ settings: CsatSettingsPayload }>('/csat/settings', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['csat-settings'] });
      setSaved(true);
      setValidationError(null);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (err) => {
      setValidationError(err instanceof Error ? err.message : 'Failed to save CSAT settings');
    },
  });

  const handleSave = () => {
    if (!isOwner) return;
    setValidationError(null);
    if (form.minDurationSeconds < 5 || form.minDurationSeconds > 600) {
      setValidationError('Minimum call duration must be between 5 and 600 seconds.');
      return;
    }
    if (form.smsTemplate && form.smsTemplate.length > 320) {
      setValidationError('SMS template must be 320 characters or fewer.');
      return;
    }
    mutation.mutate({
      enabled: form.enabled,
      channel: form.channel,
      scale: form.scale,
      minDurationSeconds: form.minDurationSeconds,
      smsTemplate: form.smsTemplate.trim().length > 0 ? form.smsTemplate : null,
    });
  };

  if (settingsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (settingsQuery.error) {
    return (
      <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg flex items-center gap-2">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Failed to load CSAT settings. Please check your connection and try again.</span>
        <button
          onClick={() => queryClient.invalidateQueries({ queryKey: ['csat-settings'] })}
          className="ml-auto text-xs font-medium underline hover:no-underline"
        >
          Retry
        </button>
      </div>
    );
  }

  const responses = responsesQuery.data?.responses ?? [];
  const previewRange = `1–${form.scale}`;
  const channelHelper = CSAT_CHANNEL_OPTIONS.find((c) => c.value === form.channel)?.helper ?? '';
  const templatePreview = (form.smsTemplate.trim() || 'Thanks for calling! How would you rate this call?')
    + ` Reply ${previewRange} (1=poor, ${form.scale}=great). Reply STOP to opt out.`;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Customer Satisfaction Surveys</h2>
        <p className="text-sm text-text-muted mt-0.5">
          Automatically ask callers to rate their experience after a call. Responses feed your quality dashboard
          and the cross-tenant CSAT benchmark.
        </p>
      </div>

      {validationError && (
        <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {validationError}
        </div>
      )}

      {saved && (
        <div className="bg-success/10 text-success text-sm px-4 py-3 rounded-lg flex items-center gap-2">
          <CheckCircle className="h-4 w-4 shrink-0" />
          CSAT settings saved successfully
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl divide-y divide-border">
        <div className="p-6 flex items-start justify-between gap-4">
          <div className="flex-1">
            <label className="block text-sm font-medium text-text-primary">Enable post-call surveys</label>
            <p className="text-xs text-text-muted mt-1 max-w-xl">
              When on, qualifying completed calls automatically dispatch a CSAT survey through the channel below.
              Calls shorter than the minimum duration are skipped.
            </p>
          </div>
          <label className="inline-flex items-center cursor-pointer mt-1">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={form.enabled}
              disabled={!isOwner}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
              aria-label="Enable post-call CSAT surveys"
            />
            <span className="relative inline-block w-11 h-6 rounded-full bg-border peer-checked:bg-primary transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:h-5 after:w-5 after:bg-white after:rounded-full after:shadow after:transition-transform peer-checked:after:translate-x-5 peer-disabled:opacity-50" />
          </label>
        </div>

        <div className="p-6">
          <label className="block text-sm font-medium text-text-primary mb-1.5">Survey channel</label>
          <select
            value={form.channel}
            onChange={(e) => setForm((f) => ({ ...f, channel: e.target.value as CsatSettingsPayload['channel'] }))}
            disabled={!isOwner}
            className="w-full max-w-md px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {CSAT_CHANNEL_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
          <p className="text-xs text-text-muted mt-1.5 max-w-md">{channelHelper}</p>
        </div>

        <div className="p-6">
          <label className="block text-sm font-medium text-text-primary mb-1.5">Rating scale</label>
          <select
            value={form.scale}
            onChange={(e) => setForm((f) => ({ ...f, scale: parseInt(e.target.value, 10) }))}
            disabled={!isOwner}
            className="w-full max-w-md px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {CSAT_SCALE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p className="text-xs text-text-muted mt-1.5 max-w-md">
            Scores are normalized internally so you can compare across scales without re-rating prior responses.
          </p>
        </div>

        <div className="p-6">
          <label className="block text-sm font-medium text-text-primary mb-1.5">
            <Clock className="h-4 w-4 inline-block mr-1.5 -mt-0.5 text-text-muted" />
            Minimum call duration
          </label>
          <div className="flex items-center gap-2 max-w-md">
            <input
              type="number"
              min={5}
              max={600}
              step={5}
              value={form.minDurationSeconds}
              onChange={(e) => setForm((f) => ({ ...f, minDurationSeconds: parseInt(e.target.value, 10) || 0 }))}
              disabled={!isOwner}
              className="w-32 px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 disabled:cursor-not-allowed"
            />
            <span className="text-sm text-text-muted">seconds</span>
          </div>
          <p className="text-xs text-text-muted mt-1.5 max-w-md">
            Calls shorter than this won't trigger a survey — avoids surveying hangups and misdials. 5–600 seconds.
          </p>
        </div>

        <div className="p-6">
          <label className="block text-sm font-medium text-text-primary mb-1.5">SMS prompt template</label>
          <textarea
            value={form.smsTemplate}
            onChange={(e) => setForm((f) => ({ ...f, smsTemplate: e.target.value }))}
            disabled={!isOwner || form.channel !== 'sms'}
            rows={3}
            maxLength={320}
            placeholder="Thanks for calling! How would you rate this call?"
            className="w-full max-w-2xl px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 disabled:cursor-not-allowed font-mono"
          />
          <div className="flex items-center justify-between max-w-2xl mt-1.5">
            <p className="text-xs text-text-muted">
              {form.channel === 'sms'
                ? 'Customize the opening line. The rating prompt and STOP footer are appended automatically.'
                : 'Only used when the survey channel is SMS.'}
            </p>
            <span className="text-xs text-text-muted">{form.smsTemplate.length}/320</span>
          </div>
          {form.channel === 'sms' && (
            <div className="mt-3 max-w-2xl bg-surface-hover border border-border rounded-lg p-3">
              <div className="text-xs uppercase tracking-wide text-text-muted mb-1">Preview</div>
              <div className="text-sm text-text-primary whitespace-pre-wrap">{templatePreview}</div>
            </div>
          )}
        </div>
      </div>

      {isOwner ? (
        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={mutation.isPending}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50"
          >
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {mutation.isPending ? 'Saving...' : 'Save CSAT Settings'}
          </button>
        </div>
      ) : (
        <p className="text-sm text-text-muted">Contact your organization owner to change CSAT settings.</p>
      )}

      <div className="bg-surface border border-border rounded-xl">
        <div className="p-6 border-b border-border flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <Star className="h-4 w-4 text-primary" />
              Recent CSAT responses
            </h3>
            <p className="text-xs text-text-muted mt-0.5">
              Most recent {responses.length === 0 ? '20' : responses.length} customer ratings, newest first.
            </p>
          </div>
          <button
            onClick={() => queryClient.invalidateQueries({ queryKey: ['csat-recent-responses'] })}
            className="text-xs font-medium text-primary hover:underline"
          >
            Refresh
          </button>
        </div>

        {responsesQuery.isLoading ? (
          <div className="p-6 flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
          </div>
        ) : responsesQuery.error ? (
          <div className="p-6 text-sm text-danger flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> Failed to load recent responses.
          </div>
        ) : responses.length === 0 ? (
          <div className="p-8 text-center text-sm text-text-muted">
            No CSAT responses yet. Once surveys are enabled and customers reply, they'll show up here.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-5 py-2.5 text-text-secondary font-medium">When</th>
                  <th className="px-5 py-2.5 text-text-secondary font-medium">Score</th>
                  <th className="px-5 py-2.5 text-text-secondary font-medium">Channel</th>
                  <th className="px-5 py-2.5 text-text-secondary font-medium">Comment</th>
                  <th className="px-5 py-2.5 text-text-secondary font-medium">Call</th>
                </tr>
              </thead>
              <tbody>
                {responses.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-surface-hover">
                    <td className="px-5 py-2.5 text-text-primary whitespace-nowrap">{formatCsatTimestamp(r.respondedAt)}</td>
                    <td className="px-5 py-2.5 text-text-primary whitespace-nowrap">
                      {r.scoreRaw != null && r.scoreScale != null ? (
                        <span className="font-medium">{r.scoreRaw} / {r.scoreScale}</span>
                      ) : '—'}
                    </td>
                    <td className="px-5 py-2.5 text-text-muted whitespace-nowrap">
                      {formatCsatChannel(r.responseChannel ?? r.requestChannel)}
                    </td>
                    <td className="px-5 py-2.5 text-text-muted max-w-md">
                      {r.comment ? (
                        <span className="line-clamp-2">{r.comment}</span>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5 whitespace-nowrap">
                      <Link
                        to={`/calls?highlight=${encodeURIComponent(r.callSessionId)}`}
                        className="text-primary hover:underline text-xs"
                      >
                        View call
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const TAB_COMPONENTS: Record<Tab, ComponentType> = {
  general: GeneralSettings,
  notifications: NotificationSettings,
  csat: CsatSettings,
  roles: RolesPermissions,
  security: SecuritySettings,
  'api-keys': ApiKeys,
  privacy: PrivacySettings,
};

export default function Settings() {
  const { t: tenantT } = useTranslation('tenant');
  const navigate = useNavigate();
  const params = useParams<{ tab?: string }>();
  const rawTab = params.tab ?? 'general';
  const isValidTab = TABS.some((t) => t.key === rawTab);
  const tab = (isValidTab ? rawTab : 'general') as Tab;

  // Track which tab panels have been opened so far. Once a tab has been
  // visited we keep it mounted (just visually hidden) so unsaved edits in its
  // form fields survive switching to another tab and back.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set<Tab>([tab]));
  useEffect(() => {
    setVisited((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  }, [tab]);

  // Each panel may register an "unsaved changes" flag via SettingsDirtyContext.
  // Registration ids are namespaced as "<tab>" or "<tab>:<sub-panel>" so a
  // tab's badge lights up if any of its sub-panels has pending edits.
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({});
  const setDirty = useCallback((id: string, value: boolean) => {
    setDirtyMap((prev) => {
      const cur = !!prev[id];
      if (cur === value) return prev;
      if (!value) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: true };
    });
  }, []);
  const dirtyContextValue = useMemo(() => ({ setDirty }), [setDirty]);
  const dirtyTabs = useMemo(() => {
    const set = new Set<Tab>();
    for (const [id, value] of Object.entries(dirtyMap)) {
      if (!value) continue;
      const tabKey = id.split(':', 1)[0] as Tab;
      if (TABS.some((t) => t.key === tabKey)) set.add(tabKey);
    }
    return set;
  }, [dirtyMap]);

  if (!isValidTab) {
    return <Navigate to="/settings/general" replace />;
  }

  const setTab = (t: Tab) => {
    navigate(`/settings/${t}`, { replace: true });
  };

  return (
    <SettingsDirtyContext.Provider value={dirtyContextValue}>
      <div>
        <PageHeader
          title={tenantT('settings.page_title')}
          description={tenantT('settings.page_subtitle')}
          icon={<Settings2 className="h-5 w-5" />}
        />

        <div
          role="tablist"
          aria-label="Settings sections"
          className="flex flex-wrap gap-1 mb-6 border-b border-border"
        >
          {TABS.map((t) => {
            const isDirty = dirtyTabs.has(t.key);
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                title={isDirty ? `${t.label} (unsaved changes)` : t.label}
                className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  tab === t.key
                    ? 'border-primary text-primary'
                    : 'border-transparent text-text-muted hover:text-text-primary'
                }`}
              >
                <t.icon className="h-4 w-4" />
                {t.label}
                {isDirty && (
                  <span
                    aria-label="unsaved changes"
                    title="Unsaved changes"
                    className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-primary"
                  />
                )}
              </button>
            );
          })}
        </div>

        {TABS.map(({ key }) => {
          if (!visited.has(key)) return null;
          const Panel = TAB_COMPONENTS[key];
          const isActive = tab === key;
          return (
            <div
              key={key}
              role="tabpanel"
              aria-hidden={!isActive}
              hidden={!isActive}
            >
              <Panel />
            </div>
          );
        })}
      </div>
    </SettingsDirtyContext.Provider>
  );
}
