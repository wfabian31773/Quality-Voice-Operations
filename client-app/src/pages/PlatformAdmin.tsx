import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  Building2, Users, PhoneCall, DollarSign, ChevronDown, ChevronRight,
  Ban, CheckCircle, Eye, Package, Plus, Play, Archive, AlertCircle,
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
  const [activeTab, setActiveTab] = useState<'tenants' | 'templates'>('tenants');
  const [expandedTemplate, setExpandedTemplate] = useState<string | null>(null);

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
