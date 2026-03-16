import { useState, useEffect } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  Search, Store, ArrowLeft, Download, CheckCircle, Phone, MessageSquare,
  Globe, Tag, Clock, ArrowUpCircle, Settings2, X, ChevronRight, Shield,
  AlertCircle,
} from 'lucide-react';

interface TemplateCategory {
  name: string;
  displayName: string;
  description?: string;
  icon?: string;
}

interface MarketplaceTemplate {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  shortDescription: string;
  iconUrl: string | null;
  status: string;
  currentVersion: string;
  minPlan: string;
  agentType: string;
  defaultVoice: string;
  defaultLanguage: string;
  supportedChannels: string[];
  requiredTools: string[];
  optionalTools: string[];
  tags: string[];
  sortOrder: number;
  installCount: number;
  categories: TemplateCategory[];
  createdAt: string;
  updatedAt: string;
}

interface TemplateDetail extends MarketplaceTemplate {
  configSchema: Record<string, unknown>;
  metadata: Record<string, unknown>;
  versions: TemplateVersion[];
  changelogs: TemplateChangelog[];
  entitlements: TemplateEntitlement[];
}

interface TemplateVersion {
  id: string;
  version: string;
  changelog: string;
  packageRef: string;
  releaseNotes: string;
  isLatest: boolean;
  publishedAt: string;
}

interface TemplateChangelog {
  id: string;
  version: string;
  changeType: string;
  summary: string;
  details: string | null;
  createdAt: string;
}

interface TemplateEntitlement {
  planTier: string;
  enabled: boolean;
}

interface CategoryInfo {
  id: string;
  name: string;
  displayName: string;
  description: string;
  icon: string | null;
  sortOrder: number;
  templateCount: number;
}

interface Installation {
  id: string;
  tenant_id: string;
  template_id: string;
  installed_version: string;
  status: string;
  config: Record<string, unknown>;
  agent_id: string | null;
  installed_at: string;
  updated_at: string;
  template_name: string;
  latest_version: string;
  template_slug: string;
  agent_name: string | null;
  agent_status: string | null;
  agent_type: string | null;
  installed_by: string | null;
}

interface CompatibilityResult {
  compatible: boolean;
  errors: string[];
  warnings: string[];
  plan: string;
  agentCount: number;
  maxAgents: number;
}

const PLAN_COLORS: Record<string, string> = {
  starter: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  pro: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  enterprise: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
};

const CHANNEL_ICONS: Record<string, typeof Phone> = {
  voice: Phone,
  sms: MessageSquare,
  web: Globe,
};

function PlanBadge({ plan }: { plan: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${PLAN_COLORS[plan] ?? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}>
      {plan}
    </span>
  );
}

function ChannelBadges({ channels }: { channels: string[] }) {
  return (
    <div className="flex items-center gap-1.5">
      {channels.map((ch) => {
        const Icon = CHANNEL_ICONS[ch] ?? Globe;
        return (
          <span key={ch} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-hover text-text-secondary text-xs">
            <Icon className="h-3 w-3" />
            {ch}
          </span>
        );
      })}
    </div>
  );
}

interface PhoneNumber {
  id: string;
  phone_number: string;
  friendly_name: string | null;
  agent_id: string | null;
}

function InstallModal({
  template,
  onClose,
  onInstalled,
}: {
  template: MarketplaceTemplate | TemplateDetail;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const [step, setStep] = useState<'setup' | 'confirm'>('setup');
  const [name, setName] = useState(template.displayName);
  const [welcomeGreeting, setWelcomeGreeting] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');

  const { data: compatibility, isLoading: checkingCompat } = useQuery({
    queryKey: ['marketplace-compatibility', template.id],
    queryFn: () => api.get<CompatibilityResult>(`/marketplace/templates/${template.id}/compatibility`),
  });

  const { data: phoneData } = useQuery({
    queryKey: ['phone-numbers-list'],
    queryFn: () => api.get<{ phoneNumbers: PhoneNumber[] }>('/phone-numbers?limit=100'),
  });
  const phoneNumbers = phoneData?.phoneNumbers ?? [];
  const selectedPhone = phoneNumbers.find((p) => p.id === phoneNumberId);

  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ installation: { id: string } }>(`/marketplace/templates/${template.id}/install`, {
        name,
        welcomeGreeting: welcomeGreeting || undefined,
        metadata: phoneNumberId ? { assignedPhoneNumberId: phoneNumberId } : undefined,
      }),
    onSuccess: (data) => {
      onInstalled();
      onClose();
      if (data?.installation?.id) {
        navigate(`/marketplace/installations/${data.installation.id}/setup`);
      }
    },
  });

  const isBlocked = compatibility && !compatibility.compatible;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">
            {step === 'confirm' ? 'Confirm Installation' : `Install ${template.displayName}`}
          </h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center gap-3 p-3 bg-surface-hover rounded-lg">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Store className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium text-text-primary">{template.displayName}</p>
              <p className="text-xs text-text-secondary">v{template.currentVersion} &middot; {template.agentType}</p>
            </div>
          </div>

          {checkingCompat && (
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
              Checking plan compatibility...
            </div>
          )}

          {isBlocked && (
            <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
              <div className="flex items-start gap-2">
                <Shield className="h-5 w-5 text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-yellow-800 dark:text-yellow-300">Upgrade Required</p>
                  {compatibility.errors.map((err, i) => (
                    <p key={i} className="text-xs text-yellow-700 dark:text-yellow-400 mt-1">{err}</p>
                  ))}
                  <a
                    href="/billing"
                    className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-primary hover:text-primary-hover transition"
                  >
                    View Plans <ChevronRight className="h-3 w-3" />
                  </a>
                </div>
              </div>
            </div>
          )}

          {compatibility?.warnings && compatibility.warnings.length > 0 && (
            <div className="p-3 bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-800/50 rounded-lg">
              {compatibility.warnings.map((w, i) => (
                <p key={i} className="text-xs text-yellow-700 dark:text-yellow-400">{w}</p>
              ))}
            </div>
          )}

          {!isBlocked && step === 'setup' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Agent Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  placeholder="My Agent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Assign Phone Number</label>
                <select
                  value={phoneNumberId}
                  onChange={(e) => setPhoneNumberId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <option value="">None (assign later)</option>
                  {phoneNumbers.map((pn) => (
                    <option key={pn.id} value={pn.id}>
                      {pn.friendly_name ? `${pn.friendly_name} (${pn.phone_number})` : pn.phone_number}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Welcome Greeting</label>
                <textarea
                  value={welcomeGreeting}
                  onChange={(e) => setWelcomeGreeting(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
                  placeholder="Hello! How can I help you today?"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary rounded-lg border border-border hover:bg-surface-hover transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => setStep('confirm')}
                  disabled={!name.trim() || checkingCompat}
                  className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition disabled:opacity-50 inline-flex items-center gap-2"
                >
                  Continue <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {!isBlocked && step === 'confirm' && (
            <div className="space-y-4">
              <div className="bg-surface-hover rounded-lg p-4 space-y-2.5">
                <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">Installation Summary</p>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-text-secondary">Template</span>
                  <span className="text-text-primary font-medium">{template.displayName}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-text-secondary">Agent Name</span>
                  <span className="text-text-primary font-medium">{name}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-text-secondary">Phone Number</span>
                  <span className="text-text-primary font-medium">
                    {selectedPhone ? (selectedPhone.friendly_name || selectedPhone.phone_number) : 'None'}
                  </span>
                </div>
                {welcomeGreeting && (
                  <div className="text-sm">
                    <span className="text-text-secondary block mb-1">Greeting</span>
                    <span className="text-text-primary text-xs italic">&ldquo;{welcomeGreeting}&rdquo;</span>
                  </div>
                )}
                <div className="flex items-center justify-between text-sm">
                  <span className="text-text-secondary">Plan</span>
                  <PlanBadge plan={template.minPlan} />
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-text-secondary">Channels</span>
                  <ChannelBadges channels={template.supportedChannels} />
                </div>
              </div>

              {mutation.error && (
                <p className="text-danger text-sm">{(mutation.error as Error).message}</p>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setStep('setup')}
                  className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary rounded-lg border border-border hover:bg-surface-hover transition"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => mutation.mutate()}
                  disabled={mutation.isPending}
                  className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition disabled:opacity-50 inline-flex items-center gap-2"
                >
                  <Download className="h-4 w-4" />
                  {mutation.isPending ? 'Installing...' : 'Confirm & Install'}
                </button>
              </div>
            </div>
          )}

          {isBlocked && (
            <div className="flex justify-end pt-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary rounded-lg border border-border hover:bg-surface-hover transition"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  installed,
  onClick,
}: {
  template: MarketplaceTemplate;
  installed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow text-left w-full group"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Store className="h-5 w-5 text-primary" />
        </div>
        <div className="flex items-center gap-2">
          <PlanBadge plan={template.minPlan} />
          {installed && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
              <CheckCircle className="h-3 w-3" /> Installed
            </span>
          )}
        </div>
      </div>

      <h3 className="font-semibold text-text-primary mb-1 group-hover:text-primary transition-colors">
        {template.displayName}
      </h3>
      <p className="text-xs text-text-secondary line-clamp-2 mb-3">
        {template.shortDescription || template.description}
      </p>

      <div className="flex items-center justify-between">
        <ChannelBadges channels={template.supportedChannels} />
        <div className="flex items-center gap-1 text-text-muted text-xs">
          <Download className="h-3 w-3" />
          {template.installCount}
        </div>
      </div>

      {template.categories.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-3">
          {template.categories.map((cat) => (
            <span key={cat.name} className="px-1.5 py-0.5 rounded bg-surface-hover text-text-muted text-xs">
              {cat.displayName}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

function TemplateDetailView({
  templateId,
  onBack,
  installedTemplateIds,
}: {
  templateId: string;
  onBack: () => void;
  installedTemplateIds: Set<string>;
}) {
  const queryClient = useQueryClient();
  const [showInstall, setShowInstall] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['marketplace-template', templateId],
    queryFn: () => api.get<TemplateDetail>(`/marketplace/templates/${templateId}`),
  });

  const template = data;
  const isInstalled = template ? installedTemplateIds.has(template.id) : false;

  const { data: compatibility } = useQuery({
    queryKey: ['marketplace-compatibility', templateId],
    queryFn: () => api.get<CompatibilityResult>(`/marketplace/templates/${templateId}/compatibility`),
    enabled: !!template && !isInstalled,
  });
  const isPlanGated = compatibility ? !compatibility.compatible : false;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!template) {
    return (
      <div className="text-center py-20 text-text-muted">
        <p>Template not found</p>
        <button onClick={onBack} className="text-primary text-sm mt-2">Back to Marketplace</button>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary mb-6 transition"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Marketplace
      </button>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-surface border border-border rounded-xl p-6">
            <div className="flex items-start gap-4 mb-4">
              <div className="h-14 w-14 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <Store className="h-7 w-7 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <h1 className="text-xl font-bold text-text-primary">{template.displayName}</h1>
                <p className="text-sm text-text-secondary mt-0.5">
                  v{template.currentVersion} &middot; {template.agentType} agent
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <PlanBadge plan={template.minPlan} />
                  <ChannelBadges channels={template.supportedChannels} />
                  <span className="text-xs text-text-muted flex items-center gap-1">
                    <Download className="h-3 w-3" /> {template.installCount} installs
                  </span>
                </div>
              </div>
            </div>
            <p className="text-sm text-text-secondary leading-relaxed">{template.description}</p>
          </div>

          {(template.requiredTools.length > 0 || template.optionalTools.length > 0) && (
            <div className="bg-surface border border-border rounded-xl p-6">
              <h2 className="text-base font-semibold text-text-primary mb-3">Tools & Integrations</h2>
              {template.requiredTools.length > 0 && (
                <div className="mb-3">
                  <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">Required</p>
                  <div className="flex flex-wrap gap-2">
                    {template.requiredTools.map((tool) => (
                      <span key={tool} className="px-2.5 py-1 rounded-lg bg-primary/10 text-primary text-xs font-medium">
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {template.optionalTools.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">Optional</p>
                  <div className="flex flex-wrap gap-2">
                    {template.optionalTools.map((tool) => (
                      <span key={tool} className="px-2.5 py-1 rounded-lg bg-surface-hover text-text-secondary text-xs font-medium">
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {(() => {
            const meta = template.metadata as Record<string, string> | undefined;
            if (!meta) return null;
            const workflow = meta.workflowSummary || meta.workflow_summary;
            const escalation = meta.escalationBehavior || meta.escalation_behavior;
            const voiceProfile = meta.voiceProfile || meta.voice_profile;
            if (!workflow && !escalation && !voiceProfile) return null;
            return (
              <div className="bg-surface border border-border rounded-xl p-6 space-y-4">
                {workflow && (
                  <div>
                    <h2 className="text-base font-semibold text-text-primary mb-2">Workflow Summary</h2>
                    <p className="text-sm text-text-secondary leading-relaxed">{workflow}</p>
                  </div>
                )}
                {escalation && (
                  <div>
                    <h2 className="text-base font-semibold text-text-primary mb-2">Escalation Behavior</h2>
                    <p className="text-sm text-text-secondary leading-relaxed">{escalation}</p>
                  </div>
                )}
                {voiceProfile && (
                  <div>
                    <h2 className="text-base font-semibold text-text-primary mb-2">Voice Profile</h2>
                    <p className="text-sm text-text-secondary leading-relaxed">{voiceProfile}</p>
                  </div>
                )}
              </div>
            );
          })()}

          {template.versions && template.versions.length > 0 && (
            <div className="bg-surface border border-border rounded-xl p-6">
              <h2 className="text-base font-semibold text-text-primary mb-3">Version History</h2>
              <div className="space-y-3">
                {template.versions.map((v) => (
                  <div key={v.id} className="flex items-start gap-3 pb-3 border-b border-border last:border-0 last:pb-0">
                    <div className="mt-0.5">
                      <Clock className="h-4 w-4 text-text-muted" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">v{v.version}</span>
                        {v.isLatest && (
                          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                            Latest
                          </span>
                        )}
                      </div>
                      {v.releaseNotes && (
                        <p className="text-xs text-text-secondary mt-1">{v.releaseNotes}</p>
                      )}
                      <p className="text-xs text-text-muted mt-1">
                        {new Date(v.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {template.changelogs && template.changelogs.length > 0 && (
            <div className="bg-surface border border-border rounded-xl p-6">
              <h2 className="text-base font-semibold text-text-primary mb-3">Changelog</h2>
              <div className="space-y-2">
                {template.changelogs.map((cl) => (
                  <div key={cl.id} className="flex items-start gap-2">
                    <span className={`mt-0.5 px-1.5 py-0.5 rounded text-xs font-medium capitalize ${
                      cl.changeType === 'added' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                      cl.changeType === 'fixed' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
                      cl.changeType === 'removed' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                      cl.changeType === 'security' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                      'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                    }`}>
                      {cl.changeType}
                    </span>
                    <div>
                      <p className="text-sm text-text-primary">{cl.summary}</p>
                      <p className="text-xs text-text-muted">v{cl.version}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="bg-surface border border-border rounded-xl p-5">
            {isInstalled ? (
              <div className="text-center">
                <CheckCircle className="h-8 w-8 text-green-500 mx-auto mb-2" />
                <p className="text-sm font-medium text-text-primary">Already Installed</p>
                <p className="text-xs text-text-secondary mt-1">This template is active in your workspace.</p>
              </div>
            ) : isPlanGated ? (
              <div>
                <div className="flex items-start gap-2 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg mb-3">
                  <Shield className="h-5 w-5 text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-yellow-800 dark:text-yellow-300">Upgrade Required</p>
                    {compatibility?.errors.map((err, i) => (
                      <p key={i} className="text-xs text-yellow-700 dark:text-yellow-400 mt-1">{err}</p>
                    ))}
                  </div>
                </div>
                <a
                  href="/billing"
                  className="w-full px-4 py-2.5 bg-yellow-500 hover:bg-yellow-600 text-white text-sm font-medium rounded-lg transition inline-flex items-center justify-center gap-2"
                >
                  <ArrowUpCircle className="h-4 w-4" /> Upgrade Plan
                </a>
              </div>
            ) : (
              <button
                onClick={() => setShowInstall(true)}
                className="w-full px-4 py-2.5 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg transition inline-flex items-center justify-center gap-2"
              >
                <Download className="h-4 w-4" /> Install Template
              </button>
            )}
          </div>

          <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-semibold text-text-primary">Details</h3>
            <div className="space-y-2.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-text-secondary">Plan Required</span>
                <PlanBadge plan={template.minPlan} />
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-text-secondary">Agent Type</span>
                <span className="text-text-primary capitalize">{template.agentType}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-text-secondary">Voice</span>
                <span className="text-text-primary">{template.defaultVoice}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-text-secondary">Language</span>
                <span className="text-text-primary uppercase">{template.defaultLanguage}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-text-secondary">Version</span>
                <span className="text-text-primary">{template.currentVersion}</span>
              </div>
            </div>
          </div>

          {template.categories.length > 0 && (
            <div className="bg-surface border border-border rounded-xl p-5">
              <h3 className="text-sm font-semibold text-text-primary mb-2">Categories</h3>
              <div className="flex flex-wrap gap-1.5">
                {template.categories.map((cat) => (
                  <span key={cat.name} className="px-2 py-1 rounded-lg bg-surface-hover text-text-secondary text-xs">
                    {cat.displayName}
                  </span>
                ))}
              </div>
            </div>
          )}

          {template.tags && template.tags.length > 0 && (
            <div className="bg-surface border border-border rounded-xl p-5">
              <h3 className="text-sm font-semibold text-text-primary mb-2">Tags</h3>
              <div className="flex flex-wrap gap-1.5">
                {template.tags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-surface-hover text-text-secondary text-xs">
                    <Tag className="h-3 w-3" /> {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {template.entitlements && template.entitlements.length > 0 && (
            <div className="bg-surface border border-border rounded-xl p-5">
              <h3 className="text-sm font-semibold text-text-primary mb-2">Plan Availability</h3>
              <div className="space-y-1.5">
                {template.entitlements.map((e) => (
                  <div key={e.planTier} className="flex items-center justify-between text-sm">
                    <span className="text-text-secondary capitalize">{e.planTier}</span>
                    {e.enabled ? (
                      <CheckCircle className="h-4 w-4 text-green-500" />
                    ) : (
                      <X className="h-4 w-4 text-text-muted" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {showInstall && (
        <InstallModal
          template={template}
          onClose={() => setShowInstall(false)}
          onInstalled={() => {
            queryClient.invalidateQueries({ queryKey: ['marketplace-installations'] });
            queryClient.invalidateQueries({ queryKey: ['marketplace-template', templateId] });
          }}
        />
      )}
    </div>
  );
}

interface PhoneNumberAssignment {
  id: string;
  phone_number: string;
  friendly_name: string | null;
}

function InstalledView({ onViewTemplate }: { onViewTemplate: (id: string) => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['marketplace-installations'],
    queryFn: () => api.get<{ installations: Installation[] }>('/marketplace/installations'),
  });

  const { data: phoneData } = useQuery({
    queryKey: ['phone-numbers-list'],
    queryFn: () => api.get<{ phoneNumbers: PhoneNumberAssignment[] }>('/phone-numbers?limit=100'),
  });
  const phoneNumbers = phoneData?.phoneNumbers ?? [];

  const installations = data?.installations ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-surface border border-danger/30 rounded-xl p-12 text-center">
        <AlertCircle className="h-12 w-12 text-danger mx-auto mb-3" />
        <p className="text-text-primary font-medium">Failed to load installations</p>
        <p className="text-sm text-text-secondary mt-1">{(error as Error).message}</p>
      </div>
    );
  }

  if (installations.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-xl p-12 text-center">
        <Download className="h-12 w-12 text-text-muted mx-auto mb-3" />
        <p className="text-text-secondary">No installed templates yet.</p>
        <p className="text-sm text-text-muted mt-1">Browse the marketplace to find and install agent templates.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {installations.map((inst) => {
        const hasUpdate = inst.installed_version !== inst.latest_version;
        const assignedPhones = phoneNumbers.filter(
          (pn) => (pn as unknown as Record<string, unknown>).agent_id === inst.agent_id,
        );
        const config = inst.config as Record<string, unknown>;
        const assignedPhoneId = config?.assignedPhoneNumberId as string | undefined;
        const configPhone = assignedPhoneId
          ? phoneNumbers.find((pn) => pn.id === assignedPhoneId)
          : undefined;
        const allPhones = configPhone
          ? [configPhone, ...assignedPhones.filter((p) => p.id !== configPhone.id)]
          : assignedPhones;

        return (
        <div key={inst.id} className="bg-surface border border-border rounded-xl p-5 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <Store className="h-6 w-6 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="font-semibold text-text-primary">{inst.agent_name || inst.template_name}</h3>
                <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${
                  inst.status === 'active'
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : inst.status === 'error'
                    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                    : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                }`}>
                  {inst.status}
                </span>
                {hasUpdate && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
                    <ArrowUpCircle className="h-3 w-3" /> Update v{inst.latest_version}
                  </span>
                )}
              </div>
              <p className="text-xs text-text-secondary mb-2">{inst.template_name}</p>

              <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted mb-2">
                <span>v{inst.installed_version}</span>
                {inst.agent_type && <span className="capitalize">{inst.agent_type}</span>}
                <span>
                  Installed {new Date(inst.installed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
              </div>

              {allPhones.length > 0 && (
                <div className="flex items-center gap-2 mb-2">
                  <Phone className="h-3.5 w-3.5 text-text-muted" />
                  <div className="flex flex-wrap gap-1.5">
                    {allPhones.map((pn) => (
                      <span key={pn.id} className="inline-flex items-center px-2 py-0.5 rounded bg-surface-hover text-text-secondary text-xs">
                        {pn.friendly_name || pn.phone_number}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 mt-1">
                {inst.agent_status && (
                  <span className="text-xs text-text-muted">
                    Agent: <span className="capitalize">{inst.agent_status}</span>
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-col items-end gap-2 shrink-0">
              {inst.agent_id && (
                <a
                  href={`/agents?edit=${inst.agent_id}`}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary border border-border rounded-lg hover:bg-surface-hover transition"
                >
                  <Settings2 className="h-3.5 w-3.5" /> Configure
                </a>
              )}
              <button
                onClick={() => onViewTemplate(inst.template_id)}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-primary hover:text-primary-hover transition"
              >
                View <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
        );
      })}
    </div>
  );
}

type MarketplaceView = 'browse' | 'installed' | 'detail';

export default function Marketplace() {
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const view: MarketplaceView = location.pathname === '/marketplace/installed'
    ? 'installed'
    : params.id
    ? 'detail'
    : 'browse';

  const selectedTemplateId = params.id || null;
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');

  const { data: templatesData, isLoading: loadingTemplates, error: templatesError } = useQuery({
    queryKey: ['marketplace-templates', search, selectedCategory],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (selectedCategory) params.set('category', selectedCategory);
      params.set('limit', '50');
      return api.get<{ templates: MarketplaceTemplate[]; pagination: { total: number } }>(
        `/marketplace/templates?${params.toString()}`
      );
    },
    enabled: view === 'browse',
  });

  const { data: categoriesData } = useQuery({
    queryKey: ['marketplace-categories'],
    queryFn: () => api.get<{ categories: CategoryInfo[] }>('/marketplace/categories'),
  });

  const { data: installationsData, error: installationsError } = useQuery({
    queryKey: ['marketplace-installations'],
    queryFn: () => api.get<{ installations: Installation[] }>('/marketplace/installations'),
  });

  const templates = templatesData?.templates ?? [];
  const categories = categoriesData?.categories ?? [];
  const installations = installationsData?.installations ?? [];
  const installedTemplateIds = new Set(installations.map((i) => i.template_id));

  const handleViewTemplate = (id: string) => {
    navigate(`/marketplace/${id}`);
  };

  if (view === 'detail' && selectedTemplateId) {
    return (
      <TemplateDetailView
        templateId={selectedTemplateId}
        onBack={() => navigate('/marketplace')}
        installedTemplateIds={installedTemplateIds}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Marketplace</h1>
          <p className="text-sm text-text-secondary mt-1">Browse and install agent templates</p>
        </div>
      </div>

      <div className="flex gap-2 border-b border-border">
        <button
          onClick={() => navigate('/marketplace')}
          className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
            view === 'browse' ? 'border-primary text-primary' : 'border-transparent text-text-muted hover:text-text-primary'
          }`}
        >
          Browse
        </button>
        <button
          onClick={() => navigate('/marketplace/installed')}
          className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px inline-flex items-center gap-1.5 ${
            view === 'installed' ? 'border-primary text-primary' : 'border-transparent text-text-muted hover:text-text-primary'
          }`}
        >
          Installed
          {installations.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-xs bg-primary/10 text-primary">{installations.length}</span>
          )}
        </button>
      </div>

      {view === 'browse' && (
        <>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search templates..."
                className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          {categories.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setSelectedCategory('')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  !selectedCategory
                    ? 'bg-primary text-white'
                    : 'bg-surface-hover text-text-secondary hover:text-text-primary'
                }`}
              >
                All
              </button>
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setSelectedCategory(selectedCategory === cat.name ? '' : cat.name)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    selectedCategory === cat.name
                      ? 'bg-primary text-white'
                      : 'bg-surface-hover text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {cat.displayName}
                  {cat.templateCount > 0 && (
                    <span className="ml-1 opacity-60">({cat.templateCount})</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {loadingTemplates ? (
            <div className="flex items-center justify-center py-20">
              <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
            </div>
          ) : templatesError ? (
            <div className="bg-surface border border-danger/30 rounded-xl p-12 text-center">
              <AlertCircle className="h-12 w-12 text-danger mx-auto mb-3" />
              <p className="text-text-primary font-medium">Failed to load templates</p>
              <p className="text-sm text-text-secondary mt-1">{(templatesError as Error).message}</p>
            </div>
          ) : templates.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-12 text-center">
              <Store className="h-12 w-12 text-text-muted mx-auto mb-3" />
              <p className="text-text-secondary">No templates found.</p>
              {(search || selectedCategory) && (
                <p className="text-sm text-text-muted mt-1">Try adjusting your search or filters.</p>
              )}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {templates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  installed={installedTemplateIds.has(template.id)}
                  onClick={() => handleViewTemplate(template.id)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {view === 'installed' && <InstalledView onViewTemplate={handleViewTemplate} />}
    </div>
  );
}
