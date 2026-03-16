import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  Building2, Users, PhoneCall, DollarSign, ChevronDown, ChevronRight,
  Ban, CheckCircle, Eye, Package, Plus, Play, Archive, AlertCircle,
  BarChart3, Download as DownloadIcon, TrendingUp, TrendingDown, Activity,
} from 'lucide-react';

interface PlatformStats {
  active_tenants: string;
  total_tenants: string;
  total_users: string;
  total_calls: string;
  calls_last_30d: string;
  calls_last_24h: string;
  total_revenue_cents: string;
  revenue_last_30d_cents: string;
}

interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  created_at: string;
  updated_at: string;
  user_count: string;
  total_calls: string;
  last_call_at: string | null;
  calls_last_30d: string;
}

interface TenantDetail {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  created_at: string;
  user_count: string;
  agent_count: string;
  phone_number_count: string;
  total_calls: string;
  total_cost_cents: string;
}

interface TemplateListItem {
  id: string;
  slug: string;
  displayName: string;
  currentVersion: string;
  status: string;
}

interface TemplateVersion {
  id: string;
  version: string;
  changelog: string;
  releaseNotes: string;
  packageRef: string;
  isLatest: boolean;
  status: string;
  publishedAt: string;
}

interface TemplateDetail {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  currentVersion: string;
  status: string;
  requiredTools: string[];
  versions: TemplateVersion[];
}

interface TemplateAnalytics {
  id: string;
  slug: string;
  displayName: string;
  currentVersion: string;
  status: string;
  installCount: number;
  activeInstalls: number;
  totalInstalls: number;
  uninstallCount: number;
  upgradeCount: number;
  activationRate: number;
  uninstallRate: number;
  upgradeAdoption: number;
  totalCalls: number;
  callsLast30d: number;
  avgCallDuration: number;
  avgSatisfaction: number;
  totalCampaigns: number;
  completedCampaigns: number;
}

interface CostMonitoringData {
  daily: {
    callMinutes: number;
    aiCostCents: number;
    twilioCostCents: number;
    smsCostCents: number;
    callCount: number;
    toolExecutions: number;
    apiRequests: number;
    totalCostCents: number;
  };
  monthly: {
    callMinutes: number;
    callCount: number;
    totalCostCents: number;
    aiCostCents: number;
    twilioCostCents: number;
    revenueCents: number;
  };
  trials: {
    activeTrials: number;
    paidAccounts: number;
    totalAccounts: number;
    conversionRate: number;
  };
  economics: {
    costPerCallCents: number;
    revenuePerCallCents: number;
    marginPerCallCents: number;
  };
  trend: Array<{
    day: string;
    callMinutes: number;
    callCount: number;
    totalCostCents: number;
  }>;
}

type SortField = 'displayName' | 'totalInstalls' | 'activationRate' | 'callsLast30d' | 'uninstallRate' | 'avgSatisfaction' | 'totalCampaigns' | 'upgradeAdoption';
type SortDir = 'asc' | 'desc';

interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
}

interface ValidationResult {
  valid: boolean;
  checks: ValidationCheck[];
}

function formatCents(cents: string | number): string {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    suspended: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  );
}

function PlanBadge({ plan }: { plan: string }) {
  const colors: Record<string, string> = {
    starter: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    pro: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
    enterprise: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[plan] ?? 'bg-gray-100 text-gray-600'}`}>
      {plan}
    </span>
  );
}

function VersionStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    published: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    deprecated: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  );
}

function TenantDetailPanel({ tenantId }: { tenantId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['platform-tenant-detail', tenantId],
    queryFn: () => api.get<{ tenant: TenantDetail }>(`/platform/tenants/${tenantId}`),
  });

  if (isLoading) return <div className="px-4 py-3 text-sm text-muted">Loading details...</div>;
  if (!data) return null;

  const t = data.tenant;
  return (
    <div className="px-6 py-4 bg-surface-secondary/50 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
      <div>
        <span className="text-muted">Agents</span>
        <div className="font-medium">{t.agent_count}</div>
      </div>
      <div>
        <span className="text-muted">Phone Numbers</span>
        <div className="font-medium">{t.phone_number_count}</div>
      </div>
      <div>
        <span className="text-muted">Total Calls</span>
        <div className="font-medium">{t.total_calls}</div>
      </div>
      <div>
        <span className="text-muted">Total Spend</span>
        <div className="font-medium">{formatCents(t.total_cost_cents)}</div>
      </div>
    </div>
  );
}

function CreateVersionForm({ templateId, onClose }: { templateId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [version, setVersion] = useState('');
  const [changelog, setChangelog] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');

  const createMutation = useMutation({
    mutationFn: () => api.post(`/platform/templates/${templateId}/versions`, {
      version,
      changelog,
      releaseNotes,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-template-detail', templateId] });
      onClose();
    },
  });

  return (
    <div className="border border-border rounded-lg p-4 bg-surface-secondary/50 space-y-3">
      <h4 className="font-medium text-sm">Create New Version</h4>
      <div>
        <label className="text-xs text-muted block mb-1">Version (semver)</label>
        <input
          type="text"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          placeholder="e.g. 1.2.0"
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
      </div>
      <div>
        <label className="text-xs text-muted block mb-1">Changelog</label>
        <textarea
          value={changelog}
          onChange={(e) => setChangelog(e.target.value)}
          placeholder="What changed in this version..."
          rows={3}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
        />
      </div>
      <div>
        <label className="text-xs text-muted block mb-1">Release Notes (optional)</label>
        <textarea
          value={releaseNotes}
          onChange={(e) => setReleaseNotes(e.target.value)}
          placeholder="Additional notes for this release..."
          rows={2}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
        />
      </div>
      {createMutation.isError && (
        <div className="text-sm text-red-600 dark:text-red-400">
          {(createMutation.error as Error).message}
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => createMutation.mutate()}
          disabled={!version || !changelog || createMutation.isPending}
          className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50"
        >
          {createMutation.isPending ? 'Creating...' : 'Create Draft'}
        </button>
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-muted hover:text-foreground rounded-lg hover:bg-surface-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function TemplateVersionManager({ templateId }: { templateId: string }) {
  const queryClient = useQueryClient();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [validationResults, setValidationResults] = useState<Record<string, ValidationResult>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['platform-template-detail', templateId],
    queryFn: () => api.get<TemplateDetail>(`/marketplace/templates/${templateId}`),
  });

  const validateMutation = useMutation({
    mutationFn: (versionId: string) =>
      api.post<{ validation: ValidationResult }>(`/platform/templates/${templateId}/versions/${versionId}/validate`),
    onSuccess: (result, versionId) => {
      setValidationResults((prev) => ({ ...prev, [versionId]: result.validation }));
    },
  });

  const publishMutation = useMutation({
    mutationFn: (versionId: string) =>
      api.post(`/platform/templates/${templateId}/versions/${versionId}/publish`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-template-detail', templateId] });
      queryClient.invalidateQueries({ queryKey: ['platform-templates-list'] });
    },
  });

  const deprecateMutation = useMutation({
    mutationFn: (versionId: string) =>
      api.patch(`/platform/templates/${templateId}/versions/${versionId}/deprecate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-template-detail', templateId] });
    },
  });

  if (isLoading) return <div className="px-4 py-3 text-sm text-muted">Loading template...</div>;
  if (!data) return null;

  const versions = data.versions ?? [];

  return (
    <div className="px-6 py-4 bg-surface-secondary/50 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">{data.displayName}</h3>
          <p className="text-xs text-muted">Current: v{data.currentVersion} | {versions.length} version(s)</p>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" /> New Version
        </button>
      </div>

      {showCreateForm && (
        <CreateVersionForm templateId={templateId} onClose={() => setShowCreateForm(false)} />
      )}

      {publishMutation.isError && (
        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded">
          {(publishMutation.error as Error).message}
        </div>
      )}

      {publishMutation.isSuccess && (
        <div className="text-sm text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 p-2 rounded flex items-center gap-2">
          <CheckCircle className="h-4 w-4" /> Version published successfully
        </div>
      )}

      <div className="space-y-2">
        {versions.map((v) => (
          <div key={v.id} className="border border-border rounded-lg p-3 bg-surface">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium">v{v.version}</span>
                <VersionStatusBadge status={v.status} />
                {v.isLatest && (
                  <span className="text-xs px-1.5 py-0.5 bg-primary/10 text-primary rounded">latest</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {v.status === 'draft' && (
                  <>
                    <button
                      onClick={() => validateMutation.mutate(v.id)}
                      disabled={validateMutation.isPending}
                      className="p-1.5 rounded hover:bg-surface-secondary text-muted hover:text-foreground"
                      title="Validate"
                    >
                      <AlertCircle className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Publish version ${v.version}?`)) {
                          publishMutation.mutate(v.id);
                        }
                      }}
                      disabled={publishMutation.isPending}
                      className="p-1.5 rounded hover:bg-green-100 dark:hover:bg-green-900/30 text-muted hover:text-green-600"
                      title="Publish"
                    >
                      <Play className="h-4 w-4" />
                    </button>
                  </>
                )}
                {v.status === 'published' && !v.isLatest && (
                  <button
                    onClick={() => {
                      if (confirm(`Deprecate version ${v.version}?`)) {
                        deprecateMutation.mutate(v.id);
                      }
                    }}
                    disabled={deprecateMutation.isPending}
                    className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-muted hover:text-red-600"
                    title="Deprecate"
                  >
                    <Archive className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            {v.changelog && (
              <p className="text-xs text-muted mt-1">{v.changelog}</p>
            )}
            <p className="text-xs text-muted mt-1">
              {v.status === 'draft' ? 'Not yet published' : `Published: ${new Date(v.publishedAt).toLocaleDateString()}`}
            </p>

            {validationResults[v.id] && (
              <div className="mt-2 border-t border-border pt-2 space-y-1">
                <div className="flex items-center gap-1 text-xs font-medium">
                  {validationResults[v.id].valid ? (
                    <><CheckCircle className="h-3.5 w-3.5 text-green-500" /> Validation passed</>
                  ) : (
                    <><AlertCircle className="h-3.5 w-3.5 text-red-500" /> Validation failed</>
                  )}
                </div>
                {validationResults[v.id].checks.map((check, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className={check.passed ? 'text-green-500' : 'text-red-500'}>
                      {check.passed ? '\u2713' : '\u2717'}
                    </span>
                    <span className="text-muted">{check.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {versions.length === 0 && (
          <p className="text-sm text-muted text-center py-4">No versions created yet</p>
        )}
      </div>
    </div>
  );
}

export default function PlatformAdmin() {
  const queryClient = useQueryClient();
  const [expandedTenant, setExpandedTenant] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'tenants' | 'templates' | 'analytics' | 'cost-monitoring'>('tenants');
  const [expandedTemplate, setExpandedTemplate] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>('totalInstalls');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ['platform-stats'],
    queryFn: () => api.get<{ stats: PlatformStats }>('/platform/stats'),
    refetchInterval: 60_000,
  });

  const { data: tenantsData, isLoading: tenantsLoading } = useQuery({
    queryKey: ['platform-tenants'],
    queryFn: () => api.get<{ tenants: Tenant[] }>('/platform/tenants'),
    refetchInterval: 60_000,
  });

  const { data: templatesData, isLoading: templatesLoading } = useQuery({
    queryKey: ['platform-templates-list'],
    queryFn: () => api.get<{ templates: TemplateListItem[] }>('/marketplace/templates?status=active&limit=100'),
    enabled: activeTab === 'templates',
  });

  const { data: analyticsData, isLoading: analyticsLoading } = useQuery({
    queryKey: ['platform-template-analytics'],
    queryFn: () => api.get<{ templates: TemplateAnalytics[] }>('/platform/template-analytics'),
    enabled: activeTab === 'analytics',
    refetchInterval: 60_000,
  });

  const { data: costData, isLoading: costLoading } = useQuery({
    queryKey: ['platform-cost-monitoring'],
    queryFn: () => api.get<{ monitoring: CostMonitoringData }>('/platform/cost-monitoring'),
    enabled: activeTab === 'cost-monitoring',
    refetchInterval: 30_000,
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/platform/tenants/${id}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-tenants'] });
      queryClient.invalidateQueries({ queryKey: ['platform-stats'] });
    },
  });

  const stats = statsData?.stats;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Building2 className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">Platform Administration</h1>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Building2}
          label="Active Tenants"
          value={statsLoading ? '...' : `${stats?.active_tenants ?? 0} / ${stats?.total_tenants ?? 0}`}
        />
        <StatCard
          icon={Users}
          label="Total Users"
          value={statsLoading ? '...' : String(stats?.total_users ?? 0)}
        />
        <StatCard
          icon={PhoneCall}
          label="Calls (30d)"
          value={statsLoading ? '...' : `${stats?.calls_last_30d ?? 0}`}
          sub={statsLoading ? '' : `${stats?.calls_last_24h ?? 0} in last 24h`}
        />
        <StatCard
          icon={DollarSign}
          label="Revenue (30d)"
          value={statsLoading ? '...' : formatCents(stats?.revenue_last_30d_cents ?? '0')}
          sub={statsLoading ? '' : `${formatCents(stats?.total_revenue_cents ?? '0')} total`}
        />
      </div>

      <div className="flex gap-2 border-b border-border">
        <button
          onClick={() => setActiveTab('tenants')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'tenants'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted hover:text-foreground'
          }`}
        >
          <span className="flex items-center gap-2"><Building2 className="h-4 w-4" /> Tenants</span>
        </button>
        <button
          onClick={() => setActiveTab('templates')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'templates'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted hover:text-foreground'
          }`}
        >
          <span className="flex items-center gap-2"><Package className="h-4 w-4" /> Template Versions</span>
        </button>
        <button
          onClick={() => setActiveTab('analytics')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'analytics'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted hover:text-foreground'
          }`}
        >
          <span className="flex items-center gap-2"><BarChart3 className="h-4 w-4" /> Template Analytics</span>
        </button>
        <button
          onClick={() => setActiveTab('cost-monitoring')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'cost-monitoring'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted hover:text-foreground'
          }`}
        >
          <span className="flex items-center gap-2"><DollarSign className="h-4 w-4" /> Cost Monitoring</span>
        </button>
      </div>

      {activeTab === 'tenants' && (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="font-semibold">All Tenants</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="w-8 px-2"></th>
                  <th className="text-left px-4 py-3 font-medium text-muted">Tenant</th>
                  <th className="text-left px-4 py-3 font-medium text-muted">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-muted">Plan</th>
                  <th className="text-left px-4 py-3 font-medium text-muted">Users</th>
                  <th className="text-left px-4 py-3 font-medium text-muted">Calls (30d)</th>
                  <th className="text-left px-4 py-3 font-medium text-muted">Last Activity</th>
                  <th className="text-left px-4 py-3 font-medium text-muted">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tenantsLoading ? (
                  <tr><td colSpan={8} className="text-center py-12 text-muted">Loading...</td></tr>
                ) : !tenantsData?.tenants.length ? (
                  <tr><td colSpan={8} className="text-center py-12 text-muted">No tenants found</td></tr>
                ) : (
                  tenantsData.tenants.map((tenant) => (
                    <>
                      <tr key={tenant.id} className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                        <td className="px-2">
                          <button
                            onClick={() => setExpandedTenant(expandedTenant === tenant.id ? null : tenant.id)}
                            className="p-1 rounded hover:bg-surface-secondary"
                          >
                            {expandedTenant === tenant.id
                              ? <ChevronDown className="h-4 w-4 text-muted" />
                              : <ChevronRight className="h-4 w-4 text-muted" />}
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium">{tenant.name}</div>
                          <div className="text-xs text-muted font-mono">{tenant.slug}</div>
                        </td>
                        <td className="px-4 py-3"><StatusBadge status={tenant.status} /></td>
                        <td className="px-4 py-3"><PlanBadge plan={tenant.plan} /></td>
                        <td className="px-4 py-3 text-muted">{tenant.user_count}</td>
                        <td className="px-4 py-3 text-muted">{tenant.calls_last_30d}</td>
                        <td className="px-4 py-3 text-muted whitespace-nowrap">
                          {tenant.last_call_at ? new Date(tenant.last_call_at).toLocaleDateString() : 'Never'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => setExpandedTenant(expandedTenant === tenant.id ? null : tenant.id)}
                              className="p-1.5 rounded hover:bg-surface-secondary text-muted hover:text-foreground"
                              title="View details"
                            >
                              <Eye className="h-4 w-4" />
                            </button>
                            {tenant.status === 'active' ? (
                              <button
                                onClick={() => {
                                  if (confirm(`Suspend tenant "${tenant.name}"?`)) {
                                    statusMutation.mutate({ id: tenant.id, status: 'suspended' });
                                  }
                                }}
                                className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-muted hover:text-red-600"
                                title="Suspend tenant"
                              >
                                <Ban className="h-4 w-4" />
                              </button>
                            ) : tenant.status === 'suspended' ? (
                              <button
                                onClick={() => {
                                  if (confirm(`Reactivate tenant "${tenant.name}"?`)) {
                                    statusMutation.mutate({ id: tenant.id, status: 'active' });
                                  }
                                }}
                                className="p-1.5 rounded hover:bg-green-100 dark:hover:bg-green-900/30 text-muted hover:text-green-600"
                                title="Reactivate tenant"
                              >
                                <CheckCircle className="h-4 w-4" />
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                      {expandedTenant === tenant.id && (
                        <tr key={`${tenant.id}-detail`} className="border-b border-border">
                          <td colSpan={8} className="p-0">
                            <TenantDetailPanel tenantId={tenant.id} />
                          </td>
                        </tr>
                      )}
                    </>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'templates' && (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="font-semibold">Template Version Management</h2>
            <p className="text-xs text-muted mt-0.5">Create, validate, publish, and deprecate template versions</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="w-8 px-2"></th>
                  <th className="text-left px-4 py-3 font-medium text-muted">Template</th>
                  <th className="text-left px-4 py-3 font-medium text-muted">Slug</th>
                  <th className="text-left px-4 py-3 font-medium text-muted">Current Version</th>
                  <th className="text-left px-4 py-3 font-medium text-muted">Status</th>
                </tr>
              </thead>
              <tbody>
                {templatesLoading ? (
                  <tr><td colSpan={5} className="text-center py-12 text-muted">Loading templates...</td></tr>
                ) : !templatesData?.templates.length ? (
                  <tr><td colSpan={5} className="text-center py-12 text-muted">No templates found</td></tr>
                ) : (
                  templatesData.templates.map((t) => (
                    <>
                      <tr key={t.id} className="border-b border-border last:border-0 hover:bg-surface-secondary/50 cursor-pointer"
                          onClick={() => setExpandedTemplate(expandedTemplate === t.id ? null : t.id)}>
                        <td className="px-2">
                          <button className="p-1 rounded hover:bg-surface-secondary">
                            {expandedTemplate === t.id
                              ? <ChevronDown className="h-4 w-4 text-muted" />
                              : <ChevronRight className="h-4 w-4 text-muted" />}
                          </button>
                        </td>
                        <td className="px-4 py-3 font-medium">{t.displayName}</td>
                        <td className="px-4 py-3 text-muted font-mono text-xs">{t.slug}</td>
                        <td className="px-4 py-3 font-mono text-sm">v{t.currentVersion}</td>
                        <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
                      </tr>
                      {expandedTemplate === t.id && (
                        <tr key={`${t.id}-versions`} className="border-b border-border">
                          <td colSpan={5} className="p-0">
                            <TemplateVersionManager templateId={t.id} />
                          </td>
                        </tr>
                      )}
                    </>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'analytics' && (
        <TemplateAnalyticsTab
          data={analyticsData}
          loading={analyticsLoading}
          sortField={sortField}
          sortDir={sortDir}
          onSort={(field) => {
            if (field === sortField) {
              setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
            } else {
              setSortField(field);
              setSortDir('desc');
            }
          }}
        />
      )}

      {activeTab === 'cost-monitoring' && (
        <CostMonitoringTab data={costData} loading={costLoading} />
      )}
    </div>
  );
}

function CostMonitoringTab({ data, loading }: { data: { monitoring: CostMonitoringData } | undefined; loading: boolean }) {
  if (loading) return <div className="text-center py-12 text-muted">Loading cost data...</div>;
  if (!data) return <div className="text-center py-12 text-muted">No data available</div>;

  const m = data.monitoring;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="h-4 w-4 text-muted" />
            <span className="text-sm text-muted">Daily Call Minutes</span>
          </div>
          <div className="text-2xl font-bold">{m.daily.callMinutes.toLocaleString()}</div>
          <div className="text-xs text-muted mt-1">{m.daily.callCount} calls today</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="h-4 w-4 text-muted" />
            <span className="text-sm text-muted">Daily AI Cost</span>
          </div>
          <div className="text-2xl font-bold">{formatCents(String(m.daily.aiCostCents))}</div>
          <div className="text-xs text-muted mt-1">{formatCents(String(m.daily.totalCostCents))} total cost</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <PhoneCall className="h-4 w-4 text-muted" />
            <span className="text-sm text-muted">Daily Twilio Spend</span>
          </div>
          <div className="text-2xl font-bold">{formatCents(String(m.daily.twilioCostCents))}</div>
          <div className="text-xs text-muted mt-1">SMS: {formatCents(String(m.daily.smsCostCents))}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Users className="h-4 w-4 text-muted" />
            <span className="text-sm text-muted">Active Trials</span>
          </div>
          <div className="text-2xl font-bold">{m.trials.activeTrials}</div>
          <div className="text-xs text-muted mt-1">{m.trials.paidAccounts} paid accounts</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-border rounded-xl p-6">
          <h3 className="font-semibold mb-4">Trial-to-Paid Conversion</h3>
          <div className="flex items-center gap-4">
            <div className="text-4xl font-bold text-primary">{m.trials.conversionRate}%</div>
            <div className="text-sm text-muted">
              <div>{m.trials.paidAccounts} paid / {m.trials.totalAccounts} total</div>
              <div>{m.trials.activeTrials} active trials</div>
            </div>
          </div>
        </div>

        <div className="bg-surface border border-border rounded-xl p-6">
          <h3 className="font-semibold mb-4">Unit Economics</h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-xs text-muted mb-1">Cost/Call</div>
              <div className="text-lg font-bold">{formatCents(String(m.economics.costPerCallCents))}</div>
            </div>
            <div>
              <div className="text-xs text-muted mb-1">Revenue/Call</div>
              <div className="text-lg font-bold text-green-600 dark:text-green-400">{formatCents(String(m.economics.revenuePerCallCents))}</div>
            </div>
            <div>
              <div className="text-xs text-muted mb-1">Margin/Call</div>
              <div className={`text-lg font-bold ${m.economics.marginPerCallCents >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {formatCents(String(m.economics.marginPerCallCents))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6">
        <h3 className="font-semibold mb-4">Monthly Summary</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <div>
            <div className="text-xs text-muted mb-1">Call Minutes</div>
            <div className="text-lg font-bold">{m.monthly.callMinutes.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs text-muted mb-1">Total Calls</div>
            <div className="text-lg font-bold">{m.monthly.callCount.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs text-muted mb-1">AI Cost</div>
            <div className="text-lg font-bold">{formatCents(String(m.monthly.aiCostCents))}</div>
          </div>
          <div>
            <div className="text-xs text-muted mb-1">Twilio Cost</div>
            <div className="text-lg font-bold">{formatCents(String(m.monthly.twilioCostCents))}</div>
          </div>
          <div>
            <div className="text-xs text-muted mb-1">Total Cost</div>
            <div className="text-lg font-bold">{formatCents(String(m.monthly.totalCostCents))}</div>
          </div>
          <div>
            <div className="text-xs text-muted mb-1">Revenue</div>
            <div className="text-lg font-bold text-green-600 dark:text-green-400">{formatCents(String(m.monthly.revenueCents))}</div>
          </div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6">
        <h3 className="font-semibold mb-4">Daily Usage (Tool & API)</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-muted mb-1">Tool Executions Today</div>
            <div className="text-lg font-bold">{m.daily.toolExecutions.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs text-muted mb-1">API Requests Today</div>
            <div className="text-lg font-bold">{m.daily.apiRequests.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {m.trend.length > 0 && (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="font-semibold">30-Day Trend</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-4 py-3 font-medium text-muted">Date</th>
                  <th className="text-right px-4 py-3 font-medium text-muted">Calls</th>
                  <th className="text-right px-4 py-3 font-medium text-muted">Minutes</th>
                  <th className="text-right px-4 py-3 font-medium text-muted">Cost</th>
                </tr>
              </thead>
              <tbody>
                {m.trend.map((day) => (
                  <tr key={day.day} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-muted">{new Date(day.day).toLocaleDateString()}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{day.callCount}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{day.callMinutes}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCents(String(day.totalCostCents))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function SortableHeader({ label, field, currentField, currentDir, onSort }: {
  label: string;
  field: SortField;
  currentField: SortField;
  currentDir: SortDir;
  onSort: (f: SortField) => void;
}) {
  const active = field === currentField;
  return (
    <th
      className="text-right px-4 py-3 font-medium text-muted cursor-pointer select-none hover:text-foreground transition-colors"
      onClick={() => onSort(field)}
    >
      <span className="inline-flex items-center gap-1 justify-end">
        {label}
        {active ? (
          <span className="text-primary text-[10px]">{currentDir === 'asc' ? '\u25B2' : '\u25BC'}</span>
        ) : (
          <span className="text-muted/40 text-[10px]">{'\u25BC'}</span>
        )}
      </span>
    </th>
  );
}

function BarChart({ data, labelKey, valueKey, secondaryKey, barColor, secondaryColor }: {
  data: TemplateAnalytics[];
  labelKey: keyof TemplateAnalytics;
  valueKey: keyof TemplateAnalytics;
  secondaryKey?: keyof TemplateAnalytics;
  barColor: string;
  secondaryColor?: string;
}) {
  const maxVal = Math.max(...data.map(d => Number(d[valueKey]) || 0), 1);
  return (
    <div className="space-y-2">
      {data.map((d) => {
        const val = Number(d[valueKey]) || 0;
        const secVal = secondaryKey ? (Number(d[secondaryKey]) || 0) : 0;
        const pct = (val / maxVal) * 100;
        const secPct = secondaryKey ? (secVal / maxVal) * 100 : 0;
        return (
          <div key={d.id} className="flex items-center gap-3">
            <div className="w-32 truncate text-xs text-muted text-right" title={String(d[labelKey])}>
              {String(d[labelKey])}
            </div>
            <div className="flex-1 flex items-center gap-1">
              <div className="flex-1 h-5 bg-surface-hover rounded overflow-hidden relative">
                {secondaryKey && (
                  <div
                    className={`absolute top-0 left-0 h-full rounded ${secondaryColor ?? 'bg-primary/30'}`}
                    style={{ width: `${secPct}%` }}
                  />
                )}
                <div
                  className={`absolute top-0 left-0 h-full rounded ${barColor}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs tabular-nums text-muted w-12 text-right">{val.toLocaleString()}</span>
              {secondaryKey && (
                <span className="text-xs tabular-nums text-muted/60 w-12 text-right">{secVal.toLocaleString()}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TemplateAnalyticsTab({ data, loading, sortField, sortDir, onSort }: {
  data: { templates: TemplateAnalytics[] } | undefined;
  loading: boolean;
  sortField: SortField;
  sortDir: SortDir;
  onSort: (f: SortField) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!data?.templates?.length) {
    return (
      <div className="bg-surface border border-border rounded-xl p-12 text-center">
        <BarChart3 className="h-10 w-10 text-muted mx-auto mb-3" />
        <p className="text-muted">No template analytics data available yet.</p>
        <p className="text-xs text-muted mt-1">Analytics will populate as tenants install and use templates.</p>
      </div>
    );
  }

  const templates = data.templates;
  const sorted = [...templates].sort((a, b) => {
    const aVal = a[sortField];
    const bVal = b[sortField];
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return sortDir === 'asc' ? (Number(aVal) - Number(bVal)) : (Number(bVal) - Number(aVal));
  });

  const chartData = [...templates].sort((a, b) => b.totalInstalls - a.totalInstalls).slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={DownloadIcon}
          label="Total Installs"
          value={String(templates.reduce((s, t) => s + t.totalInstalls, 0))}
          sub={`${templates.reduce((s, t) => s + t.activeInstalls, 0)} active`}
        />
        <StatCard
          icon={Activity}
          label="Avg Activation Rate"
          value={`${templates.length > 0 ? Math.round(templates.reduce((s, t) => s + t.activationRate, 0) / templates.length) : 0}%`}
        />
        <StatCard
          icon={PhoneCall}
          label="Template Calls (30d)"
          value={String(templates.reduce((s, t) => s + t.callsLast30d, 0))}
          sub={`${templates.reduce((s, t) => s + t.totalCalls, 0)} total`}
        />
        <StatCard
          icon={TrendingUp}
          label="Avg Satisfaction"
          value={(() => {
            const withScores = templates.filter(t => t.avgSatisfaction > 0);
            return withScores.length > 0
              ? (withScores.reduce((s, t) => s + t.avgSatisfaction, 0) / withScores.length).toFixed(1)
              : '\u2014';
          })()}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="font-semibold text-sm mb-1">Installs by Template</h3>
          <p className="text-xs text-muted mb-4">Total installs (dark) vs active installs (light)</p>
          <BarChart data={chartData} labelKey="displayName" valueKey="activeInstalls" secondaryKey="totalInstalls" barColor="bg-primary" secondaryColor="bg-primary/25" />
        </div>
        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="font-semibold text-sm mb-1">Call Volume by Template (30d)</h3>
          <p className="text-xs text-muted mb-4">Calls generated through template-installed agents</p>
          <BarChart data={[...templates].sort((a, b) => b.callsLast30d - a.callsLast30d).slice(0, 10)} labelKey="displayName" valueKey="callsLast30d" barColor="bg-green-500" />
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="font-semibold">Template Performance</h2>
          <p className="text-xs text-muted mt-0.5">Click column headers to sort. Includes call and campaign metrics.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-3 font-medium text-muted cursor-pointer select-none hover:text-foreground" onClick={() => onSort('displayName')}>
                  <span className="inline-flex items-center gap-1">
                    Template
                    {sortField === 'displayName' ? <span className="text-primary text-[10px]">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span> : <span className="text-muted/40 text-[10px]">{'\u25BC'}</span>}
                  </span>
                </th>
                <SortableHeader label="Installs" field="totalInstalls" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <th className="text-right px-4 py-3 font-medium text-muted">Active</th>
                <SortableHeader label="Activation" field="activationRate" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <SortableHeader label="Upgrade Adoption" field="upgradeAdoption" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <SortableHeader label="Uninstalls" field="uninstallRate" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <SortableHeader label="Calls (30d)" field="callsLast30d" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <SortableHeader label="Campaigns" field="totalCampaigns" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <th className="text-right px-4 py-3 font-medium text-muted">Avg Duration</th>
                <SortableHeader label="CSAT" field="avgSatisfaction" currentField={sortField} currentDir={sortDir} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                  <td className="px-4 py-3">
                    <div className="font-medium">{t.displayName}</div>
                    <div className="text-xs text-muted font-mono">{t.slug} · v{t.currentVersion}</div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.totalInstalls}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.activeInstalls}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`inline-flex items-center gap-1 ${t.activationRate >= 70 ? 'text-green-600 dark:text-green-400' : t.activationRate >= 40 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}`}>
                      {t.activationRate >= 70 ? <TrendingUp className="h-3 w-3" /> : t.activationRate < 40 ? <TrendingDown className="h-3 w-3" /> : null}
                      {t.activationRate}%
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <span className={`inline-flex items-center gap-1 ${t.upgradeAdoption >= 50 ? 'text-green-600 dark:text-green-400' : t.upgradeAdoption >= 20 ? 'text-yellow-600 dark:text-yellow-400' : 'text-muted'}`}>
                      {t.upgradeAdoption}%
                      <span className="text-muted/60">({t.upgradeCount})</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <span className={t.uninstallRate > 30 ? 'text-red-600 dark:text-red-400' : ''}>{t.uninstallCount} ({t.uninstallRate}%)</span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.callsLast30d.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.totalCampaigns > 0 ? `${t.completedCampaigns}/${t.totalCampaigns}` : '\u2014'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.avgCallDuration > 0 ? `${Math.floor(t.avgCallDuration / 60)}m ${t.avgCallDuration % 60}s` : '\u2014'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.avgSatisfaction > 0 ? t.avgSatisfaction.toFixed(1) : '\u2014'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {templates.map((t) => (
          <div key={t.id} className="bg-surface border border-border rounded-xl p-5">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="font-semibold text-sm">{t.displayName}</h3>
                <p className="text-xs text-muted">v{t.currentVersion}</p>
              </div>
              <StatusBadge status={t.status} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <MetricItem label="Conversion Rate" value={`${t.activationRate}%`} trend={t.activationRate >= 50 ? 'up' : t.activationRate >= 20 ? 'neutral' : 'down'} />
              <MetricItem label="Avg Call Duration" value={t.avgCallDuration > 0 ? `${Math.floor(t.avgCallDuration / 60)}m ${t.avgCallDuration % 60}s` : '\u2014'} />
              <MetricItem label="CSAT Score" value={t.avgSatisfaction > 0 ? t.avgSatisfaction.toFixed(1) : '\u2014'} trend={t.avgSatisfaction >= 4 ? 'up' : t.avgSatisfaction >= 3 ? 'neutral' : t.avgSatisfaction > 0 ? 'down' : undefined} />
              <MetricItem label="Calls (30d)" value={t.callsLast30d.toLocaleString()} />
              <MetricItem label="Upgrade Adoption" value={`${t.upgradeAdoption}%`} trend={t.upgradeAdoption >= 50 ? 'up' : t.upgradeAdoption >= 20 ? 'neutral' : 'down'} />
              <MetricItem label="Uninstall Rate" value={`${t.uninstallRate}%`} trend={t.uninstallRate <= 10 ? 'up' : t.uninstallRate <= 30 ? 'neutral' : 'down'} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub }: { icon: typeof Building2; label: string; value: string; sub?: string }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-muted" />
        <span className="text-sm text-muted">{label}</span>
      </div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}

function MetricItem({ label, value, trend }: { label: string; value: string; trend?: 'up' | 'down' | 'neutral' }) {
  return (
    <div>
      <p className="text-xs text-muted mb-0.5">{label}</p>
      <div className="flex items-center gap-1">
        <span className="text-sm font-semibold">{value}</span>
        {trend === 'up' && <TrendingUp className="h-3 w-3 text-green-500" />}
        {trend === 'down' && <TrendingDown className="h-3 w-3 text-red-500" />}
      </div>
    </div>
  );
}
