import { Fragment, useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import OperationsAlertsBanner from '../components/OperationsAlertsBanner';
import { formatCents as formatCentsHelper } from '../lib/formatCurrency';
import { StatCard, PageHeader } from '../components/ui';
import {
  isHardBounce,
  isPermanentSmtpError,
  describeRetrySkippedReason,
  type RetrySkippedReasonBadge,
  type RetrySkippedTone,
} from '../lib/smtpErrorClass';
import {
  Building2, Users, PhoneCall, DollarSign, ChevronDown, ChevronRight,
  Ban, CheckCircle, Eye, Package, Plus, Play, Archive, AlertCircle,
  BarChart3, Download as DownloadIcon, TrendingUp, TrendingDown, Activity,
  ThumbsUp, ThumbsDown, MessageSquare, BookOpen,
  LifeBuoy, Mail, RotateCw, Plug, XCircle,
  AlertTriangle, ShieldAlert, ExternalLink, Send, MailX, ShieldOff,
  Clock, ArrowUpDown, Database, PhoneOff, BellRing,
} from 'lucide-react';

interface DocsFeedbackArticle {
  article_slug: string;
  total_votes: number;
  helpful_count: number;
  not_helpful_count: number;
  comment_count: number;
  new_comment_count: number;
  resolved_comment_count: number;
  hidden_comment_count: number;
  pending_reply_count: number;
  helpful_ratio: number | null;
  last_vote_at: string | null;
}

type DocsFeedbackStatus = 'new' | 'resolved' | 'hidden';

interface DocsFeedbackComment {
  id: number;
  article_slug: string;
  vote: 'helpful' | 'not_helpful';
  comment: string;
  page_path: string | null;
  created_at: string;
  status: DocsFeedbackStatus;
  status_updated_at: string | null;
  status_updated_by: string | null;
  reply_email: string | null;
  reply_count: number;
  last_reply_at?: string | null;
  last_reply_error?: string | null;
  last_reply_retry_skipped_reason?: string | null;
  last_reply_failed?: boolean | null;
  last_reply_permanent?: boolean | null;
  // Auto-retry counters from `docs_feedback_replies.retry_count` /
  // `last_retry_at` on the most recent reply. Driven by the background
  // DocsFeedbackReplyRetryScheduler so the inbox can show whether the
  // pipeline has already burned all auto-retries (admin should reach out
  // another way) or whether the failure is fresh and a retry hasn't
  // kicked in yet (leave it alone for an hour).
  last_reply_retry_count?: number | null;
  last_reply_last_retry_at?: string | null;
}

interface DocsFeedbackReply {
  id: number;
  feedback_id: number;
  sent_by: string | null;
  to_email: string;
  subject: string;
  body: string;
  email_message_id: string | null;
  email_error: string | null;
  retry_skipped_reason: string | null;
  // Number of background auto-retries the DocsFeedbackReplyRetryScheduler
  // has already burned on this row, plus the timestamp of the most recent
  // attempt. Both are bumped in the same conditional UPDATE the scheduler
  // uses to claim a row, so they always advance together. Surfaced in the
  // reply history so an admin can see at-a-glance whether a Failed row
  // still has retries remaining or whether the scheduler has given up.
  retry_count?: number | null;
  last_retry_at?: string | null;
  retry_of: number | null;
  created_at: string;
}

interface DocsFeedbackReplyChain {
  root: DocsFeedbackReply;
  retries: DocsFeedbackReply[];
}

function groupDocsFeedbackReplyChains(
  replies: DocsFeedbackReply[],
): DocsFeedbackReplyChain[] {
  const ascending = [...replies].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const chainsByRoot = new Map<number, DocsFeedbackReplyChain>();
  for (const r of ascending) {
    if (r.retry_of != null && chainsByRoot.has(r.retry_of)) {
      chainsByRoot.get(r.retry_of)!.retries.push(r);
    } else {
      // Root attempt, or an orphan retry (root row deleted / pre-migration data).
      chainsByRoot.set(r.id, { root: r, retries: [] });
    }
  }
  return Array.from(chainsByRoot.values()).sort(
    (a, b) =>
      new Date(b.root.created_at).getTime() -
      new Date(a.root.created_at).getTime(),
  );
}

type DocsFeedbackSort = 'lowest_ratio' | 'highest_ratio' | 'most_votes' | 'recent';
type DocsFeedbackStatusFilter = DocsFeedbackStatus | 'all' | 'pending_reply';

// Mirrors DOCS_FEEDBACK_REPLY_DELIVERY_ALERT_THRESHOLD on the server, which
// the DocsFeedbackReplyRetryScheduler uses as MAX_RETRY_ATTEMPTS. We hard-
// code it on the client so the inbox can render "Auto-retried N/3" without
// an extra round-trip; if the server constant ever changes both sides need
// to be updated together (see platform/help/docsFeedbackReplyDeliveryAlert.ts).
const DOCS_FEEDBACK_REPLY_AUTO_RETRY_MAX = 3;

/**
 * Compact pill that renders "Auto-retried N/MAX" alongside a Failed badge
 * for a docs feedback reply. Renders nothing when no auto-retries have
 * happened yet. Painted amber when the auto-retry pool has been exhausted
 * (the row will not be retried again) and red while retries are still
 * remaining — same colour language the inbox uses for the Hard bounce
 * vs. plain Failed badges. Hover title surfaces the timestamp of the
 * last attempt so an admin can tell whether the scheduler just gave up
 * (recent) or gave up an hour ago.
 */
function DocsFeedbackAutoRetryBadge({
  retryCount,
  lastRetryAt,
  size = 'sm',
}: {
  retryCount: number | null | undefined;
  lastRetryAt: string | null | undefined;
  size?: 'xs' | 'sm';
}) {
  const retries = retryCount ?? 0;
  if (retries <= 0) return null;
  const exhausted = retries >= DOCS_FEEDBACK_REPLY_AUTO_RETRY_MAX;
  const lastRetryLabel = lastRetryAt
    ? new Date(lastRetryAt).toLocaleString()
    : null;
  const title = lastRetryLabel
    ? `Last auto-retry attempt at ${lastRetryLabel}${
        exhausted
          ? ' — no further auto-retries; reach out another way.'
          : '. The background scheduler will keep retrying every ~90s.'
      }`
    : exhausted
      ? 'Auto-retries exhausted — reach out another way.'
      : 'Background scheduler has retried this reply.';
  const sizing =
    size === 'xs'
      ? 'px-1 py-0.5 text-[9px]'
      : 'px-1.5 py-0.5 text-[10px]';
  const palette = exhausted
    ? 'border-warning/40 bg-warning-light text-warning'
    : 'border-danger/40 bg-danger-light text-danger';
  return (
    <span
      className={`rounded border uppercase tracking-wide font-medium ${sizing} ${palette}`}
      title={title}
    >
      Auto-retried {retries}/{DOCS_FEEDBACK_REPLY_AUTO_RETRY_MAX}
    </span>
  );
}

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

// Snapshot of the platform-wide `support_recipient_bounce_alerts` dedup
// table — total distinct addresses we've ever paged ops about for a hard
// bounce, plus the last-7d / last-30d windows that make a sender-reputation
// regression visible at a glance.
interface BouncedRecipientStats {
  total: number;
  last_7d: number;
  last_30d: number;
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
  // Most-recently granted owner's onboarding state, surfaced by
  // `GET /platform/tenants` so the All Tenants table can render an
  // Onboarding badge without expanding each row (Task #994). Both
  // fields are `null` when the tenant has no active owner row yet.
  latest_owner_onboarding_step: number | null;
  latest_owner_onboarding_completed: boolean | null;
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
  last_downgrade_at: string | null;
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

interface ActivationMetricRow {
  tenant_id: string;
  tenant_name: string;
  tenant_plan: string;
  tenant_status: string;
  tenant_created_at: string;
  agent_created_at: string | null;
  agent_deployed_at: string | null;
  phone_connected_at: string | null;
  tools_connected_at: string | null;
  first_call_at: string | null;
  first_workflow_at: string | null;
  time_to_agent_hours: number | null;
  time_to_call_hours: number | null;
  time_to_workflow_hours: number | null;
  milestones_completed: number;
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
  return formatCentsHelper(cents);
}

/**
 * Re-render every second while at least one of the supplied "available at"
 * timestamps is still in the future, so a countdown UI can show its
 * remaining seconds without each consumer wiring up its own setInterval.
 * Returns Date.now() at the latest tick.
 */
function useCountdownTick(targetsMs: number[]): number {
  const [now, setNow] = useState(() => Date.now());
  const active = targetsMs.some((t) => t > now);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Pull a positive integer out of an arbitrary error/response body. Used to
 * read `retry_after_seconds` (from a 429) or `retry_cooldown_seconds` (from
 * a successful retry) without leaking `any` everywhere.
 */
function readPositiveSeconds(body: unknown, key: string): number | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as Record<string, unknown>)[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.ceil(raw);
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-success-light text-success',
    pending: 'bg-warning-light text-warning',
    suspended: 'bg-danger-light text-danger',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-surface-hover text-text-secondary'}`}>
      {status}
    </span>
  );
}

// Color/border palette for the retry-skipped reason badges. Each tone is
// distinct enough that ops can tell them apart at a glance in a long inbox
// list without needing to mouse over the tooltip.
const RETRY_SKIPPED_TONE_CLASSES: Record<RetrySkippedTone, string> = {
  hard_bounce:
    'bg-warning-light text-warning border-warning/40',
  suppression:
    'bg-accent-light text-accent border-accent/40',
  manual_cancel:
    'bg-surface-secondary text-text-secondary border-border',
  unsubscribed:
    'bg-danger-light text-danger border-danger/40',
  unknown:
    'bg-surface-secondary text-text-muted border-border',
};

/**
 * Compact pill rendered alongside a failed-delivery row when the auto-retry
 * pipeline has decided not to attempt the row again. Reads the descriptor
 * from `describeRetrySkippedReason` so a new server-side reason becomes a
 * distinct badge automatically (and an unrecognised reason falls through to
 * a generic "Auto-retry skipped" label instead of breaking the layout).
 */
function RetrySkippedBadge({
  reason,
  size = 'sm',
  variant = 'short',
}: {
  reason: string | null | undefined;
  size?: 'xs' | 'sm';
  variant?: 'short' | 'long';
}) {
  const descriptor: RetrySkippedReasonBadge | null = describeRetrySkippedReason(reason);
  if (!descriptor) return null;
  const sizeClass =
    size === 'xs'
      ? 'px-1 py-0.5 text-[9px]'
      : 'px-1.5 py-0.5 text-[10px]';
  return (
    <span
      title={descriptor.description}
      className={`inline-flex items-center rounded border font-medium uppercase tracking-wide cursor-help ${sizeClass} ${RETRY_SKIPPED_TONE_CLASSES[descriptor.tone]}`}
    >
      {variant === 'long' ? descriptor.longLabel : descriptor.shortLabel}
    </span>
  );
}

function PlanBadge({ plan }: { plan: string }) {
  const colors: Record<string, string> = {
    starter: 'bg-info-light text-info',
    pro: 'bg-accent-light text-accent',
    enterprise: 'bg-warning-light text-warning',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[plan] ?? 'bg-surface-hover text-text-secondary'}`}>
      {plan}
    </span>
  );
}

function VersionStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-warning-light text-warning',
    published: 'bg-success-light text-success',
    deprecated: 'bg-danger-light text-danger',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-surface-hover text-text-secondary'}`}>
      {status}
    </span>
  );
}

// Owner-user onboarding row returned by `/platform/tenants/:id/onboarding`.
// Mirrors the SQL projection in `server/admin-api/routes/platformAdmin.ts`,
// where `onboarding_step` is already clamped to [1..3] and
// `onboarding_completed` is forced to a boolean.
interface TenantOwnerOnboarding {
  user_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
  last_login_at: string | null;
  role_granted_at: string | null;
  onboarding_step: number;
  onboarding_completed: boolean;
}

// Total step count for the wizard, kept in lock-step with
// `TOTAL_ONBOARDING_STEPS` in `client-app/src/pages/Onboarding.tsx`. Update
// both together if the wizard grows / shrinks a step.
const ONBOARDING_TOTAL_STEPS = 3;

function getOnboardingStepLabel(step: number, t: (k: string, opts?: any) => string): string {
  switch (step) {
    case 1: return t('platform_admin.badges.onboarding_provisioning');
    case 2: return t('platform_admin.badges.onboarding_template');
    case 3: return t('platform_admin.badges.onboarding_phone');
    default: return t('platform_admin.badges.onboarding_step_label', { step });
  }
}

function OwnerOnboardingBadge({
  step,
  completed,
}: {
  step: number;
  completed: boolean;
}) {
  const { t: adminT } = useTranslation('admin');
  if (completed) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-success-light text-success">
        <CheckCircle className="h-3 w-3" />
        {adminT('platform_admin.badges.onboarding_completed')}
      </span>
    );
  }
  const label = getOnboardingStepLabel(step, adminT as any);
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-warning-light text-warning">
      <AlertCircle className="h-3 w-3" />
      {adminT('platform_admin.badges.onboarding_step_n', { step, total: ONBOARDING_TOTAL_STEPS, label })}
    </span>
  );
}

function TenantDetailPanel({ tenantId }: { tenantId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['platform-tenant-detail', tenantId],
    queryFn: () => api.get<{ tenant: TenantDetail }>(`/platform/tenants/${tenantId}`),
  });

  // Per-owner onboarding state — separate query so a slow / failing
  // onboarding fetch doesn't block the rest of the detail panel from
  // rendering. The endpoint scopes to `tenant_owner` rows so the list is
  // small (typically 1).
  const { data: onboardingData, isLoading: onboardingLoading } = useQuery({
    queryKey: ['platform-tenant-onboarding', tenantId],
    queryFn: () =>
      api.get<{ owners: TenantOwnerOnboarding[] }>(
        `/platform/tenants/${tenantId}/onboarding`,
      ),
  });

  if (isLoading) return <div className="px-4 py-3 text-sm text-text-muted">Loading details...</div>;
  if (!data) return null;

  const t = data.tenant;
  const owners = onboardingData?.owners ?? [];
  return (
    <div className="bg-surface-secondary/50">
      <div className="px-6 py-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-4 text-sm">
        <div>
          <span className="text-text-muted">Agents</span>
          <div className="font-medium">{t.agent_count}</div>
        </div>
        <div>
          <span className="text-text-muted">Phone Numbers</span>
          <div className="font-medium">{t.phone_number_count}</div>
        </div>
        <div>
          <span className="text-text-muted">Total Calls</span>
          <div className="font-medium">{t.total_calls}</div>
        </div>
        <div>
          <span className="text-text-muted">Total Spend</span>
          <div className="font-medium">{formatCents(t.total_cost_cents)}</div>
        </div>
        <div>
          <span className="text-text-muted">Last downgrade</span>
          <div className="font-medium whitespace-nowrap">
            {t.last_downgrade_at
              ? new Date(t.last_downgrade_at).toLocaleString()
              : 'Never'}
          </div>
        </div>
      </div>
      <div className="px-6 pb-4">
        <div className="text-xs uppercase tracking-wide text-text-muted mb-2">
          Owner onboarding
        </div>
        {onboardingLoading ? (
          <div className="text-sm text-text-muted">Loading owner progress...</div>
        ) : owners.length === 0 ? (
          <div className="text-sm text-text-muted">No tenant owners on record.</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-3 py-2 font-medium text-text-muted">Owner</th>
                  <th className="text-left px-3 py-2 font-medium text-text-muted">Onboarding</th>
                  <th className="text-left px-3 py-2 font-medium text-text-muted">Signed up</th>
                  <th className="text-left px-3 py-2 font-medium text-text-muted">Last login</th>
                </tr>
              </thead>
              <tbody>
                {owners.map((owner) => {
                  const fullName = [owner.first_name, owner.last_name]
                    .filter(Boolean)
                    .join(' ')
                    .trim();
                  return (
                    <tr key={owner.user_id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2">
                        <div className="font-medium">{fullName || owner.email}</div>
                        {fullName && (
                          <div className="text-xs text-text-muted">{owner.email}</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <OwnerOnboardingBadge
                          step={owner.onboarding_step}
                          completed={owner.onboarding_completed}
                        />
                      </td>
                      <td className="px-3 py-2 text-text-muted whitespace-nowrap">
                        {new Date(owner.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-3 py-2 text-text-muted whitespace-nowrap">
                        {owner.last_login_at
                          ? new Date(owner.last_login_at).toLocaleDateString()
                          : '\u2014'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
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
        <label className="text-xs text-text-muted block mb-1">Version (semver)</label>
        <input
          type="text"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          placeholder="e.g. 1.2.0"
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
      </div>
      <div>
        <label className="text-xs text-text-muted block mb-1">Changelog</label>
        <textarea
          value={changelog}
          onChange={(e) => setChangelog(e.target.value)}
          placeholder="What changed in this version..."
          rows={3}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
        />
      </div>
      <div>
        <label className="text-xs text-text-muted block mb-1">Release Notes (optional)</label>
        <textarea
          value={releaseNotes}
          onChange={(e) => setReleaseNotes(e.target.value)}
          placeholder="Additional notes for this release..."
          rows={2}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
        />
      </div>
      {createMutation.isError && (
        <div className="text-sm text-danger">
          {(createMutation.error as Error).message}
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => createMutation.mutate()}
          disabled={!version || !changelog || createMutation.isPending}
          className="px-4 py-2 text-sm font-medium bg-primary text-on-primary rounded-lg hover:bg-primary/90 disabled:opacity-50"
        >
          {createMutation.isPending ? 'Creating...' : 'Create Draft'}
        </button>
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-text-muted hover:text-text-primary rounded-lg hover:bg-surface-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function TemplateVersionManager({ templateId }: { templateId: string }) {
  const { t: adminT } = useTranslation('admin');
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

  if (isLoading) return <div className="px-4 py-3 text-sm text-text-muted">Loading template...</div>;
  if (!data) return null;

  const versions = data.versions ?? [];

  return (
    <div className="px-6 py-4 bg-surface-secondary/50 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">{data.displayName}</h3>
          <p className="text-xs text-text-muted">Current: v{data.currentVersion} | {versions.length} version(s)</p>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-primary text-on-primary rounded-lg hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" /> New Version
        </button>
      </div>

      {showCreateForm && (
        <CreateVersionForm templateId={templateId} onClose={() => setShowCreateForm(false)} />
      )}

      {publishMutation.isError && (
        <div className="text-sm text-danger bg-danger-light p-2 rounded">
          {(publishMutation.error as Error).message}
        </div>
      )}

      {publishMutation.isSuccess && (
        <div className="text-sm text-success bg-success-light p-2 rounded flex items-center gap-2">
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
                      className="p-1.5 rounded hover:bg-surface-secondary text-text-muted hover:text-text-primary"
                      title="Validate"
                    >
                      <AlertCircle className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(adminT('platform_admin.template_version_manager.confirm_publish', { version: v.version }))) {
                          publishMutation.mutate(v.id);
                        }
                      }}
                      disabled={publishMutation.isPending}
                      className="p-1.5 rounded hover:bg-success-light text-text-muted hover:text-success"
                      title="Publish"
                    >
                      <Play className="h-4 w-4" />
                    </button>
                  </>
                )}
                {v.status === 'published' && !v.isLatest && (
                  <button
                    onClick={() => {
                      if (confirm(adminT('platform_admin.template_version_manager.confirm_deprecate', { version: v.version }))) {
                        deprecateMutation.mutate(v.id);
                      }
                    }}
                    disabled={deprecateMutation.isPending}
                    className="p-1.5 rounded hover:bg-danger-light text-text-muted hover:text-danger"
                    title="Deprecate"
                  >
                    <Archive className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            {v.changelog && (
              <p className="text-xs text-text-muted mt-1">{v.changelog}</p>
            )}
            <p className="text-xs text-text-muted mt-1">
              {v.status === 'draft' ? 'Not yet published' : `Published: ${new Date(v.publishedAt).toLocaleDateString()}`}
            </p>

            {validationResults[v.id] && (
              <div className="mt-2 border-t border-border pt-2 space-y-1">
                <div className="flex items-center gap-1 text-xs font-medium">
                  {validationResults[v.id].valid ? (
                    <><CheckCircle className="h-3.5 w-3.5 text-success" /> Validation passed</>
                  ) : (
                    <><AlertCircle className="h-3.5 w-3.5 text-danger" /> Validation failed</>
                  )}
                </div>
                {validationResults[v.id].checks.map((check, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className={check.passed ? 'text-success' : 'text-danger'}>
                      {check.passed ? '\u2713' : '\u2717'}
                    </span>
                    <span className="text-text-muted">{check.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {versions.length === 0 && (
          <p className="text-sm text-text-muted text-center py-4">No versions created yet</p>
        )}
      </div>
    </div>
  );
}

interface ConnectorHealthRow {
  integrationId: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  connectorType: string;
  provider: string;
  name: string | null;
  isEnabled: boolean;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastSyncErrorAt: string | null;
  authAlertSentAt: string | null;
  recoveryAlertSentAt: string | null;
  updatedAt: string | null;
  refreshable?: boolean;
}

interface ConnectorRefreshFailure {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  integrationId: string | null;
  provider: string | null;
  errorMessage: string | null;
  occurredAt: string;
}

type ConnectorTokenHealthStatus =
  | 'healthy'
  | 'expiring'
  | 'expired'
  | 'needs_reconnect'
  | 'unknown';

interface ConnectorTokenHealthRow {
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  integrationId: string;
  integrationType: string;
  provider: string;
  name: string | null;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  lastSyncErrorAt: string | null;
  tokenIssuedAt: string | null;
  tokenExpiresAt: string | null;
  tokenDecryptFailed: boolean;
  status: ConnectorTokenHealthStatus;
  expiresInMs: number | null;
  cyclesSinceRefresh: number | null;
  stale: boolean;
}

interface ConnectorExpiringSoonRow {
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  integrationId: string;
  integrationType: string;
  provider: string;
  name: string | null;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  tokenIssuedAt: string | null;
  tokenExpiresAt: string | null;
  expiresInMs: number;
}

interface StuckOutboxEventRow {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  integrationId: string | null;
  integrationProvider: string | null;
  integrationName: string | null;
  integrationType: string | null;
  eventType: string;
  status: 'failed' | 'dead_letter';
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

interface StuckOutboxSummary {
  failed: number;
  deadLetter: number;
  affectedTenants: number;
}

interface CrmRevalidationCycleEntry {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scanned: number;
  validated: number;
  staleScrubbed: number;
  skippedNoConfig: number;
  failed: number;
  threw: boolean;
}

interface CrmRevalidationPerTenantRow {
  tenantId: string;
  scanned: number;
  validated: number;
  staleScrubbed: number;
  skippedNoConfig: number;
  failed: number;
  lastTouchedAt: string;
}

interface CrmRevalidationMetrics {
  startedAt: string;
  totals: {
    cyclesRun: number;
    cyclesThrew: number;
    scanned: number;
    validated: number;
    staleScrubbed: number;
    skippedNoConfig: number;
    failed: number;
  };
  lastCycle: CrmRevalidationCycleEntry | null;
  recentCycles: CrmRevalidationCycleEntry[];
  perTenant: CrmRevalidationPerTenantRow[];
  perTenantTracked: number;
  perTenantLimit: number;
}

interface ConnectorHealthResponse {
  connectors: ConnectorHealthRow[];
  recentRefreshFailures: ConnectorRefreshFailure[];
  summary: {
    needsReconnect: number;
    syncError: number;
    healthy: number;
    totalEnabled: number;
    affectedTenants: number;
    expiringSoon?: number;
  };
  tokenHealth?: ConnectorTokenHealthRow[];
  tokenHealthRefreshIntervalMs?: number;
  tokenHealthExpiringHorizonMs?: number;
  tokenHealthStaleCycleThreshold?: number;
  expiringSoon?: ConnectorExpiringSoonRow[];
  expiringSoonWindowMs?: number;
  expiringSoonWithinHours?: number;
  stuckOutboxEvents?: StuckOutboxEventRow[];
  stuckOutboxSummary?: StuckOutboxSummary;
  stuckOutboxLimit?: number;
  crmRevalidation?: CrmRevalidationMetrics | null;
  window: {
    sinceDays: number;
    eventsLimit: number;
    expiringWithinHours?: number;
    stuckOutboxLimit?: number;
  };
}

function formatRelativeTime(iso: string | null, t: (k: string, opts?: any) => string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHr / 24);
  if (Number.isNaN(date.getTime())) return '—';
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function ConnectorHealthPanel() {
  const { t: adminT } = useTranslation('admin');
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-connector-health'],
    queryFn: () => api.get<ConnectorHealthResponse>('/platform/connector-health'),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-text-muted">
        {adminT('platform_admin.connector_health.loading')}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-danger">
        {adminT('platform_admin.connector_health.load_failed', { error: error ? (error as Error).message : adminT('platform_admin.connector_health.no_data_error') })}
      </div>
    );
  }

  const {
    connectors,
    recentRefreshFailures,
    summary,
    window,
    tokenHealth,
    tokenHealthRefreshIntervalMs,
    tokenHealthExpiringHorizonMs,
    tokenHealthStaleCycleThreshold,
    expiringSoon,
    expiringSoonWindowMs,
    expiringSoonWithinHours,
    stuckOutboxEvents,
    stuckOutboxSummary,
    crmRevalidation,
  } = data;
  const reconnectConnectors = connectors.filter((c) => c.lastSyncStatus === 'needs_reconnect');
  const erroredConnectors = connectors.filter((c) => c.lastSyncStatus === 'error');
  const expiringSoonRows = expiringSoon ?? [];
  // Default 48h matches the backend default so the UI heading is sensible
  // even when older payloads omit the explicit window.
  const expiringSoonHours =
    expiringSoonWithinHours
    ?? (expiringSoonWindowMs ? Math.round(expiringSoonWindowMs / (60 * 60 * 1000)) : 48);
  const expiringSoonCount = summary.expiringSoon ?? expiringSoonRows.length;
  const stuckRows = stuckOutboxEvents ?? [];
  const stuckSummary = stuckOutboxSummary ?? {
    failed: 0,
    deadLetter: 0,
    affectedTenants: 0,
  };
  const stuckTotal = stuckSummary.failed + stuckSummary.deadLetter;

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-border rounded-xl p-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-primary" /> {adminT('platform_admin.connector_health.title')}
          </h2>
          <p className="text-xs text-text-muted mt-1">
            {adminT('platform_admin.connector_health.subtitle')}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="p-1.5 rounded hover:bg-surface-secondary text-text-muted hover:text-text-primary disabled:opacity-50"
          title={adminT('platform_admin.common.refresh_title')}
        >
          <RotateCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted">{adminT('platform_admin.connector_health.stat_reconnect_needed')}</div>
          <div className={`text-2xl font-bold ${summary.needsReconnect > 0 ? 'text-warning' : ''}`}>
            {summary.needsReconnect}
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted">{adminT('platform_admin.connector_health.stat_sync_errors')}</div>
          <div className={`text-2xl font-bold ${summary.syncError > 0 ? 'text-danger' : ''}`}>
            {summary.syncError}
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted" title={adminT('platform_admin.connector_health.stat_expiring_soon_title', { hours: expiringSoonHours })}>
            {adminT('platform_admin.connector_health.stat_expiring_soon')}
          </div>
          <div className={`text-2xl font-bold ${expiringSoonCount > 0 ? 'text-warning' : ''}`}>
            {expiringSoonCount}
          </div>
          <div className="text-xs text-text-muted mt-0.5">{adminT('platform_admin.connector_health.stat_expiring_in_hours', { hours: expiringSoonHours })}</div>
        </div>
        <div
          className="bg-surface border border-border rounded-xl p-3"
          title={adminT('platform_admin.connector_health.stat_stuck_outbox_title')}
        >
          <div className="text-xs text-text-muted">{adminT('platform_admin.connector_health.stat_stuck_outbox')}</div>
          <div className={`text-2xl font-bold ${stuckTotal > 0 ? 'text-danger' : ''}`}>
            {stuckTotal}
          </div>
          <div className="text-xs text-text-muted mt-0.5">
            {adminT('platform_admin.connector_health.stat_stuck_breakdown', { dead: stuckSummary.deadLetter, failed: stuckSummary.failed })}
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted">{adminT('platform_admin.connector_health.stat_healthy')}</div>
          <div className="text-2xl font-bold text-success">{summary.healthy}</div>
          <div className="text-xs text-text-muted mt-0.5">{adminT('platform_admin.connector_health.stat_healthy_sub', { total: summary.totalEnabled })}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted">{adminT('platform_admin.connector_health.stat_affected_tenants')}</div>
          <div className="text-2xl font-bold">{summary.affectedTenants}</div>
        </div>
      </div>

      <ConnectorAttentionTable
        title={adminT('platform_admin.connector_health.title_reconnect_needed')}
        emptyText={adminT('platform_admin.connector_health.empty_reconnect')}
        rows={reconnectConnectors}
        accent="amber"
      />

      <ConnectorAttentionTable
        title={adminT('platform_admin.connector_health.title_sync_errors')}
        emptyText={adminT('platform_admin.connector_health.empty_sync_errors')}
        rows={erroredConnectors}
        accent="red"
      />

      <ConnectorExpiringSoonTable
        rows={expiringSoonRows}
        windowHours={expiringSoonHours}
      />

      <StuckOutboxEventsPanel rows={stuckRows} summary={stuckSummary} />

      <CrmRevalidationMetricsPanel metrics={crmRevalidation ?? null} />

      <VerifiedCallerHealthPanel />

      <ConnectorTokenHealthPanel
        rows={tokenHealth ?? []}
        refreshIntervalMs={tokenHealthRefreshIntervalMs ?? 15 * 60 * 1000}
        expiringHorizonMs={tokenHealthExpiringHorizonMs ?? 24 * 60 * 60 * 1000}
        staleCycleThreshold={tokenHealthStaleCycleThreshold ?? 2}
      />

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" />
              {adminT('platform_admin.connector_health.recent_failures_title')}
            </h3>
            <p className="text-xs text-text-muted mt-0.5">
              {adminT('platform_admin.connector_health.recent_failures_subtitle_prefix')} <code className="font-mono">connector.token_refresh_failed</code> {adminT('platform_admin.connector_health.recent_failures_subtitle_suffix', { days: window.sinceDays })}
            </p>
          </div>
        </div>
        {recentRefreshFailures.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-text-muted">
            {adminT('platform_admin.connector_health.empty_recent_failures', { days: window.sinceDays })}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.connector_health.header_when')}</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.connector_health.header_tenant')}</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.connector_health.header_provider')}</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.connector_health.header_error')}</th>
                </tr>
              </thead>
              <tbody>
                {recentRefreshFailures.map((ev) => (
                  <tr key={ev.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-xs text-text-muted whitespace-nowrap">
                      <span title={new Date(ev.occurredAt).toLocaleString()}>
                        {formatRelativeTime(ev.occurredAt, adminT)}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <div className="font-medium">{ev.tenantName ?? adminT('platform_admin.common.em_dash')}</div>
                      {ev.tenantSlug && (
                        <div className="text-text-muted font-mono">{ev.tenantSlug}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs font-medium capitalize">{ev.provider ?? adminT('platform_admin.common.em_dash')}</td>
                    <td className="px-4 py-2 text-xs text-danger font-mono break-all max-w-[420px]">
                      {ev.errorMessage ?? adminT('platform_admin.common.em_dash')}
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

// ----------------------------------------------------------------------------
// Push delivery health (cross-tenant view of push fan-outs into Expo from
// `platform/notifications/PushDispatcher.ts`). Surfaces totals, the worst-
// offender tenants, and recent failures so a tenant whose techs aren't
// getting pushes is visible to ops without grepping logs.
// ----------------------------------------------------------------------------

interface PushHealthTotals {
  attempts: number;
  attempted: number;
  accepted: number;
  retired: number;
  dropped: number;
  failureCount: number;
  affectedTenants: number;
}

interface PushHealthPerTenantRow {
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  attempts: number;
  attempted: number;
  accepted: number;
  retired: number;
  dropped: number;
  failureCount: number;
  lastAttemptAt: string | null;
}

interface PushHealthRecentFailureRow {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  event: string | null;
  attempted: number;
  accepted: number;
  retired: number;
  dropped: number;
  failureReason: string | null;
  occurredAt: string;
}

interface PushHealthResponse {
  windowDays: number;
  generatedAt: string;
  totals: PushHealthTotals;
  perTenant: PushHealthPerTenantRow[];
  perTenantTracked: number;
  perTenantLimit: number;
  recentFailures: PushHealthRecentFailureRow[];
  recentFailuresLimit: number;
}

function PushDeliveryHealthPanel() {
  const { t: adminT } = useTranslation('admin');
  const [windowDays, setWindowDays] = useState<number>(7);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-push-health', windowDays],
    queryFn: () =>
      api.get<PushHealthResponse>(
        `/platform/push-health?windowDays=${windowDays}`,
      ),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-text-muted">
        Loading push delivery health…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-danger">
        Failed to load push delivery health: {error ? (error as Error).message : 'no data'}
      </div>
    );
  }

  const { totals, perTenant, recentFailures } = data;
  const acceptanceRate =
    totals.attempted > 0
      ? Math.round((totals.accepted / totals.attempted) * 100)
      : null;

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-border rounded-xl p-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <BellRing className="h-4 w-4 text-primary" /> Push Delivery Health
          </h2>
          <p className="text-xs text-text-muted mt-1">
            Cross-tenant view of technician push fan-outs into Expo over the
            last {data.windowDays} days. Recorded by{' '}
            <code className="font-mono">PushDispatcher</code> on every attempt.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-text-muted flex items-center gap-1">
            Window
            <select
              value={windowDays}
              onChange={(e) => setWindowDays(parseInt(e.target.value, 10))}
              className="bg-surface border border-border rounded px-2 py-1 text-xs"
            >
              <option value={1}>1d</option>
              <option value={7}>7d</option>
              <option value={14}>14d</option>
              <option value={30}>30d</option>
            </select>
          </label>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="p-1.5 rounded hover:bg-surface-secondary text-text-muted hover:text-text-primary disabled:opacity-50"
            title="Refresh"
          >
            <RotateCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted">Attempts</div>
          <div className="text-2xl font-bold">{totals.attempts}</div>
          <div className="text-xs text-text-muted mt-0.5">
            {totals.attempted} devices
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted">Accepted</div>
          <div className="text-2xl font-bold text-success">
            {totals.accepted}
          </div>
          <div className="text-xs text-text-muted mt-0.5">
            {acceptanceRate === null ? '—' : `${acceptanceRate}% rate`}
          </div>
        </div>
        <div
          className="bg-surface border border-border rounded-xl p-3"
          title="Devices Expo flagged as DeviceNotRegistered or InvalidCredentials and that PushDispatcher flipped push_enabled = FALSE on"
        >
          <div className="text-xs text-text-muted">Retired</div>
          <div className={`text-2xl font-bold ${totals.retired > 0 ? 'text-warning' : ''}`}>
            {totals.retired}
          </div>
          <div className="text-xs text-text-muted mt-0.5">devices</div>
        </div>
        <div
          className="bg-surface border border-border rounded-xl p-3"
          title="Devices we attempted to deliver to but Expo neither accepted nor retired (HTTP 5xx, network blip, transient ticket error, etc.)"
        >
          <div className="text-xs text-text-muted">Dropped</div>
          <div className={`text-2xl font-bold ${totals.dropped > 0 ? 'text-danger' : ''}`}>
            {totals.dropped}
          </div>
          <div className="text-xs text-text-muted mt-0.5">devices</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted">Failed attempts</div>
          <div className={`text-2xl font-bold ${totals.failureCount > 0 ? 'text-danger' : ''}`}>
            {totals.failureCount}
          </div>
          <div className="text-xs text-text-muted mt-0.5">of {totals.attempts}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted">Affected tenants</div>
          <div className="text-2xl font-bold">{totals.affectedTenants}</div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Per-tenant push delivery
          </h3>
          <p className="text-xs text-text-muted mt-0.5">
            Worst offenders first — most dropped + retired devices over the
            last {data.windowDays} days. Showing up to {data.perTenantLimit} tenants.
          </p>
        </div>
        {perTenant.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-text-muted">
            No push fan-outs in the last {data.windowDays} days.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Tenant</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Attempts</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Devices</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Accepted</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Retired</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Dropped</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Failed</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Last attempt</th>
                </tr>
              </thead>
              <tbody>
                {perTenant.map((r) => {
                  const rate =
                    r.attempted > 0
                      ? Math.round((r.accepted / r.attempted) * 100)
                      : null;
                  return (
                    <tr key={r.tenantId} className="border-b border-border last:border-0">
                      <td className="px-4 py-2 text-xs">
                        <div className="font-medium">{r.tenantName ?? '—'}</div>
                        {r.tenantSlug && (
                          <div className="text-text-muted font-mono">{r.tenantSlug}</div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums">{r.attempts}</td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums">{r.attempted}</td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums">
                        {r.accepted}
                        {rate !== null && (
                          <span className="text-text-muted ml-1">({rate}%)</span>
                        )}
                      </td>
                      <td className={`px-4 py-2 text-xs text-right tabular-nums ${r.retired > 0 ? 'text-warning font-semibold' : ''}`}>
                        {r.retired}
                      </td>
                      <td className={`px-4 py-2 text-xs text-right tabular-nums ${r.dropped > 0 ? 'text-danger font-semibold' : ''}`}>
                        {r.dropped}
                      </td>
                      <td className={`px-4 py-2 text-xs text-right tabular-nums ${r.failureCount > 0 ? 'text-danger' : ''}`}>
                        {r.failureCount}
                      </td>
                      <td className="px-4 py-2 text-xs text-text-muted whitespace-nowrap">
                        <span title={r.lastAttemptAt ? new Date(r.lastAttemptAt).toLocaleString() : ''}>
                          {formatRelativeTime(r.lastAttemptAt, adminT)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" />
            Recent push delivery failures
          </h3>
          <p className="text-xs text-text-muted mt-0.5">
            Up to {data.recentFailuresLimit} most recent fan-outs where at
            least one device was dropped or a batch-level failure occurred.
          </p>
        </div>
        {recentFailures.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-text-muted">
            No push delivery failures in the last {data.windowDays} days.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-4 py-2 font-medium text-text-muted">When</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Tenant</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Event</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Att.</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Acc.</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Ret.</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Drop.</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Reason</th>
                </tr>
              </thead>
              <tbody>
                {recentFailures.map((row) => (
                  <tr key={row.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-xs text-text-muted whitespace-nowrap">
                      <span title={new Date(row.occurredAt).toLocaleString()}>
                        {formatRelativeTime(row.occurredAt, adminT)}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <div className="font-medium">{row.tenantName ?? '—'}</div>
                      {row.tenantSlug && (
                        <div className="text-text-muted font-mono">{row.tenantSlug}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs font-mono text-text-muted">
                      {row.event ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-right tabular-nums">{row.attempted}</td>
                    <td className="px-4 py-2 text-xs text-right tabular-nums">{row.accepted}</td>
                    <td className={`px-4 py-2 text-xs text-right tabular-nums ${row.retired > 0 ? 'text-warning' : ''}`}>
                      {row.retired}
                    </td>
                    <td className={`px-4 py-2 text-xs text-right tabular-nums ${row.dropped > 0 ? 'text-danger font-semibold' : ''}`}>
                      {row.dropped}
                    </td>
                    <td className="px-4 py-2 text-xs font-mono text-danger break-all max-w-[280px]">
                      {row.failureReason ?? (row.dropped > 0 ? 'unknown' : '—')}
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

// ----------------------------------------------------------------------------
// Verified caller health (cross-tenant view of expiring / expired / revoked
// outbound caller IDs surfaced from the weekly health scheduler).
// ----------------------------------------------------------------------------

type VerifiedCallerHealthStatus = 'expiring_soon' | 'expired' | 'revoked';

type VerifiedCallerAlertSource = 'scheduler' | 'admin_reissue';

type VerifiedCallerAlertDeliveryStatus = 'sent' | 'bounced' | 'failed' | 'skipped';

interface VerifiedCallerAlertSummary {
  dispatchId: string;
  dispatchedAt: string;
  healthStatus: string;
  source: VerifiedCallerAlertSource;
  sentCount: number;
  bouncedCount: number;
  failedCount: number;
  skippedCount: number;
  totalCount: number;
  /** True when at least one delivery attempt was made and every one bounced. */
  allBounced: boolean;
}

interface VerifiedCallerHealthRow {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  phoneNumber: string;
  friendlyName: string | null;
  status: VerifiedCallerHealthStatus;
  daysRemaining: number | null;
  expiresAt: string | null;
  lastHealthCheckAt: string | null;
  lastHealthMessage: string | null;
  expiryAlertSentAt: string | null;
  lastAlert: VerifiedCallerAlertSummary | null;
}

interface VerifiedCallerHealthResponse {
  callers: VerifiedCallerHealthRow[];
  summary: {
    revoked: number;
    expired: number;
    expiringSoon: number;
    total: number;
    affectedTenants: number;
  };
  limit: number;
}

interface VerifiedCallerAlertRecipient {
  id: number;
  dispatchId: string;
  healthStatus: string;
  recipientEmail: string;
  recipientName: string | null;
  userId: string | null;
  deliveryStatus: VerifiedCallerAlertDeliveryStatus;
  deliveryError: string | null;
  permanentFailure: boolean;
  source: VerifiedCallerAlertSource;
  triggeredByUserId: string | null;
  triggeredByEmail: string | null;
  triggeredByName: string | null;
  dispatchedAt: string;
}

interface VerifiedCallerAlertHistoryResponse {
  recipients: VerifiedCallerAlertRecipient[];
  limit: number;
  truncated: boolean;
}

function verifiedCallerStatusBadge(status: VerifiedCallerHealthStatus, t: (k: string) => string): {
  label: string;
  classes: string;
} {
  switch (status) {
    case 'revoked':
      return {
        label: t('platform_admin.verified_caller.status_revoked'),
        classes:
          'bg-danger-light text-danger border border-danger/30',
      };
    case 'expired':
      return {
        label: t('platform_admin.verified_caller.status_expired'),
        classes:
          'bg-danger-light text-danger border border-danger/30',
      };
    case 'expiring_soon':
      return {
        label: t('platform_admin.verified_caller.status_expiring'),
        classes:
          'bg-warning-light text-warning border border-warning/30',
      };
  }
}

type BillingPriceCheckStatus =
  | 'ok'
  | 'missing-env'
  | 'stripe-error'
  | 'wrong-interval'
  | 'no-amount';

interface BillingPriceCheckResult {
  envKey: string;
  plan: 'starter' | 'pro' | 'enterprise';
  interval: 'monthly' | 'annual';
  status: BillingPriceCheckStatus;
  priceId: string | null;
  expectedInterval: 'month' | 'year';
  actualInterval: string | null;
  unitAmountCents: number | null;
  monthlyEquivalentCents: number | null;
  catalogMonthlyCents: number;
  message?: string;
}

interface BillingConfigHealthResponse {
  summary: {
    total: number;
    ok: number;
    failed: number;
    status: 'ok' | 'failed' | 'no-stripe-key';
    message?: string;
  };
  results: BillingPriceCheckResult[];
  generatedAt: string;
}

function fmtCentsAsUsd(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function billingStatusLabel(s: BillingPriceCheckStatus): string {
  switch (s) {
    case 'ok':
      return 'OK';
    case 'missing-env':
      return 'Missing env var';
    case 'stripe-error':
      return 'Stripe error';
    case 'wrong-interval':
      return 'Wrong interval';
    case 'no-amount':
      return 'No unit amount';
  }
}

/**
 * Re-runs the same `STRIPE_PRICE_<TIER>_<INTERVAL>` verification the deploy
 * build runs (`npm run verify:stripe-prices`), but on demand against the
 * currently running Admin API. Useful when ops rotates a Stripe price id
 * or is investigating a sudden live-rate badge regression — they can spot
 * a typo/wrong-interval wiring without redeploying.
 */
function BillingConfigHealthPanel() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-billing-config-health'],
    queryFn: () => api.get<BillingConfigHealthResponse>('/platform/billing-config-health'),
    refetchInterval: 5 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-text-muted">
        Loading billing config health…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-danger">
        Failed to load billing config health: {error ? (error as Error).message : 'no data'}
      </div>
    );
  }

  const { summary, results, generatedAt } = data;
  const generated = new Date(generatedAt).toLocaleString();

  const summaryTone =
    summary.status === 'ok'
      ? 'text-success'
      : summary.status === 'no-stripe-key'
        ? 'text-warning'
        : 'text-danger';

  const SummaryIcon =
    summary.status === 'ok'
      ? CheckCircle
      : summary.status === 'no-stripe-key'
        ? AlertTriangle
        : XCircle;

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-border rounded-xl p-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-primary" /> Billing config health
          </h2>
          <p className="text-xs text-text-muted mt-1">
            Re-runs <code className="font-mono">npm run verify:stripe-prices</code> against the
            current Admin API process. The same script gates the deploy build, so a healthy panel
            here mirrors what shipped — re-run after rotating a Stripe price id, or when the
            live-rate badge silently falls back to the catalog.
          </p>
          <p className="text-[11px] text-text-muted mt-1">
            Last checked: {generated}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border rounded hover:bg-surface-secondary disabled:opacity-50"
            title="Re-run verification"
          >
            <RotateCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            Run again
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted">Status</div>
          <div className={`text-base font-semibold flex items-center gap-1.5 mt-0.5 ${summaryTone}`}>
            <SummaryIcon className="h-4 w-4" />
            {summary.status === 'ok'
              ? 'All prices healthy'
              : summary.status === 'no-stripe-key'
                ? 'Stripe key not set'
                : `${summary.failed} failed`}
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted">Prices checked</div>
          <div className="text-2xl font-bold">{summary.total}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted">Healthy</div>
          <div className="text-2xl font-bold text-success">{summary.ok}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted">Failed</div>
          <div className={`text-2xl font-bold ${summary.failed > 0 ? 'text-danger' : ''}`}>
            {summary.failed}
          </div>
        </div>
      </div>

      {summary.message && summary.status !== 'ok' && (
        <div className="bg-warning/10 border border-warning/30 text-warning rounded-xl p-3 text-sm flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{summary.message}</span>
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Per-price verification
          </h3>
          <p className="text-xs text-text-muted mt-0.5">
            One row per <code className="font-mono">STRIPE_PRICE_&lt;TIER&gt;_&lt;INTERVAL&gt;</code> env var.
            "Monthly equiv." divides annual prices by 12 so the catalog comparison stays
            apples-to-apples.
          </p>
        </div>
        {results.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-text-muted">
            {summary.status === 'no-stripe-key'
              ? 'STRIPE_SECRET_KEY is not set on this Admin API host — set it in the deployment secrets and re-run.'
              : 'No prices configured.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Env var</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Plan</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Interval</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Stripe price id</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Unit amount</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Monthly equiv.</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Catalog</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Status</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const ok = r.status === 'ok';
                  const StatusIcon = ok ? CheckCircle : XCircle;
                  const statusTone = ok ? 'text-success' : 'text-danger';
                  return (
                    <tr key={r.envKey} className="border-b border-border last:border-0 align-top">
                      <td className="px-4 py-2 text-xs font-mono">{r.envKey}</td>
                      <td className="px-4 py-2 text-xs capitalize">{r.plan}</td>
                      <td className="px-4 py-2 text-xs capitalize">
                        {r.interval}
                        {r.actualInterval && r.actualInterval !== r.expectedInterval && (
                          <div className="text-[11px] text-danger mt-0.5">
                            Stripe says: {r.actualInterval}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs font-mono break-all">
                        {r.priceId ?? <span className="text-text-muted italic">unset</span>}
                      </td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums">
                        {fmtCentsAsUsd(r.unitAmountCents)}
                      </td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums">
                        {fmtCentsAsUsd(r.monthlyEquivalentCents)}
                      </td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums text-text-muted">
                        {fmtCentsAsUsd(r.catalogMonthlyCents)}
                      </td>
                      <td className={`px-4 py-2 text-xs ${statusTone}`}>
                        <div className="flex items-center gap-1.5 font-medium">
                          <StatusIcon className="h-3.5 w-3.5" />
                          {billingStatusLabel(r.status)}
                        </div>
                        {r.message && (
                          <div className="text-[11px] text-text-muted mt-0.5">{r.message}</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Render the days-remaining cell. Negative numbers (already expired) read
 * as "expired N days ago", `null` (no `expires_at` — typical for
 * `revoked`) reads as an em-dash with a tooltip.
 */
function VerifiedCallerDaysCell({
  status,
  daysRemaining,
}: {
  status: VerifiedCallerHealthStatus;
  daysRemaining: number | null;
}) {
  const { t: adminT } = useTranslation('admin');
  if (daysRemaining === null) {
    return (
      <span
        className="text-text-muted"
        title={adminT('platform_admin.verified_caller.no_expiry')}
      >
        {adminT('platform_admin.common.em_dash')}
      </span>
    );
  }
  if (daysRemaining < 0) {
    const ago = Math.abs(daysRemaining);
    return (
      <span className="text-danger font-medium">
        {adminT('platform_admin.verified_caller.expired_days_ago', { count: ago })}
      </span>
    );
  }
  if (daysRemaining === 0) {
    return (
      <span className="text-danger font-medium">
        {adminT('platform_admin.verified_caller.expires_today')}
      </span>
    );
  }
  const tone =
    status === 'expiring_soon' && daysRemaining <= 7
      ? 'text-warning font-medium'
      : 'text-text-primary';
  return <span className={tone}>{adminT('platform_admin.verified_caller.days_unit', { count: daysRemaining })}</span>;
}

/**
 * Render the per-recipient color-coded badge inside the expanded history
 * table. Mirrors the connector-alert-recipients styling so the two
 * panels read consistently when an admin is bouncing between them.
 */
function VerifiedCallerDeliveryBadge({
  status,
  permanentFailure,
}: {
  status: VerifiedCallerAlertDeliveryStatus;
  permanentFailure: boolean;
}) {
  let label: string;
  let classes: string;
  switch (status) {
    case 'sent':
      label = 'Delivered';
      classes =
        'bg-success-light text-success border border-success/30';
      break;
    case 'bounced':
      label = 'Bounced';
      classes =
        'bg-danger-light text-danger border border-danger/30';
      break;
    case 'failed':
      label = permanentFailure ? 'Failed (permanent)' : 'Failed';
      classes =
        'bg-warning-light text-warning border border-warning/30';
      break;
    case 'skipped':
      label = 'Skipped';
      classes =
        'bg-surface-secondary text-text-muted border border-border';
      break;
  }
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${classes}`}
    >
      {label}
    </span>
  );
}

interface AlertHistoryDispatchGroup {
  dispatchId: string;
  dispatchedAt: string;
  source: VerifiedCallerAlertSource;
  healthStatus: string;
  triggeredByLabel: string | null;
  recipients: VerifiedCallerAlertRecipient[];
}

/**
 * Group the flat recipient list into one entry per dispatch so the UI
 * can render "March 4 — sent to 3 admins" headers with the per-recipient
 * rows underneath. Preserves the server's newest-first ordering.
 */
function groupAlertRecipientsByDispatch(
  rows: VerifiedCallerAlertRecipient[],
): AlertHistoryDispatchGroup[] {
  const groups: AlertHistoryDispatchGroup[] = [];
  const indexById = new Map<string, number>();
  for (const row of rows) {
    let idx = indexById.get(row.dispatchId);
    if (idx === undefined) {
      idx = groups.length;
      indexById.set(row.dispatchId, idx);
      const triggered = row.triggeredByName || row.triggeredByEmail;
      groups.push({
        dispatchId: row.dispatchId,
        dispatchedAt: row.dispatchedAt,
        source: row.source,
        healthStatus: row.healthStatus,
        triggeredByLabel: triggered ?? null,
        recipients: [],
      });
    }
    groups[idx].recipients.push(row);
  }
  return groups;
}

/**
 * Lazy-loaded recipient history for one verified caller. Mounted by the
 * panel only when an admin expands a row, so the listing endpoint stays
 * cheap for tenants with hundreds of unhealthy callers.
 */
function VerifiedCallerAlertHistory({
  tenantId,
  callerId,
}: {
  tenantId: string;
  callerId: string;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['platform-verified-caller-alert-history', tenantId, callerId],
    queryFn: () =>
      api.get<VerifiedCallerAlertHistoryResponse>(
        `/platform/verified-caller-health/${tenantId}/${callerId}/alert-history`,
      ),
    // History rarely changes after a dispatch; a 30s stale window is
    // plenty for the support workflow (expand → re-issue → re-expand).
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="px-4 py-3 text-xs text-text-muted">Loading alert history…</div>
    );
  }
  if (error) {
    return (
      <div className="px-4 py-3 text-xs text-danger">
        Failed to load alert history: {(error as Error).message}
      </div>
    );
  }
  const recipients = data?.recipients ?? [];
  if (recipients.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-text-muted">
        No alert emails have been recorded for this caller yet. Alert audit logging began
        when this feature shipped — older dispatches won't appear here.
      </div>
    );
  }

  const groups = groupAlertRecipientsByDispatch(recipients);

  return (
    <div className="px-4 py-3 space-y-3">
      {data?.truncated && (
        <div className="text-[11px] text-warning">
          Showing the most recent {data.limit} recipient rows. Older history was
          truncated.
        </div>
      )}
      {groups.map((group) => {
        const sentCount = group.recipients.filter((r) => r.deliveryStatus === 'sent').length;
        const bouncedCount = group.recipients.filter((r) => r.deliveryStatus === 'bounced').length;
        const failedCount = group.recipients.filter((r) => r.deliveryStatus === 'failed').length;
        const skippedCount = group.recipients.filter((r) => r.deliveryStatus === 'skipped').length;
        return (
          <div
            key={group.dispatchId}
            className="border border-border rounded-md overflow-hidden bg-surface"
          >
            <div className="px-3 py-2 bg-surface-secondary text-xs flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium text-text-primary">
                {new Date(group.dispatchedAt).toLocaleString()}
              </span>
              <span className="text-text-muted">
                {group.source === 'admin_reissue' ? 'Manual re-issue' : 'Scheduler'}
                {group.triggeredByLabel ? ` · by ${group.triggeredByLabel}` : ''}
              </span>
              <span className="text-text-muted">
                Status at send: <span className="font-mono">{group.healthStatus}</span>
              </span>
              <span className="ml-auto flex items-center gap-2 text-[11px]">
                {sentCount > 0 && (
                  <span className="text-success">
                    {sentCount} delivered
                  </span>
                )}
                {bouncedCount > 0 && (
                  <span className="text-danger">
                    {bouncedCount} bounced
                  </span>
                )}
                {failedCount > 0 && (
                  <span className="text-warning">
                    {failedCount} failed
                  </span>
                )}
                {skippedCount > 0 && (
                  <span className="text-text-muted">{skippedCount} skipped</span>
                )}
              </span>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-text-muted">
                  <th className="text-left px-3 py-1.5 font-medium">Recipient</th>
                  <th className="text-left px-3 py-1.5 font-medium">Status</th>
                  <th className="text-left px-3 py-1.5 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {group.recipients.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0 align-top">
                    <td className="px-3 py-1.5">
                      <div className="font-mono">{r.recipientEmail}</div>
                      {r.recipientName && (
                        <div className="text-text-muted">{r.recipientName}</div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <VerifiedCallerDeliveryBadge
                        status={r.deliveryStatus}
                        permanentFailure={r.permanentFailure}
                      />
                    </td>
                    <td
                      className="px-3 py-1.5 text-text-muted max-w-[420px]"
                      title={r.deliveryError ?? undefined}
                    >
                      {r.deliveryError ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function VerifiedCallerHealthPanel() {
  const { t: adminT } = useTranslation('admin');
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-verified-caller-health'],
    queryFn: () => api.get<VerifiedCallerHealthResponse>('/platform/verified-caller-health'),
    refetchInterval: 60_000,
  });

  // Tracks which caller rows are currently expanded to show alert
  // history. Plain Set instead of a single id so an admin can keep
  // multiple tenants open while comparing recipients.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Client-side sort toggle on the days-remaining column. Default is
  // ascending (most urgent first), matching the server's default order.
  // Clicking the header flips between asc / desc so an admin can also
  // see "least urgent first" without paginating.
  const [daysSort, setDaysSort] = useState<'asc' | 'desc'>('asc');

  const reissueAlert = useMutation({
    mutationFn: async (row: VerifiedCallerHealthRow) =>
      api.post<{ ok: boolean; message: string; status: string; emailedRecipients: number }>(
        `/platform/verified-caller-health/${row.tenantId}/${row.id}/alert`,
        {},
      ),
    onSuccess: (resp) => {
      window.alert(resp.message ?? adminT('platform_admin.verified_caller.reissued_default'));
      queryClient.invalidateQueries({ queryKey: ['platform-verified-caller-health'] });
    },
    onError: (err) => {
      window.alert(adminT('platform_admin.verified_caller.reissue_failed', { error: (err as Error).message }));
    },
  });

  const baseCallers = data?.callers ?? [];
  const summary = data?.summary;

  // Sort by days-remaining with the same urgency rules the server uses
  // when sorting ascending (revoked first, then null expires_at, then
  // numeric). Descending is the literal reverse so least-urgent rows
  // bubble to the top.
  const sortKey = (r: VerifiedCallerHealthRow): number => {
    if (r.status === 'revoked') return -Number.MAX_SAFE_INTEGER;
    if (r.daysRemaining === null) return -Number.MAX_SAFE_INTEGER + 1;
    return r.daysRemaining;
  };
  const callers = [...baseCallers].sort((a, b) => {
    const diff = sortKey(a) - sortKey(b);
    return daysSort === 'asc' ? diff : -diff;
  });

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <PhoneOff className="h-4 w-4 text-warning" />
            {adminT('platform_admin.verified_caller.title')}
            <span
              className={`ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                callers.length > 0
                  ? 'bg-warning-light text-warning'
                  : 'bg-surface-secondary text-text-muted border border-border'
              }`}
            >
              {callers.length}
            </span>
          </h3>
          <p className="text-xs text-text-muted mt-0.5">
            {adminT('platform_admin.verified_caller.subtitle')}
          </p>
          {summary && summary.total > 0 && (
            <p className="text-xs text-text-muted mt-1">
              <span className="text-danger font-medium">
                {adminT('platform_admin.verified_caller.summary_revoked', { count: summary.revoked })}
              </span>{' '}
              ·{' '}
              <span className="text-danger font-medium">
                {adminT('platform_admin.verified_caller.summary_expired', { count: summary.expired })}
              </span>{' '}
              ·{' '}
              <span className="text-warning font-medium">
                {adminT('platform_admin.verified_caller.summary_expiring', { count: summary.expiringSoon })}
              </span>{' '}
              · {adminT('platform_admin.verified_caller.summary_affected', { count: summary.affectedTenants })}
            </p>
          )}
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="p-1.5 rounded hover:bg-surface-secondary text-text-muted hover:text-text-primary disabled:opacity-50"
          title={adminT('platform_admin.common.refresh_title')}
        >
          <RotateCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {isLoading ? (
        <div className="px-4 py-6 text-center text-sm text-text-muted">
          {adminT('platform_admin.verified_caller.loading')}
        </div>
      ) : error ? (
        <div className="px-4 py-6 text-center text-sm text-danger">
          {adminT('platform_admin.verified_caller.load_failed', { error: (error as Error).message })}
        </div>
      ) : callers.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-text-muted">
          {adminT('platform_admin.verified_caller.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="px-2 py-2 w-8" aria-label={adminT('platform_admin.verified_caller.expand_row_aria')} />
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.verified_caller.header_tenant')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.verified_caller.header_phone')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.verified_caller.header_status')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">
                  <button
                    type="button"
                    onClick={() => setDaysSort((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
                    className="inline-flex items-center gap-1 hover:text-text-primary focus:outline-none focus:ring-1 focus:ring-border rounded"
                    aria-label={daysSort === 'asc' ? adminT('platform_admin.verified_caller.sort_aria_asc') : adminT('platform_admin.verified_caller.sort_aria_desc')}
                  >
                    {adminT('platform_admin.verified_caller.header_days_remaining')}
                    <span aria-hidden="true">{daysSort === 'asc' ? '↑' : '↓'}</span>
                  </button>
                </th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.verified_caller.header_last_check')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.verified_caller.header_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {callers.map((row) => {
                const badge = verifiedCallerStatusBadge(row.status, adminT);
                const isPending =
                  reissueAlert.isPending && reissueAlert.variables?.id === row.id;
                const isExpanded = expandedRows.has(row.id);
                const lastAlert = row.lastAlert;
                return (
                  <Fragment key={row.id}>
                    <tr className="border-b border-border align-top">
                      <td className="px-2 py-2 align-top">
                        <button
                          type="button"
                          onClick={() => toggleExpanded(row.id)}
                          aria-expanded={isExpanded}
                          aria-label={
                            isExpanded
                              ? adminT('platform_admin.verified_caller.hide_alert_history')
                              : adminT('platform_admin.verified_caller.show_alert_history')
                          }
                          className="p-1 rounded hover:bg-surface-secondary text-text-muted hover:text-text-primary focus:outline-none focus:ring-1 focus:ring-border"
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-2 text-xs">
                        <div className="font-medium">{row.tenantName ?? adminT('platform_admin.common.em_dash')}</div>
                        {row.tenantSlug && (
                          <div className="text-text-muted font-mono">{row.tenantSlug}</div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        <div className="font-mono">{row.phoneNumber}</div>
                        {row.friendlyName && (
                          <div className="text-text-muted">{row.friendlyName}</div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${badge.classes}`}
                        >
                          {badge.label}
                        </span>
                        {lastAlert?.allBounced && (
                          <span
                            className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-danger-light text-danger border border-danger/30"
                            title={adminT('platform_admin.verified_caller.all_bounced_title', { time: new Date(lastAlert.dispatchedAt).toLocaleString() })}
                          >
                            <MailX className="h-3 w-3" />
                            {adminT('platform_admin.verified_caller.all_bounced_label')}
                          </span>
                        )}
                        {row.lastHealthMessage && (
                          <div
                            className="text-text-muted mt-1 max-w-[260px] truncate"
                            title={row.lastHealthMessage}
                          >
                            {row.lastHealthMessage}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs whitespace-nowrap">
                        <VerifiedCallerDaysCell
                          status={row.status}
                          daysRemaining={row.daysRemaining}
                        />
                        {row.expiresAt && (
                          <div className="text-text-muted">
                            {new Date(row.expiresAt).toLocaleDateString()}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-text-muted whitespace-nowrap">
                        <span title={row.lastHealthCheckAt ?? undefined}>
                          {formatRelativeTime(row.lastHealthCheckAt, adminT)}
                        </span>
                        {row.expiryAlertSentAt && (
                          <div
                            className="text-text-muted mt-0.5"
                            title={adminT('platform_admin.verified_caller.last_alert_sent_title', { time: new Date(row.expiryAlertSentAt).toLocaleString() })}
                          >
                            {adminT('platform_admin.verified_caller.alerted_prefix', { when: formatRelativeTime(row.expiryAlertSentAt, adminT) })}
                          </div>
                        )}
                        {lastAlert && (
                          <div
                            className="mt-0.5 text-[11px]"
                            title={adminT('platform_admin.verified_caller.most_recent_dispatch_title', {
                              source: lastAlert.source === 'admin_reissue'
                                ? adminT('platform_admin.verified_caller.dispatch_source_manual')
                                : adminT('platform_admin.verified_caller.dispatch_source_scheduler'),
                              sent: lastAlert.sentCount,
                              bounced: lastAlert.bouncedCount,
                              failed: lastAlert.failedCount,
                              skipped: lastAlert.skippedCount,
                            })}
                          >
                            <span className="text-success">
                              {lastAlert.sentCount}↑
                            </span>
                            {lastAlert.bouncedCount > 0 && (
                              <span className="ml-1 text-danger">
                                {lastAlert.bouncedCount}✗
                              </span>
                            )}
                            {lastAlert.failedCount > 0 && (
                              <span className="ml-1 text-warning">
                                {lastAlert.failedCount}!
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        <button
                          onClick={() => {
                            if (
                              window.confirm(
                                adminT('platform_admin.verified_caller.confirm_reissue', { phone: row.phoneNumber, tenant: row.tenantName ?? adminT('platform_admin.verified_caller.confirm_reissue_no_tenant') }),
                              )
                            ) {
                              reissueAlert.mutate(row);
                            }
                          }}
                          disabled={isPending}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-surface hover:bg-surface-secondary text-text-primary text-xs disabled:opacity-50"
                          title={adminT('platform_admin.verified_caller.send_alert_title')}
                        >
                          <Send className="h-3 w-3" />
                          {isPending ? adminT('platform_admin.verified_caller.sending') : adminT('platform_admin.verified_caller.reissue_alert')}
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-b border-border bg-surface-secondary/40">
                        <td colSpan={7} className="p-0">
                          <VerifiedCallerAlertHistory
                            tenantId={row.tenantId}
                            callerId={row.id}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Build the same tenant-scoped admin deep link the reconnect/sync-error
 * tables use, so all three "open tenant" affordances behave identically.
 */
function buildTenantConnectorHref(
  tenantId: string,
  integrationId: string,
  tenantSlug: string | null,
): string {
  // Tenant-scoped, read-only connector view for platform admins. The link
  // lands on `/admin/analytics/tenants/:tenantId/connectors`, which is
  // backed by the platform-admin endpoint
  // `GET /platform/tenants/:tenantId/connectors` — no impersonation token
  // swap required, and every load is recorded in `audit_logs`. The
  // `integration` query param tells the landing page which row to scroll
  // to and highlight; `slug` is carried along as a breadcrumb hint for
  // support links/previews. Shared between the Connector Health and
  // Expiring soon tables so URL formatting only lives in one place.
  return (
    `/admin/analytics/tenants/${encodeURIComponent(tenantId)}/connectors` +
    `?integration=${encodeURIComponent(integrationId)}` +
    (tenantSlug ? `&slug=${encodeURIComponent(tenantSlug)}` : '')
  );
}

/**
 * Proactive triage table for connectors whose OAuth token is still valid
 * but expires within the configured window (default 48h). Lets ops nudge
 * customers before the worker actually starts failing.
 */
function ConnectorExpiringSoonTable({
  rows,
  windowHours,
}: {
  rows: ConnectorExpiringSoonRow[];
  windowHours: number;
}) {
  const { t: adminT } = useTranslation('admin');
  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Clock className="h-4 w-4 text-warning" />
            {adminT('platform_admin.expiring_soon.title')}
            <span
              className={`ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                rows.length > 0
                  ? 'bg-warning-light text-warning'
                  : 'bg-surface-secondary text-text-muted border border-border'
              }`}
            >
              {rows.length}
            </span>
          </h3>
          <p className="text-xs text-text-muted mt-0.5">
            {adminT('platform_admin.expiring_soon.subtitle', { hours: windowHours })}
          </p>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-text-muted">
          {adminT('platform_admin.expiring_soon.empty', { hours: windowHours })}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.expiring_soon.header_tenant')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.expiring_soon.header_connector')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.expiring_soon.header_token_age')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.expiring_soon.header_expires_in')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.expiring_soon.header_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const href = buildTenantConnectorHref(r.tenantId, r.integrationId, r.tenantSlug);
                return (
                  <tr key={r.integrationId} className="border-b border-border last:border-0 align-top">
                    <td className="px-4 py-2 text-xs">
                      <div className="font-medium">{r.tenantName ?? adminT('platform_admin.common.em_dash')}</div>
                      {r.tenantSlug && (
                        <div className="text-text-muted font-mono">{r.tenantSlug}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <div className="font-medium capitalize">{r.name ?? r.provider}</div>
                      <div className="text-text-muted">
                        <span className="capitalize">{r.integrationType}</span>
                        {r.provider && r.provider !== r.name && (
                          <span className="font-mono"> · {r.provider}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs whitespace-nowrap">
                      <div
                        className="text-text-muted"
                        title={r.tokenIssuedAt ? new Date(r.tokenIssuedAt).toLocaleString() : adminT('platform_admin.common.never')}
                      >
                        {formatRelativeTime(r.tokenIssuedAt, adminT)}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs whitespace-nowrap">
                      <div
                        className="text-warning font-medium"
                        title={r.tokenExpiresAt ? new Date(r.tokenExpiresAt).toLocaleString() : adminT('platform_admin.common.unknown')}
                      >
                        {formatExpiresIn(r.expiresInMs, adminT)}
                      </div>
                      {r.tokenExpiresAt && (
                        <div className="text-text-muted text-[10px] mt-0.5">
                          {new Date(r.tokenExpiresAt).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-surface-secondary hover:bg-surface text-text-primary text-xs"
                        title={adminT('platform_admin.connector_attention.open_tenant_title')}
                      >
                        <ExternalLink className="h-3 w-3" /> {adminT('platform_admin.connector_attention.open_tenant_connectors')}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ConnectorAttentionTable({
  title,
  emptyText,
  rows,
  accent,
}: {
  title: string;
  emptyText: string;
  rows: ConnectorHealthRow[];
  accent: 'amber' | 'red';
}) {
  const { t: adminT } = useTranslation('admin');
  const accentClasses = accent === 'amber'
    ? 'bg-warning-light text-warning'
    : 'bg-danger-light text-danger';
  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h3 className="font-semibold text-sm">
          {title}{' '}
          <span className={`ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${accentClasses}`}>
            {rows.length}
          </span>
        </h3>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-text-muted">{emptyText}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.connector_attention.header_tenant')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.connector_attention.header_connector')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.connector_attention.header_last_sync')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.connector_attention.header_first_failed')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.connector_attention.header_last_error')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.connector_attention.header_alerts')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.connector_attention.header_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <ConnectorAttentionRow key={c.integrationId} row={c} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ConnectorAttentionRow({ row: c }: { row: ConnectorHealthRow }) {
  const { t: adminT } = useTranslation('admin');
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  const refreshMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; message?: string; error?: string }>(
        `/platform/connector-health/integrations/${c.tenantId}/${c.integrationId}/refresh`,
        {},
      ),
    onSuccess: (data) => {
      setFeedback({ kind: 'success', message: data.message ?? adminT('platform_admin.connector_attention.refresh_success_default') });
      queryClient.invalidateQueries({ queryKey: ['platform-connector-health'] });
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      setFeedback({ kind: 'error', message: detail || adminT('platform_admin.connector_attention.refresh_failed_default') });
    },
  });

  const alertMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; message?: string; emailedRecipients?: number; status?: string; error?: string }>(
        `/platform/connector-health/integrations/${c.tenantId}/${c.integrationId}/alert`,
        {},
      ),
    onSuccess: (data) => {
      setFeedback({ kind: 'success', message: data.message ?? adminT('platform_admin.connector_attention.alert_success_default') });
      queryClient.invalidateQueries({ queryKey: ['platform-connector-health'] });
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      setFeedback({ kind: 'error', message: detail || adminT('platform_admin.connector_attention.alert_failed_default') });
    },
  });

  const truncated = c.lastSyncError && c.lastSyncError.length > 140
    ? `${c.lastSyncError.slice(0, 140)}…`
    : c.lastSyncError;
  // Backend supplies `refreshable` (computed from the same isRefreshableProvider
  // helper the POST /refresh endpoint uses), so the UI doesn't need its own
  // provider list. Default to true on older payloads — the server-side
  // endpoint will return a clean 400 for non-refreshable providers anyway.
  const refreshable = c.refreshable ?? true;
  const refreshing = refreshMutation.isPending;
  const alerting = alertMutation.isPending;
  // Tenant-scoped, read-only connector view for platform admins. URL
  // formatting is centralized in `buildTenantConnectorHref` so this and the
  // Expiring soon table both land on the same audit-logged page.
  const openTenantConnectorsHref = buildTenantConnectorHref(c.tenantId, c.integrationId, c.tenantSlug);

  return (
    <tr className="border-b border-border last:border-0 align-top">
      <td className="px-4 py-2 text-xs">
        <div className="font-medium">{c.tenantName ?? adminT('platform_admin.common.em_dash')}</div>
        {c.tenantSlug && (
          <div className="text-text-muted font-mono">{c.tenantSlug}</div>
        )}
      </td>
      <td className="px-4 py-2 text-xs">
        <div className="font-medium capitalize">{c.name ?? c.provider}</div>
        <div className="text-text-muted">
          <span className="capitalize">{c.connectorType}</span>
          {c.provider && c.provider !== c.name && (
            <span className="font-mono"> · {c.provider}</span>
          )}
        </div>
      </td>
      <td className="px-4 py-2 text-xs text-text-muted whitespace-nowrap">
        <span title={c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString() : adminT('platform_admin.common.never')}>
          {formatRelativeTime(c.lastSyncAt, adminT)}
        </span>
      </td>
      <td className="px-4 py-2 text-xs text-text-muted whitespace-nowrap">
        <span title={c.lastSyncErrorAt ? new Date(c.lastSyncErrorAt).toLocaleString() : adminT('platform_admin.common.never')}>
          {formatRelativeTime(c.lastSyncErrorAt, adminT)}
        </span>
      </td>
      <td className="px-4 py-2 text-xs">
        <div
          className="font-mono text-danger break-all max-w-[360px]"
          title={c.lastSyncError ?? ''}
        >
          {truncated ?? adminT('platform_admin.common.em_dash')}
        </div>
      </td>
      <td className="px-4 py-2 text-xs whitespace-nowrap">
        {c.authAlertSentAt ? (
          <span
            className="inline-flex items-center gap-1 text-warning"
            title={adminT('platform_admin.connector_attention.email_sent_title', { time: new Date(c.authAlertSentAt).toLocaleString() })}
          >
            <Mail className="h-3 w-3" /> {formatRelativeTime(c.authAlertSentAt, adminT)}
          </span>
        ) : (
          <span className="text-text-muted">{adminT('platform_admin.connector_attention.sent_email')}</span>
        )}
      </td>
      <td className="px-4 py-2 text-xs">
        <div className="flex flex-col gap-1.5 min-w-[220px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <a
              href={openTenantConnectorsHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-surface-secondary hover:bg-surface text-text-primary text-xs"
              title={adminT('platform_admin.connector_attention.open_tenant_title')}
            >
              <ExternalLink className="h-3 w-3" /> {adminT('platform_admin.connector_attention.open_tenant_connectors')}
            </a>
            <button
              type="button"
              onClick={() => {
                setFeedback(null);
                refreshMutation.mutate();
              }}
              disabled={refreshing || alerting || !refreshable}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-surface-secondary hover:bg-surface text-text-primary text-xs disabled:opacity-50 disabled:cursor-not-allowed"
              title={refreshable
                ? adminT('platform_admin.connector_attention.retry_refresh_title')
                : adminT('platform_admin.connector_attention.retry_unsupported_title', { provider: c.provider })}
            >
              <RotateCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? adminT('platform_admin.connector_attention.retrying') : adminT('platform_admin.connector_attention.retry_refresh')}
            </button>
            <button
              type="button"
              onClick={() => {
                setFeedback(null);
                alertMutation.mutate();
              }}
              disabled={refreshing || alerting}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-surface-secondary hover:bg-surface text-text-primary text-xs disabled:opacity-50 disabled:cursor-not-allowed"
              title={adminT('platform_admin.connector_attention.send_email_title')}
            >
              <Send className={`h-3 w-3 ${alerting ? 'animate-pulse' : ''}`} />
              {alerting ? adminT('platform_admin.connector_attention.sending') : adminT('platform_admin.connector_attention.send_email')}
            </button>
          </div>
          {feedback && (
            <div
              className={`text-xs px-2 py-1 rounded border max-w-[320px] break-words ${
                feedback.kind === 'success'
                  ? 'bg-success-light border-success/40 text-success'
                  : 'bg-danger-light border-danger/40 text-danger'
              }`}
              role="status"
            >
              {feedback.message}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

function formatNextAttempt(iso: string | null, t: (k: string, opts?: any) => string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = date.getTime() - Date.now();
  const absMin = Math.floor(Math.abs(diffMs) / 60_000);
  const absHr = Math.floor(absMin / 60);
  const absDays = Math.floor(absHr / 24);
  let label: string;
  if (absMin < 1) label = 'less than a minute';
  else if (absMin < 60) label = `${absMin}m`;
  else if (absHr < 24) label = `${absHr}h ${absMin - absHr * 60}m`;
  else label = `${absDays}d ${absHr - absDays * 24}h`;
  return diffMs >= 0 ? `in ${label}` : `${label} ago`;
}

function StuckOutboxEventsPanel({
  rows,
  summary,
}: {
  rows: StuckOutboxEventRow[];
  summary: StuckOutboxSummary;
}) {
  const { t: adminT } = useTranslation('admin');
  const total = summary.failed + summary.deadLetter;
  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-danger" />
            {adminT('platform_admin.stuck_outbox.title')}
            <span
              className={`ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                total > 0
                  ? 'bg-danger-light text-danger'
                  : 'bg-surface-secondary text-text-muted border border-border'
              }`}
            >
              {total}
            </span>
            {summary.deadLetter > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-danger-light text-danger">
                {adminT('platform_admin.stuck_outbox.dead_letter_pill', { count: summary.deadLetter })}
              </span>
            )}
            {summary.failed > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-warning-light text-warning">
                {adminT('platform_admin.stuck_outbox.retrying_pill', { count: summary.failed })}
              </span>
            )}
          </h3>
          <p className="text-xs text-text-muted mt-0.5">
            {adminT('platform_admin.stuck_outbox.subtitle')}
          </p>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-text-muted">
          {adminT('platform_admin.stuck_outbox.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.stuck_outbox.header_tenant')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.stuck_outbox.header_event')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.stuck_outbox.header_status')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.stuck_outbox.header_attempts')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.stuck_outbox.header_next_retry')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.stuck_outbox.header_last_error')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.stuck_outbox.header_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <StuckOutboxEventRowView key={r.id} row={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StuckOutboxEventRowView({ row }: { row: StuckOutboxEventRow }) {
  const { t: adminT } = useTranslation('admin');
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );

  const retryMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; message?: string; error?: string }>(
        `/platform/connector-health/outbox/${row.tenantId}/${row.id}/retry`,
        {},
      ),
    onSuccess: (data) => {
      setFeedback({ kind: 'success', message: data.message ?? adminT('platform_admin.stuck_outbox.requeued_default') });
      queryClient.invalidateQueries({ queryKey: ['platform-connector-health'] });
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      setFeedback({ kind: 'error', message: detail || adminT('platform_admin.stuck_outbox.requeue_failed_default') });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; message?: string; error?: string }>(
        `/platform/connector-health/outbox/${row.tenantId}/${row.id}/archive`,
        {},
      ),
    onSuccess: (data) => {
      setFeedback({ kind: 'success', message: data.message ?? adminT('platform_admin.stuck_outbox.archived_default') });
      queryClient.invalidateQueries({ queryKey: ['platform-connector-health'] });
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      setFeedback({ kind: 'error', message: detail || adminT('platform_admin.stuck_outbox.archive_failed_default') });
    },
  });

  const truncatedError =
    row.lastError && row.lastError.length > 200
      ? `${row.lastError.slice(0, 200)}…`
      : row.lastError;
  const isDeadLetter = row.status === 'dead_letter';
  const retrying = retryMutation.isPending;
  const archiving = archiveMutation.isPending;
  const integrationLabel =
    row.integrationName ?? row.integrationProvider ?? row.integrationType ?? null;

  return (
    <tr className="border-b border-border last:border-0 align-top">
      <td className="px-4 py-2 text-xs">
        <div className="font-medium">{row.tenantName ?? adminT('platform_admin.common.em_dash')}</div>
        {row.tenantSlug && (
          <div className="text-text-muted font-mono">{row.tenantSlug}</div>
        )}
      </td>
      <td className="px-4 py-2 text-xs">
        <div className="font-medium font-mono">{row.eventType}</div>
        {integrationLabel && (
          <div className="text-text-muted">
            <span className="capitalize">{integrationLabel}</span>
            {row.integrationProvider
              && row.integrationProvider !== integrationLabel
              && (
                <span className="font-mono"> · {row.integrationProvider}</span>
              )}
          </div>
        )}
      </td>
      <td className="px-4 py-2 text-xs">
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
            isDeadLetter
              ? 'bg-danger-light text-danger'
              : 'bg-warning-light text-warning'
          }`}
        >
          {isDeadLetter ? adminT('platform_admin.stuck_outbox.status_dead_letter') : adminT('platform_admin.stuck_outbox.status_failed')}
        </span>
      </td>
      <td className="px-4 py-2 text-xs whitespace-nowrap">
        <span
          className={
            row.attempts >= row.maxAttempts
              ? 'text-danger font-medium'
              : 'text-text-primary'
          }
        >
          {row.attempts} / {row.maxAttempts}
        </span>
      </td>
      <td className="px-4 py-2 text-xs whitespace-nowrap">
        {isDeadLetter ? (
          <span className="text-text-muted">{adminT('platform_admin.stuck_outbox.no_auto_retry')}</span>
        ) : (
          <span
            className="text-text-muted"
            title={row.nextAttemptAt ? new Date(row.nextAttemptAt).toLocaleString() : adminT('platform_admin.common.unknown')}
          >
            {formatNextAttempt(row.nextAttemptAt, adminT)}
          </span>
        )}
      </td>
      <td className="px-4 py-2 text-xs text-danger font-mono break-all max-w-[360px]">
        {truncatedError ?? adminT('platform_admin.common.em_dash')}
      </td>
      <td className="px-4 py-2 text-xs">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setFeedback(null);
                retryMutation.mutate();
              }}
              disabled={retrying || archiving}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-surface-secondary hover:bg-surface text-text-primary text-xs disabled:opacity-50"
              title={adminT('platform_admin.stuck_outbox.retry_now_title')}
            >
              <RotateCw className={`h-3 w-3 ${retrying ? 'animate-spin' : ''}`} />
              {adminT('platform_admin.stuck_outbox.retry_now')}
            </button>
            {isDeadLetter && (
              <button
                type="button"
                onClick={() => {
                  setFeedback(null);
                  archiveMutation.mutate();
                }}
                disabled={archiving || retrying}
                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-surface-secondary hover:bg-surface text-text-primary text-xs disabled:opacity-50"
                title={adminT('platform_admin.stuck_outbox.mark_resolved_title')}
              >
                <Archive className="h-3 w-3" />
                {adminT('platform_admin.stuck_outbox.mark_resolved')}
              </button>
            )}
          </div>
          {feedback && (
            <div
              className={`text-[11px] ${
                feedback.kind === 'success'
                  ? 'text-success'
                  : 'text-danger'
              }`}
            >
              {feedback.message}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1_000) return `${ms}ms`;
  const sec = ms / 1_000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 2 : 1)}s`;
  const min = sec / 60;
  return `${min.toFixed(min < 10 ? 1 : 0)}m`;
}

function CrmRevalidationMetricsPanel({ metrics }: { metrics: CrmRevalidationMetrics | null }) {
  const { t: adminT } = useTranslation('admin');
  const [showCycles, setShowCycles] = useState(false);
  const [showTenants, setShowTenants] = useState(false);

  if (!metrics) {
    return (
      <div className="bg-surface border border-border rounded-xl p-4">
        <h3 className="font-semibold text-sm flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          CRM caller-identity revalidation
        </h3>
        <p className="text-xs text-text-muted mt-1">
          Metrics unavailable. The background sweep has not reported counters yet, or the
          metrics module failed to load.
        </p>
      </div>
    );
  }

  const { totals, lastCycle, recentCycles, perTenant } = metrics;
  const totalScrubbed = totals.staleScrubbed;
  const totalFailed = totals.failed;
  const tenantsWithFailures = perTenant.filter((t) => t.failed > 0);

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            CRM caller-identity revalidation
            {totalFailed > 0 && (
              <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-danger-light text-danger">
                {totalFailed} failed
              </span>
            )}
          </h3>
          <p className="text-xs text-text-muted mt-0.5">
            Background sweep that re-probes cached CRM IDs against the upstream provider and
            scrubs stale entries. Counters are in-memory and reset whenever the admin API
            restarts (since {formatRelativeTime(metrics.startedAt, adminT)}).
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 p-4">
        <div className="bg-surface-secondary rounded-lg p-3">
          <div className="text-xs text-text-muted">Cycles run</div>
          <div className="text-2xl font-bold">{totals.cyclesRun}</div>
          {totals.cyclesThrew > 0 && (
            <div className="text-xs text-danger mt-0.5">
              {totals.cyclesThrew} threw
            </div>
          )}
        </div>
        <div className="bg-surface-secondary rounded-lg p-3">
          <div className="text-xs text-text-muted">Scanned</div>
          <div className="text-2xl font-bold">{totals.scanned}</div>
        </div>
        <div className="bg-surface-secondary rounded-lg p-3">
          <div className="text-xs text-text-muted">Validated</div>
          <div className="text-2xl font-bold text-success">
            {totals.validated}
          </div>
        </div>
        <div className="bg-surface-secondary rounded-lg p-3">
          <div className="text-xs text-text-muted" title="Cached IDs that no longer existed upstream and were cleared">
            Stale scrubbed
          </div>
          <div className={`text-2xl font-bold ${totalScrubbed > 0 ? 'text-warning' : ''}`}>
            {totalScrubbed}
          </div>
        </div>
        <div className="bg-surface-secondary rounded-lg p-3">
          <div className="text-xs text-text-muted" title="Rows whose tenant has no enabled CRM connector — bumped to avoid churn">
            Skipped (no config)
          </div>
          <div className="text-2xl font-bold">{totals.skippedNoConfig}</div>
        </div>
        <div className="bg-surface-secondary rounded-lg p-3">
          <div className="text-xs text-text-muted">Failed</div>
          <div className={`text-2xl font-bold ${totalFailed > 0 ? 'text-danger' : ''}`}>
            {totalFailed}
          </div>
        </div>
      </div>

      {lastCycle && (
        <div className="px-4 pb-3 text-xs text-text-muted">
          Last cycle <span title={new Date(lastCycle.finishedAt).toLocaleString()}>
            {formatRelativeTime(lastCycle.finishedAt, adminT)}
          </span>
          : scanned <strong>{lastCycle.scanned}</strong>, validated <strong>{lastCycle.validated}</strong>,
          scrubbed <strong>{lastCycle.staleScrubbed}</strong>, failed{' '}
          <strong className={lastCycle.failed > 0 ? 'text-danger' : ''}>
            {lastCycle.failed}
          </strong>{' '}
          ({formatDurationMs(lastCycle.durationMs)})
          {lastCycle.threw && (
            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-danger-light text-danger">
              cycle threw
            </span>
          )}
        </div>
      )}

      <div className="px-4 pb-4 flex flex-wrap gap-2">
        <button
          onClick={() => setShowCycles((v) => !v)}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-surface-secondary"
        >
          {showCycles ? 'Hide' : 'Show'} cycle history ({recentCycles.length})
        </button>
        <button
          onClick={() => setShowTenants((v) => !v)}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-surface-secondary"
          disabled={perTenant.length === 0}
        >
          {showTenants ? 'Hide' : 'Show'} per-tenant breakdown ({perTenant.length}
          {metrics.perTenantTracked >= metrics.perTenantLimit ? '+' : ''})
        </button>
        {tenantsWithFailures.length > 0 && (
          <span className="text-xs px-2 py-1 rounded bg-danger-light text-danger">
            {tenantsWithFailures.length} tenant{tenantsWithFailures.length === 1 ? '' : 's'} with
            repeated failures
          </span>
        )}
      </div>

      {showCycles && (
        <div className="border-t border-border overflow-x-auto">
          {recentCycles.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-text-muted">
              No cycles have completed yet. The first sweep runs ~5 minutes after admin API
              startup.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-4 py-2 font-medium text-text-muted">When</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Scanned</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Validated</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Scrubbed</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Skipped</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Failed</th>
                  <th className="text-right px-4 py-2 font-medium text-text-muted">Duration</th>
                </tr>
              </thead>
              <tbody>
                {recentCycles.map((c) => (
                  <tr key={`${c.startedAt}-${c.finishedAt}`} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-xs text-text-muted whitespace-nowrap">
                      <span title={new Date(c.finishedAt).toLocaleString()}>
                        {formatRelativeTime(c.finishedAt, adminT)}
                      </span>
                      {c.threw && (
                        <span className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-danger-light text-danger">
                          threw
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{c.scanned}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-success">
                      {c.validated}
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums ${c.staleScrubbed > 0 ? 'text-warning font-medium' : ''}`}>
                      {c.staleScrubbed}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{c.skippedNoConfig}</td>
                    <td className={`px-4 py-2 text-right tabular-nums ${c.failed > 0 ? 'text-danger font-medium' : ''}`}>
                      {c.failed}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                      {formatDurationMs(c.durationMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {showTenants && (
        <div className="border-t border-border overflow-x-auto">
          {perTenant.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-text-muted">
              No per-tenant activity recorded yet.
            </div>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-secondary">
                    <th className="text-left px-4 py-2 font-medium text-text-muted">Tenant</th>
                    <th className="text-right px-4 py-2 font-medium text-text-muted">Scanned</th>
                    <th className="text-right px-4 py-2 font-medium text-text-muted">Validated</th>
                    <th className="text-right px-4 py-2 font-medium text-text-muted">Scrubbed</th>
                    <th className="text-right px-4 py-2 font-medium text-text-muted">Skipped</th>
                    <th className="text-right px-4 py-2 font-medium text-text-muted">Failed</th>
                    <th className="text-left px-4 py-2 font-medium text-text-muted">Last touched</th>
                  </tr>
                </thead>
                <tbody>
                  {perTenant.map((t) => (
                    <tr key={t.tenantId} className="border-b border-border last:border-0">
                      <td className="px-4 py-2 text-xs font-mono break-all">{t.tenantId}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{t.scanned}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-success">
                        {t.validated}
                      </td>
                      <td className={`px-4 py-2 text-right tabular-nums ${t.staleScrubbed > 0 ? 'text-warning font-medium' : ''}`}>
                        {t.staleScrubbed}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{t.skippedNoConfig}</td>
                      <td className={`px-4 py-2 text-right tabular-nums ${t.failed > 0 ? 'text-danger font-medium' : ''}`}>
                        {t.failed}
                      </td>
                      <td className="px-4 py-2 text-xs text-text-muted whitespace-nowrap">
                        <span title={new Date(t.lastTouchedAt).toLocaleString()}>
                          {formatRelativeTime(t.lastTouchedAt, adminT)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {metrics.perTenantTracked >= metrics.perTenantLimit && (
                <div className="px-4 py-2 text-xs text-text-muted border-t border-border">
                  Showing the most recent {metrics.perTenantLimit} tenants. Older entries are
                  evicted to bound memory.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function formatExpiresIn(ms: number | null, t: (k: string, opts?: any) => string): string {
  if (ms === null) return t('platform_admin.common.unknown');
  const abs = Math.abs(ms);
  const min = Math.floor(abs / 60_000);
  const hr = Math.floor(min / 60);
  const days = Math.floor(hr / 24);
  let label: string;
  if (min < 1) label = t('platform_admin.outbox_dlq.less_than_a_minute');
  else if (min < 60) label = `${min}m`;
  else if (hr < 24) label = `${hr}h ${min - hr * 60}m`;
  else label = `${days}d ${hr - days * 24}h`;
  return ms >= 0
    ? t('platform_admin.outbox_dlq.in_label', { label })
    : t('platform_admin.outbox_dlq.ago_label', { label });
}

function tokenStatusBadgeClasses(status: ConnectorTokenHealthStatus): string {
  switch (status) {
    case 'healthy':
      return 'bg-success-light text-success';
    case 'expiring':
      return 'bg-warning-light text-warning';
    case 'expired':
    case 'needs_reconnect':
      return 'bg-danger-light text-danger';
    default:
      return 'bg-surface-secondary text-text-muted border border-border';
  }
}

function tokenStatusLabel(status: ConnectorTokenHealthStatus, t: (k: string) => string): string {
  switch (status) {
    case 'healthy': return 'Healthy';
    case 'expiring': return 'Expiring soon';
    case 'expired': return 'Expired';
    case 'needs_reconnect': return 'Reconnect needed';
    default: return 'Unknown';
  }
}

type TokenHealthSortKey = 'expiring' | 'lastRefresh' | 'tenant';
type TokenHealthFilter = 'all' | 'attention' | 'expiring' | 'stale' | 'healthy';

function ConnectorTokenHealthPanel({
  rows,
  refreshIntervalMs,
  expiringHorizonMs,
  staleCycleThreshold,
}: {
  rows: ConnectorTokenHealthRow[];
  refreshIntervalMs: number;
  expiringHorizonMs: number;
  staleCycleThreshold: number;
}) {
  const { t: adminT } = useTranslation('admin');
  const [sortKey, setSortKey] = useState<TokenHealthSortKey>('expiring');
  const [filter, setFilter] = useState<TokenHealthFilter>('all');

  const filtered = rows.filter((r) => {
    switch (filter) {
      case 'attention':
        return r.status === 'expired' || r.status === 'needs_reconnect' || r.stale;
      case 'expiring':
        return r.status === 'expiring' || r.status === 'expired';
      case 'stale':
        return r.stale;
      case 'healthy':
        return r.status === 'healthy';
      default:
        return true;
    }
  });

  // Sort by "expiring soonest" puts unknown/null expiry at the end so ops
  // see actionable rows first; tenant sort is a stable alphabetical fallback.
  const sorted = [...filtered].sort((a, b) => {
    if (sortKey === 'expiring') {
      const aMs = a.expiresInMs;
      const bMs = b.expiresInMs;
      if (aMs === null && bMs === null) return 0;
      if (aMs === null) return 1;
      if (bMs === null) return -1;
      return aMs - bMs;
    }
    if (sortKey === 'lastRefresh') {
      const aT = a.tokenIssuedAt ? new Date(a.tokenIssuedAt).getTime() : 0;
      const bT = b.tokenIssuedAt ? new Date(b.tokenIssuedAt).getTime() : 0;
      return bT - aT;
    }
    const aName = (a.tenantName ?? a.tenantSlug ?? a.tenantId).toLowerCase();
    const bName = (b.tenantName ?? b.tenantSlug ?? b.tenantId).toLowerCase();
    return aName.localeCompare(bName);
  });

  const expiringSoonCount = rows.filter(
    (r) => r.status === 'expiring' || r.status === 'expired',
  ).length;
  const staleCount = rows.filter((r) => r.stale).length;
  const horizonHours = Math.round(expiringHorizonMs / (60 * 60 * 1000));
  const cycleMinutes = Math.round(refreshIntervalMs / 60_000);

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" /> {adminT('platform_admin.token_health.title')}
            <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-surface-secondary text-text-primary border border-border">
              {rows.length}
            </span>
            {expiringSoonCount > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-warning-light text-warning">
                {adminT('platform_admin.token_health.expiring_pill', { count: expiringSoonCount })}
              </span>
            )}
            {staleCount > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-danger-light text-danger">
                {adminT('platform_admin.token_health.stale_pill_count', { count: staleCount })}
              </span>
            )}
          </h3>
          <p className="text-xs text-text-muted mt-0.5">
            {adminT('platform_admin.token_health.long_subtitle', { hours: horizonHours, minutes: cycleMinutes, cycles: staleCycleThreshold })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="text-text-muted">{adminT('platform_admin.token_health.filter_label')}</label>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as TokenHealthFilter)}
            className="border border-border rounded px-2 py-1 bg-surface text-text-primary"
          >
            <option value="all">{adminT('platform_admin.token_health.filter_all')}</option>
            <option value="attention">{adminT('platform_admin.token_health.filter_attention')}</option>
            <option value="expiring">{adminT('platform_admin.token_health.filter_expiring')}</option>
            <option value="stale">{adminT('platform_admin.token_health.filter_stale')}</option>
            <option value="healthy">{adminT('platform_admin.token_health.filter_healthy')}</option>
          </select>
          <label className="text-text-muted ml-2">{adminT('platform_admin.token_health.sort_label')}</label>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as TokenHealthSortKey)}
            className="border border-border rounded px-2 py-1 bg-surface text-text-primary"
          >
            <option value="expiring">{adminT('platform_admin.token_health.sort_expiring')}</option>
            <option value="lastRefresh">{adminT('platform_admin.token_health.sort_last_refresh')}</option>
            <option value="tenant">{adminT('platform_admin.token_health.sort_tenant')}</option>
          </select>
        </div>
      </div>
      {sorted.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-text-muted">
          {rows.length === 0
            ? adminT('platform_admin.token_health.empty_no_oauth')
            : adminT('platform_admin.token_health.empty_no_filter_match')}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.token_health.header_tenant')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.token_health.header_connector')}</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">
                  <button
                    type="button"
                    onClick={() => setSortKey('lastRefresh')}
                    className={`inline-flex items-center gap-1 hover:text-text-primary ${sortKey === 'lastRefresh' ? 'text-text-primary' : ''}`}
                  >
                    {adminT('platform_admin.token_health.header_last_refresh')}
                    {sortKey === 'lastRefresh' && <ArrowUpDown className="h-3 w-3" />}
                  </button>
                </th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">
                  <button
                    type="button"
                    onClick={() => setSortKey('expiring')}
                    className={`inline-flex items-center gap-1 hover:text-text-primary ${sortKey === 'expiring' ? 'text-text-primary' : ''}`}
                  >
                    {adminT('platform_admin.token_health.header_expires')}
                    {sortKey === 'expiring' && <ArrowUpDown className="h-3 w-3" />}
                  </button>
                </th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">{adminT('platform_admin.token_health.header_status')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.integrationId} className="border-b border-border last:border-0 align-top">
                  <td className="px-4 py-2 text-xs">
                    <div className="font-medium">{r.tenantName ?? adminT('platform_admin.common.em_dash')}</div>
                    {r.tenantSlug && (
                      <div className="text-text-muted font-mono">{r.tenantSlug}</div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    <div className="font-medium capitalize">{r.name ?? r.provider}</div>
                    <div className="text-text-muted">
                      <span className="capitalize">{r.integrationType}</span>
                      {r.provider && r.provider !== r.name && (
                        <span className="font-mono"> · {r.provider}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-xs whitespace-nowrap">
                    <div
                      className="text-text-muted"
                      title={r.tokenIssuedAt ? new Date(r.tokenIssuedAt).toLocaleString() : adminT('platform_admin.common.never')}
                    >
                      {formatRelativeTime(r.tokenIssuedAt, adminT)}
                    </div>
                    {r.cyclesSinceRefresh !== null && r.cyclesSinceRefresh > 0 && (
                      <div className="text-text-muted text-[10px] mt-0.5">
                        {adminT('platform_admin.token_health.cycles_since_refresh', { count: r.cyclesSinceRefresh })}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs whitespace-nowrap">
                    <div
                      className={
                        r.expiresInMs !== null && r.expiresInMs < 0
                          ? 'text-danger'
                          : r.expiresInMs !== null && r.expiresInMs <= expiringHorizonMs
                            ? 'text-warning'
                            : 'text-text-muted'
                      }
                      title={r.tokenExpiresAt ? new Date(r.tokenExpiresAt).toLocaleString() : adminT('platform_admin.common.unknown')}
                    >
                      {formatExpiresIn(r.expiresInMs, adminT)}
                    </div>
                    {r.tokenExpiresAt && (
                      <div className="text-text-muted text-[10px] mt-0.5">
                        {new Date(r.tokenExpiresAt).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-1">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${tokenStatusBadgeClasses(r.status)}`}
                      >
                        {tokenStatusLabel(r.status, adminT)}
                      </span>
                      {r.stale && (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-danger-light text-danger"
                          title={adminT('platform_admin.token_health.stale_pill_title', { count: staleCycleThreshold })}
                        >
                          <AlertTriangle className="h-3 w-3" /> {adminT('platform_admin.token_health.stale_label')}
                        </span>
                      )}
                      {r.tokenDecryptFailed && (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-warning-light text-warning"
                          title={adminT('platform_admin.token_health.decrypt_failed_title')}
                        >
                          <ShieldAlert className="h-3 w-3" /> {adminT('platform_admin.token_health.decrypt_failed')}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface CallEventsRetentionRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: 'success' | 'failure';
  retention_days: number;
  ensured_partitions: string[];
  dropped_partitions: string[];
  error_message: string | null;
}

interface CallEventsRetentionPartition {
  name: string;
  lower_bound: string | null;
  upper_bound: string | null;
}

interface CallEventsRetentionResponse {
  retentionDays: number;
  intervalMs: number;
  staleAfterMs: number;
  expected: {
    currentMonthPartition: string;
    nextMonthPartition: string;
  };
  partitions: CallEventsRetentionPartition[];
  partitionsExist: {
    currentMonth: boolean;
    nextMonth: boolean;
  };
  lastRun: CallEventsRetentionRun | null;
  lastSuccessfulRun: CallEventsRetentionRun | null;
  recentRuns: CallEventsRetentionRun[];
  status: {
    healthy: boolean;
    stale: boolean;
    missingNextMonth: boolean;
    lastRunFailed: boolean;
    neverRan: boolean;
    reasons: string[];
  };
}

function formatPartitionDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatRunTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatRelativeAge(iso: string | null, t: (k: string, opts?: any) => string): string {
  if (!iso) return t('platform_admin.common.never');
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return t('platform_admin.common.unknown');
  if (ms < 0) return t('platform_admin.common.just_now');
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t('platform_admin.common.just_now');
  if (minutes < 60) return t('platform_admin.common.minutes_ago', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('platform_admin.common.hours_ago', { count: hours });
  const days = Math.floor(hours / 24);
  return t('platform_admin.common.days_ago', { count: days });
}

function CallEventsRetentionPanel() {
  const { t: adminT } = useTranslation('admin');
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-call-events-retention'],
    queryFn: () =>
      api.get<CallEventsRetentionResponse>('/platform/call-events-retention'),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-text-muted">
        {adminT('platform_admin.retention.loading')}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-danger">
        {adminT('platform_admin.retention.load_failed', { error: error ? (error as Error).message : adminT('platform_admin.common.no_data') })}
      </div>
    );
  }

  const { status, lastRun, lastSuccessfulRun, recentRuns, partitions, expected, partitionsExist } = data;

  const headerToneClass = status.healthy
    ? 'bg-success-light border-success/40'
    : 'bg-danger-light border-danger/40';
  const headerIcon = status.healthy ? (
    <CheckCircle className="h-5 w-5 text-success" />
  ) : (
    <AlertTriangle className="h-5 w-5 text-danger" />
  );
  const headerLabel = status.healthy
    ? adminT('platform_admin.retention.header_healthy')
    : adminT('platform_admin.retention.header_attention');

  return (
    <div className="space-y-4">
      <div className={`border rounded-xl p-4 flex items-start justify-between gap-4 ${headerToneClass}`}>
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex-shrink-0 mt-0.5">{headerIcon}</div>
          <div className="min-w-0">
            <h2 className="font-semibold flex items-center gap-2">
              <Database className="h-4 w-4" /> {headerLabel}
            </h2>
            <p className="text-xs text-text-muted mt-1">
              {adminT('platform_admin.retention.subtitle', { days: data.retentionDays })}
            </p>
            {status.reasons.length > 0 && (
              <ul className="mt-2 text-xs text-danger list-disc list-inside space-y-0.5">
                {status.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="p-1.5 rounded hover:bg-surface-secondary text-text-muted hover:text-text-primary disabled:opacity-50 flex-shrink-0"
          title={adminT('platform_admin.common.refresh_title')}
        >
          <RotateCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Clock}
          label={adminT('platform_admin.retention.stat_last_cycle')}
          value={lastSuccessfulRun ? formatRelativeAge(lastSuccessfulRun.finished_at ?? lastSuccessfulRun.started_at, adminT) : adminT('platform_admin.common.never')}
          sub={
            lastSuccessfulRun
              ? formatRunTimestamp(lastSuccessfulRun.finished_at ?? lastSuccessfulRun.started_at)
              : adminT('platform_admin.retention.stat_no_cycle')
          }
          tone={status.stale ? 'warning' : undefined}
        />
        <StatCard
          icon={Database}
          label={adminT('platform_admin.retention.stat_partitions')}
          value={String(partitions.length)}
          sub={adminT('platform_admin.retention.stat_partitions_sub', { days: data.retentionDays })}
        />
        <StatCard
          icon={partitionsExist.currentMonth ? CheckCircle : AlertTriangle}
          label={adminT('platform_admin.retention.stat_current_month')}
          value={partitionsExist.currentMonth ? adminT('platform_admin.retention.stat_ready') : adminT('platform_admin.retention.stat_missing')}
          sub={expected.currentMonthPartition}
          tone={partitionsExist.currentMonth ? undefined : 'warning'}
        />
        <StatCard
          icon={partitionsExist.nextMonth ? CheckCircle : AlertTriangle}
          label={adminT('platform_admin.retention.stat_next_month')}
          value={partitionsExist.nextMonth ? adminT('platform_admin.retention.stat_ready') : adminT('platform_admin.retention.stat_missing')}
          sub={expected.nextMonthPartition}
          tone={partitionsExist.nextMonth ? undefined : 'warning'}
        />
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="font-semibold text-sm">{adminT('platform_admin.retention.partitions_title')}</h3>
          <span className="text-xs text-text-muted">{adminT('platform_admin.retention.partitions_total', { count: partitions.length })}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">{adminT('platform_admin.retention.header_partition')}</th>
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">{adminT('platform_admin.retention.header_range_start')}</th>
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">{adminT('platform_admin.retention.header_range_end')}</th>
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">{adminT('platform_admin.retention.header_role')}</th>
              </tr>
            </thead>
            <tbody>
              {partitions.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center py-8 text-text-muted">
                    {adminT('platform_admin.retention.empty_partitions')}
                  </td>
                </tr>
              ) : (
                partitions.map((p) => {
                  const role =
                    p.name === expected.currentMonthPartition
                      ? adminT('platform_admin.retention.role_current')
                      : p.name === expected.nextMonthPartition
                        ? adminT('platform_admin.retention.role_next')
                        : '';
                  return (
                    <tr key={p.name} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 font-mono text-xs">{p.name}</td>
                      <td className="px-4 py-2.5 text-text-muted">{formatPartitionDate(p.lower_bound)}</td>
                      <td className="px-4 py-2.5 text-text-muted">{formatPartitionDate(p.upper_bound)}</td>
                      <td className="px-4 py-2.5">
                        {role && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary">
                            {role}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="font-semibold text-sm">{adminT('platform_admin.retention.runs_title')}</h3>
          <span className="text-xs text-text-muted">{adminT('platform_admin.retention.runs_showing', { count: recentRuns.length })}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">{adminT('platform_admin.retention.header_started')}</th>
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">{adminT('platform_admin.retention.header_status')}</th>
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">{adminT('platform_admin.retention.header_ensured')}</th>
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">{adminT('platform_admin.retention.header_dropped')}</th>
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">{adminT('platform_admin.retention.header_notes')}</th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-text-muted">
                    {adminT('platform_admin.retention.empty_runs')}
                  </td>
                </tr>
              ) : (
                recentRuns.map((run) => (
                  <tr key={run.id} className="border-b border-border last:border-0 align-top">
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <div>{formatRunTimestamp(run.started_at)}</div>
                      <div className="text-xs text-text-muted">{formatRelativeAge(run.started_at, adminT)}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      {run.status === 'success' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-success-light text-success">
                          <CheckCircle className="h-3 w-3" /> {adminT('platform_admin.retention.success')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-danger-light text-danger">
                          <XCircle className="h-3 w-3" /> {adminT('platform_admin.retention.failure')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {run.ensured_partitions.length === 0 ? (
                        <span className="text-text-muted">{adminT('platform_admin.common.em_dash')}</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {run.ensured_partitions.map((p) => (
                            <code
                              key={p}
                              className="text-xs font-mono px-2 py-0.5 rounded border bg-surface-hover border-border"
                            >
                              {p}
                            </code>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {run.dropped_partitions.length === 0 ? (
                        <span className="text-text-muted">{adminT('platform_admin.common.em_dash')}</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {run.dropped_partitions.map((p) => (
                            <code
                              key={p}
                              className="text-xs font-mono px-2 py-0.5 rounded border bg-warning-light border-warning/30 text-warning"
                            >
                              {p}
                            </code>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      {run.error_message ? (
                        <span className="text-danger break-words">{run.error_message}</span>
                      ) : (
                        <span className="text-text-muted">{adminT('platform_admin.retention.retention_window_days', { days: run.retention_days })}</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {lastRun && lastRun.status === 'failure' && (
          <div className="px-4 py-2.5 border-t border-border bg-danger-light text-xs text-danger">
            {adminT('platform_admin.retention.last_failed_banner', { time: formatRunTimestamp(lastRun.started_at) })}{' '}
            <code className="font-mono">CALL_EVENTS_RETENTION</code>.
          </div>
        )}
      </div>
    </div>
  );
}

interface IntegrationProviderStatus {
  provider: string;
  connectorProvider: string;
  label: string;
  category: string;
  configured: boolean;
  requiredEnv: string[];
  missingEnv: string[];
  optionalEnv: { name: string; set: boolean }[];
  docsUrl: string;
  enabledTenantCount: number;
  totalTenantCount: number;
  attemptedTenantCount: number;
  /**
   * Distinct tenants who tried to start the OAuth flow for this provider
   * but were blocked because the server's credentials weren't configured
   * (Task #919). For un-configured providers this is usually the truest
   * demand signal since by definition no row will ever land in the
   * `integrations` table for them.
   */
  blockedAttemptCount: number;
}

interface IntegrationsStatusResponse {
  providers: IntegrationProviderStatus[];
  summary: {
    total: number;
    configured: number;
    missing: number;
    blockedTenantDemand: number;
  };
}

function IntegrationsStatusPanel() {
  const { t: adminT } = useTranslation('admin');
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-integrations-status'],
    queryFn: () => api.get<IntegrationsStatusResponse>('/platform/integrations-status'),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-text-muted">
        {adminT('platform_admin.integrations_panel.loading')}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-danger">
        {adminT('platform_admin.integrations_panel.load_failed', { error: error ? (error as Error).message : adminT('platform_admin.common.no_data') })}
      </div>
    );
  }

  const grouped = data.providers.reduce<Record<string, IntegrationProviderStatus[]>>((acc, p) => {
    (acc[p.category] ||= []).push(p);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-border rounded-xl p-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <Plug className="h-4 w-4 text-primary" /> {adminT('platform_admin.integrations_panel.title')}
          </h2>
          <p className="text-xs text-text-muted mt-1">
            {adminT('platform_admin.integrations_panel.subtitle_prefix')} <code className="font-mono">*_CLIENT_ID</code> /{' '}
            <code className="font-mono">*_CLIENT_SECRET</code> {adminT('platform_admin.integrations_panel.subtitle_suffix')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm text-text-muted">
            <span className="font-semibold text-success">{data.summary.configured}</span>
            {' / '}
            {adminT('platform_admin.integrations_panel.configured_count_suffix', { total: data.summary.total })}
          </div>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="p-1.5 rounded hover:bg-surface-secondary text-text-muted hover:text-text-primary disabled:opacity-50"
            title={adminT('platform_admin.common.refresh_title')}
          >
            <RotateCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {data.summary.missing > 0 && (
        <div className="bg-warning-light border border-warning/40 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-warning flex-shrink-0 mt-0.5" />
          <div className="text-sm text-warning">
            <div className="font-medium">
              {adminT('platform_admin.integrations_panel.missing', { count: data.summary.missing })}
            </div>
            <p className="text-xs mt-1 opacity-80">
              {adminT('platform_admin.integrations_panel.missing_explainer')}
            </p>
            {data.summary.blockedTenantDemand > 0 && (
              <p className="text-xs mt-1 font-medium">
                {adminT('platform_admin.integrations_panel.blocked_demand', { count: data.summary.blockedTenantDemand })}
              </p>
            )}
          </div>
        </div>
      )}

      {Object.entries(grouped).map(([category, providers]) => (
        <div key={category} className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-2 bg-surface-secondary/50 border-b border-border">
            <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">{category}</h3>
          </div>
          <div className="divide-y divide-border">
            {[...providers]
              .sort((a, b) => {
                const aDemand = Math.max(
                  a.enabledTenantCount,
                  a.attemptedTenantCount,
                  a.blockedAttemptCount,
                );
                const bDemand = Math.max(
                  b.enabledTenantCount,
                  b.attemptedTenantCount,
                  b.blockedAttemptCount,
                );
                if (a.configured !== b.configured) return a.configured ? 1 : -1;
                return bDemand - aDemand;
              })
              .map((p) => (
              <div key={p.provider} className="px-4 py-4 flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{p.label}</span>
                    {p.configured ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-success-light text-success">
                        <CheckCircle className="h-3 w-3" /> {adminT('platform_admin.integrations_panel.configured_pill')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-danger-light text-danger">
                        <XCircle className="h-3 w-3" /> {adminT('platform_admin.integrations_panel.missing_pill')}
                      </span>
                    )}
                    {(p.enabledTenantCount > 0 || p.attemptedTenantCount > 0) && (
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                          p.configured
                            ? 'bg-info-light text-info'
                            : 'bg-warning-light text-warning'
                        }`}
                        title={
                          p.configured
                            ? adminT('platform_admin.integrations_panel.active_title_configured', { enabled: p.enabledTenantCount, attempted: p.attemptedTenantCount })
                            : adminT('platform_admin.integrations_panel.active_title_unconfigured', { enabled: p.enabledTenantCount, attempted: p.attemptedTenantCount })
                        }
                      >
                        <Users className="h-3 w-3" />
                        {adminT('platform_admin.integrations_panel.active_pill', { active: p.enabledTenantCount })}
                        {p.attemptedTenantCount > p.enabledTenantCount && (
                          <span className="opacity-80">
                            {' '}{adminT('platform_admin.integrations_panel.active_ever', { count: p.attemptedTenantCount })}
                          </span>
                        )}
                      </span>
                    )}
                    {p.blockedAttemptCount > 0 && (
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-danger-light text-danger"
                        title={adminT('platform_admin.integrations_panel.blocked_attempts_title', { count: p.blockedAttemptCount, vars: p.requiredEnv.join(' / ') })}
                      >
                        <AlertCircle className="h-3 w-3" />
                        {adminT('platform_admin.integrations_panel.blocked_attempts', { count: p.blockedAttemptCount })}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.requiredEnv.map((env) => {
                      const isMissing = p.missingEnv.includes(env);
                      return (
                        <code
                          key={env}
                          className={`text-xs font-mono px-2 py-0.5 rounded border ${
                            isMissing
                              ? 'bg-danger-light text-danger border-danger/30'
                              : 'bg-success-light text-success border-success/30'
                          }`}
                          title={isMissing ? adminT('platform_admin.integrations_panel.env_missing') : adminT('platform_admin.integrations_panel.env_set')}
                        >
                          {env}
                        </code>
                      );
                    })}
                  </div>
                  {p.optionalEnv.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5 items-center">
                      <span className="text-xs text-text-muted">{adminT('platform_admin.integrations_panel.optional_label')}</span>
                      {p.optionalEnv.map((env) => (
                        <code
                          key={env.name}
                          className={`text-xs font-mono px-2 py-0.5 rounded border ${
                            env.set
                              ? 'bg-success-light text-success border-success/30'
                              : 'bg-surface-hover text-text-muted border-border'
                          }`}
                          title={env.set ? adminT('platform_admin.integrations_panel.env_set') : adminT('platform_admin.integrations_panel.env_optional_unset')}
                        >
                          {env.name}
                        </code>
                      ))}
                    </div>
                  )}
                </div>
                <a
                  href={p.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-primary hover:underline whitespace-nowrap flex items-center gap-1 flex-shrink-0"
                >
                  <BookOpen className="h-3.5 w-3.5" /> {adminT('platform_admin.integrations_panel.setup_guide')}
                </a>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

type PlatformAdminTab =
  | 'tenants'
  | 'templates'
  | 'analytics'
  | 'cost-monitoring'
  | 'activation'
  | 'docs-feedback'
  | 'support'
  | 'integrations'
  | 'connector-health'
  | 'push-health'
  | 'billing-health'
  | 'retention';

type RecommendationTier = 'starter' | 'pro' | 'enterprise';
const RECOMMENDATION_TIERS_ORDER: readonly RecommendationTier[] = [
  'starter',
  'pro',
  'enterprise',
];

interface RecommendationStatsShape {
  windowDays: number;
  impressions: number;
  clicks: number;
  completedSwitches: number;
  totalMonthlySavingsCents: number;
  tenantsClicked: number;
  tenantsSwitched: number;
  clickThroughRate: number;
  completionRate: number;
  byRecommendedTier: Array<{
    recommendedTier: RecommendationTier;
    impressions: number;
    clicks: number;
    completedSwitches: number;
    monthlySavingsCents: number;
  }>;
  byPitch: Array<{
    pitch: 'tier-switch' | 'annual-only';
    impressions: number;
    clicks: number;
    completedSwitches: number;
    monthlySavingsCents: number;
  }>;
  switchPairs: Array<{
    currentTier: RecommendationTier;
    recommendedTier: RecommendationTier;
    completedSwitches: number;
    monthlySavingsCents: number;
  }>;
  // Per-tier weekly trend; series arrays are index-aligned with `weeks`.
  weeklyTrend: {
    windowWeeks: number;
    weeks: string[];
    byRecommendedTier: Array<{
      recommendedTier: RecommendationTier;
      completedSwitches: number[];
      monthlySavingsCents: number[];
    }>;
  };
}

function RecommendationTrendSparkline({
  values,
  weeks,
  formatValue,
  ariaLabel,
}: {
  values: number[];
  weeks: string[];
  formatValue: (value: number) => string;
  ariaLabel: string;
}) {
  if (values.length === 0) {
    return (
      <div
        className="h-6 w-24 rounded bg-surface-muted/40"
        aria-label={ariaLabel}
        role="img"
      />
    );
  }
  const max = Math.max(1, ...values);
  return (
    <div
      className="flex items-end gap-px h-6 w-24"
      aria-label={ariaLabel}
      role="img"
    >
      {values.map((value, idx) => {
        const heightPct = Math.max((value / max) * 100, 4);
        const week = weeks[idx] ?? '';
        return (
          <div
            key={`${week}-${idx}`}
            className={
              value > 0
                ? 'flex-1 bg-primary/60 rounded-t min-h-[1px]'
                : 'flex-1 bg-surface-muted/60 rounded-t min-h-[1px]'
            }
            style={{ height: `${heightPct}%` }}
            title={week ? `${week}: ${formatValue(value)}` : formatValue(value)}
          />
        );
      })}
    </div>
  );
}

// Drawer rendered just below the platform stats grid when an admin clicks
// the recommendation tile. Splits the trailing-30d funnel by recommended
// tier so we can answer "which recommendation is actually moving MRR" —
// not just "did anyone click the banner".
function RecommendationBreakdownPanel({
  stats,
  loading,
  onClose,
}: {
  stats: RecommendationStatsShape | undefined;
  loading: boolean;
  onClose: () => void;
}) {
  const { t: adminT } = useTranslation('admin');
  const tierLabel = (tier: RecommendationTier): string =>
    adminT(`platform_admin.recommendation_breakdown.tier_${tier}`);

  const tierRowsByKey = new Map(
    (stats?.byRecommendedTier ?? []).map((row) => [row.recommendedTier, row]),
  );
  // Always render every known tier in a stable order so the table doesn't
  // shuffle as data changes; missing tiers render as zero rows.
  const tierRows = RECOMMENDATION_TIERS_ORDER.map(
    (tier) =>
      tierRowsByKey.get(tier) ?? {
        recommendedTier: tier,
        impressions: 0,
        clicks: 0,
        completedSwitches: 0,
        monthlySavingsCents: 0,
      },
  );

  const totalCompleted = stats?.completedSwitches ?? 0;
  const totalSavings = stats?.totalMonthlySavingsCents ?? 0;
  const switchPairs = stats?.switchPairs ?? [];

  const pitchOrder: Array<'tier-switch' | 'annual-only'> = [
    'tier-switch',
    'annual-only',
  ];
  const pitchRowsByKey = new Map(
    (stats?.byPitch ?? []).map((row) => [row.pitch, row]),
  );
  const pitchRows = pitchOrder.map(
    (pitch) =>
      pitchRowsByKey.get(pitch) ?? {
        pitch,
        impressions: 0,
        clicks: 0,
        completedSwitches: 0,
        monthlySavingsCents: 0,
      },
  );
  const pitchLabel = (pitch: 'tier-switch' | 'annual-only'): string =>
    adminT(
      pitch === 'annual-only'
        ? 'platform_admin.recommendation_breakdown.pitch_annual_only'
        : 'platform_admin.recommendation_breakdown.pitch_tier_switch',
    );

  const weeklyTrend = stats?.weeklyTrend;
  const trendWeeks = weeklyTrend?.weeks ?? [];
  const trendByTier = new Map(
    (weeklyTrend?.byRecommendedTier ?? []).map((row) => [
      row.recommendedTier,
      row,
    ]),
  );
  const hasTrendData = trendWeeks.length > 0;

  return (
    <section
      className="bg-surface border border-border rounded-xl p-5 shadow-[var(--elevation-1)]"
      aria-label={adminT('platform_admin.recommendation_breakdown.title')}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-base font-semibold text-text-primary">
            {adminT('platform_admin.recommendation_breakdown.title')}
          </h2>
          <p className="text-xs text-text-muted mt-0.5">
            {loading
              ? adminT('platform_admin.common_loading')
              : adminT(
                  'platform_admin.recommendation_breakdown.savings_summary',
                  {
                    amount: formatCents(totalSavings),
                    count: totalCompleted,
                  },
                )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs font-medium text-text-muted hover:text-text-primary inline-flex items-center gap-1"
          aria-label={adminT(
            'platform_admin.recommendation_breakdown.toggle_close',
          )}
        >
          <XCircle className="h-4 w-4" />
          {adminT('platform_admin.recommendation_breakdown.toggle_close')}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-text-muted border-b border-border">
              <th className="py-2 pr-4 font-medium">
                {adminT('platform_admin.recommendation_breakdown.col_tier')}
              </th>
              <th className="py-2 pr-4 font-medium text-right">
                {adminT(
                  'platform_admin.recommendation_breakdown.col_impressions',
                )}
              </th>
              <th className="py-2 pr-4 font-medium text-right">
                {adminT('platform_admin.recommendation_breakdown.col_clicks')}
              </th>
              <th className="py-2 pr-4 font-medium text-right">
                {adminT(
                  'platform_admin.recommendation_breakdown.col_completed',
                )}
              </th>
              <th className="py-2 pr-0 font-medium text-right">
                {adminT('platform_admin.recommendation_breakdown.col_savings')}
              </th>
            </tr>
          </thead>
          <tbody>
            {tierRows.map((row) => (
              <tr
                key={row.recommendedTier}
                className="border-b border-border last:border-b-0"
              >
                <td className="py-2 pr-4 font-medium text-text-primary">
                  {tierLabel(row.recommendedTier)}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-text-secondary">
                  {row.impressions}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-text-secondary">
                  {row.clicks}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-text-primary">
                  {row.completedSwitches}
                </td>
                <td className="py-2 pr-0 text-right tabular-nums text-text-primary">
                  {formatCents(row.monthlySavingsCents)}
                </td>
              </tr>
            ))}
            <tr className="text-text-primary font-semibold">
              <td className="py-2 pr-4">
                {adminT(
                  'platform_admin.recommendation_breakdown.totals_label',
                )}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {stats?.impressions ?? 0}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {stats?.clicks ?? 0}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {totalCompleted}
              </td>
              <td className="py-2 pr-0 text-right tabular-nums">
                {formatCents(totalSavings)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-5">
        <h3 className="text-sm font-semibold text-text-primary">
          {adminT('platform_admin.recommendation_breakdown.pitch_heading')}
        </h3>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-text-muted border-b border-border">
                <th className="py-2 pr-4 font-medium">
                  {adminT(
                    'platform_admin.recommendation_breakdown.col_pitch',
                  )}
                </th>
                <th className="py-2 pr-4 font-medium text-right">
                  {adminT(
                    'platform_admin.recommendation_breakdown.col_impressions',
                  )}
                </th>
                <th className="py-2 pr-4 font-medium text-right">
                  {adminT(
                    'platform_admin.recommendation_breakdown.col_clicks',
                  )}
                </th>
                <th className="py-2 pr-4 font-medium text-right">
                  {adminT(
                    'platform_admin.recommendation_breakdown.col_completed',
                  )}
                </th>
                <th className="py-2 pr-0 font-medium text-right">
                  {adminT(
                    'platform_admin.recommendation_breakdown.col_savings',
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {pitchRows.map((row) => (
                <tr
                  key={row.pitch}
                  data-testid={`recommendation-pitch-row-${row.pitch}`}
                  className="border-b border-border last:border-b-0"
                >
                  <td className="py-2 pr-4 font-medium text-text-primary">
                    {pitchLabel(row.pitch)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-text-secondary">
                    {row.impressions}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-text-secondary">
                    {row.clicks}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-text-primary">
                    {row.completedSwitches}
                  </td>
                  <td className="py-2 pr-0 text-right tabular-nums text-text-primary">
                    {formatCents(row.monthlySavingsCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-5">
        <h3 className="text-sm font-semibold text-text-primary">
          {adminT('platform_admin.recommendation_breakdown.pair_heading')}
        </h3>
        {switchPairs.length === 0 ? (
          <p className="text-xs text-text-muted mt-1">
            {adminT('platform_admin.recommendation_breakdown.empty_pairs')}
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {switchPairs.map((pair) => (
              <li
                key={`${pair.currentTier}->${pair.recommendedTier}`}
                className="text-sm text-text-secondary"
              >
                {adminT(
                  'platform_admin.recommendation_breakdown.pair_row',
                  {
                    from: tierLabel(pair.currentTier),
                    to: tierLabel(pair.recommendedTier),
                    count: pair.completedSwitches,
                    amount: formatCents(pair.monthlySavingsCents),
                  },
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-5" data-testid="recommendation-trend-section">
        <h3 className="text-sm font-semibold text-text-primary">
          {adminT('platform_admin.recommendation_breakdown.trend_heading', {
            weeks: weeklyTrend?.windowWeeks ?? 12,
          })}
        </h3>
        {!hasTrendData ? (
          <p className="text-xs text-text-muted mt-1">
            {adminT('platform_admin.recommendation_breakdown.empty_trend')}
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {RECOMMENDATION_TIERS_ORDER.map((tier) => {
              const series = trendByTier.get(tier);
              const completed = series?.completedSwitches ?? [];
              const savings = series?.monthlySavingsCents ?? [];
              const latestCompleted = completed[completed.length - 1] ?? 0;
              const latestSavings = savings[savings.length - 1] ?? 0;
              return (
                <li
                  key={tier}
                  className="flex items-center gap-3 text-sm"
                  data-testid={`recommendation-trend-row-${tier}`}
                >
                  <span className="w-20 text-text-primary font-medium">
                    {tierLabel(tier)}
                  </span>
                  <div className="flex items-center gap-2 min-w-[10rem]">
                    <RecommendationTrendSparkline
                      values={completed}
                      weeks={trendWeeks}
                      formatValue={(value) =>
                        adminT(
                          'platform_admin.recommendation_breakdown.trend_completed_value',
                          { count: value },
                        )
                      }
                      ariaLabel={adminT(
                        'platform_admin.recommendation_breakdown.trend_completed_aria',
                        { tier: tierLabel(tier) },
                      )}
                    />
                    <span className="text-xs tabular-nums text-text-secondary">
                      {adminT(
                        'platform_admin.recommendation_breakdown.trend_completed_label',
                        { count: latestCompleted },
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 min-w-[10rem]">
                    <RecommendationTrendSparkline
                      values={savings}
                      weeks={trendWeeks}
                      formatValue={(value) =>
                        adminT(
                          'platform_admin.recommendation_breakdown.trend_savings_value',
                          { amount: formatCents(value) },
                        )
                      }
                      ariaLabel={adminT(
                        'platform_admin.recommendation_breakdown.trend_savings_aria',
                        { tier: tierLabel(tier) },
                      )}
                    />
                    <span className="text-xs tabular-nums text-text-secondary">
                      {adminT(
                        'platform_admin.recommendation_breakdown.trend_savings_label',
                        { amount: formatCents(latestSavings) },
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

// Shape returned by GET /platform/billing-discount-events. Mirrors the
// recommendation-funnel shape but rolled up by (couponId, promotionCode)
// so admins can see "which active discounts moved the needle in the
// last 30d" — the row the discount badge tracking exists to answer.
interface DiscountStatsShape {
  windowDays: number;
  impressions: number;
  clicks: number;
  completedSwitches: number;
  clickThroughRate: number;
  completionRate: number;
  byDiscount: Array<{
    couponId: string | null;
    promotionCode: string | null;
    impressions: number;
    clicks: number;
    completedSwitches: number;
    tenantsClicked: number;
    tenantsSwitched: number;
    clickThroughRate: number;
    completionRate: number;
    lastSeenAt: string | null;
  }>;
}

// Drawer rendered just below the platform stats grid when an admin
// clicks the discount tile. One row per (couponId, promotionCode) with
// the funnel + last-seen so we can answer "which active discounts have
// been seen / clicked / completed in the last 30 days".
function DiscountBreakdownPanel({
  stats,
  loading,
  onClose,
}: {
  stats: DiscountStatsShape | undefined;
  loading: boolean;
  onClose: () => void;
}) {
  const { t: adminT } = useTranslation('admin');
  const rows = stats?.byDiscount ?? [];

  return (
    <section
      className="bg-surface border border-border rounded-xl p-5 shadow-[var(--elevation-1)]"
      aria-label={adminT('platform_admin.discount_breakdown.title')}
      data-testid="discount-breakdown-panel"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-base font-semibold text-text-primary">
            {adminT('platform_admin.discount_breakdown.title')}
          </h2>
          <p className="text-xs text-text-muted mt-0.5">
            {loading
              ? adminT('platform_admin.common_loading')
              : adminT('platform_admin.discount_breakdown.subtitle', {
                  days: stats?.windowDays ?? 30,
                })}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs font-medium text-text-muted hover:text-text-primary inline-flex items-center gap-1"
          aria-label={adminT('platform_admin.discount_breakdown.toggle_close')}
        >
          <XCircle className="h-4 w-4" />
          {adminT('platform_admin.discount_breakdown.toggle_close')}
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-text-muted">
          {adminT('platform_admin.discount_breakdown.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-text-muted border-b border-border">
                <th className="py-2 pr-4 font-medium">
                  {adminT('platform_admin.discount_breakdown.col_discount')}
                </th>
                <th className="py-2 pr-4 font-medium text-right">
                  {adminT('platform_admin.discount_breakdown.col_impressions')}
                </th>
                <th className="py-2 pr-4 font-medium text-right">
                  {adminT('platform_admin.discount_breakdown.col_clicks')}
                </th>
                <th className="py-2 pr-4 font-medium text-right">
                  {adminT('platform_admin.discount_breakdown.col_completed')}
                </th>
                <th className="py-2 pr-0 font-medium text-right">
                  {adminT('platform_admin.discount_breakdown.col_tenants')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                // Stable row key: a coupon may have a null promotion code
                // (raw coupon attached) and vice-versa, so the pair joins
                // both keys with a separator that can't appear inside
                // either value.
                const rowKey = `${row.couponId ?? ''}|${row.promotionCode ?? ''}`;
                // Display label prefers the human-readable promo code,
                // falls back to the cou_* id when only the raw coupon
                // was stamped.
                const label = row.promotionCode ?? row.couponId ?? '—';
                const sub =
                  row.promotionCode && row.couponId
                    ? row.couponId
                    : null;
                return (
                  <tr
                    key={rowKey}
                    className="border-b border-border last:border-b-0"
                    data-testid={`discount-row-${rowKey}`}
                  >
                    <td className="py-2 pr-4 font-medium text-text-primary">
                      <div>{label}</div>
                      {sub && (
                        <div className="text-xs text-text-muted font-normal">
                          {sub}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-text-secondary">
                      {row.impressions}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-text-secondary">
                      {row.clicks}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-text-primary">
                      {row.completedSwitches}
                    </td>
                    <td className="py-2 pr-0 text-right tabular-nums text-text-secondary">
                      {adminT('platform_admin.discount_breakdown.tenants_cell', {
                        clicked: row.tenantsClicked,
                        switched: row.tenantsSwitched,
                      })}
                    </td>
                  </tr>
                );
              })}
              <tr className="text-text-primary font-semibold">
                <td className="py-2 pr-4">
                  {adminT('platform_admin.discount_breakdown.totals_label')}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {stats?.impressions ?? 0}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {stats?.clicks ?? 0}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {stats?.completedSwitches ?? 0}
                </td>
                <td className="py-2 pr-0 text-right tabular-nums">—</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const PLATFORM_ADMIN_TABS: { key: PlatformAdminTab; labelKey: string; icon: typeof Building2 }[] = [
  { key: 'tenants', labelKey: 'platform_admin.tabs.tenants', icon: Building2 },
  { key: 'templates', labelKey: 'platform_admin.tabs.templates', icon: Package },
  { key: 'analytics', labelKey: 'platform_admin.tabs.analytics', icon: BarChart3 },
  { key: 'cost-monitoring', labelKey: 'platform_admin.tabs.cost_monitoring', icon: DollarSign },
  { key: 'activation', labelKey: 'platform_admin.tabs.activation', icon: Activity },
  { key: 'docs-feedback', labelKey: 'platform_admin.tabs.docs_feedback', icon: BookOpen },
  { key: 'support', labelKey: 'platform_admin.tabs.support', icon: LifeBuoy },
  { key: 'integrations', labelKey: 'platform_admin.tabs.integrations', icon: Plug },
  { key: 'connector-health', labelKey: 'platform_admin.tabs.connector_health', icon: ShieldAlert },
  { key: 'push-health', labelKey: 'platform_admin.tabs.push_health', icon: BellRing },
  { key: 'billing-health', labelKey: 'platform_admin.tabs.billing_health', icon: DollarSign },
  { key: 'retention', labelKey: 'platform_admin.tabs.retention', icon: Database },
];

export default function PlatformAdmin() {
  const { t: adminT } = useTranslation('admin');
  const queryClient = useQueryClient();
  const [expandedTenant, setExpandedTenant] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<PlatformAdminTab>('tenants');
  const [expandedTemplate, setExpandedTemplate] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>('totalInstalls');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ['platform-stats'],
    queryFn: () => api.get<{ stats: PlatformStats }>('/platform/stats'),
    refetchInterval: 60_000,
  });

  // Counter for the platform-wide hard-bounce dedup table. Refreshed at the
  // same cadence as the rest of the dashboard cards so the 7d / 30d windows
  // stay current without the admin having to reload. Failures here must not
  // hide the rest of the dashboard, so the card just shows "—" if the query
  // errors and the rest of the page renders unaffected.
  const { data: bouncedStats, isLoading: bouncedStatsLoading } = useQuery({
    queryKey: ['support-bounced-recipient-stats'],
    queryFn: () =>
      api.get<BouncedRecipientStats>('/support/replies/bounced-recipients/stats'),
    refetchInterval: 60_000,
  });

  // 30d funnel for the BillingEstimator recommendation banner. The per-tier
  // breakdown lets the admin see *which* recommendations are converting and
  // how much MRR the banner has actually moved, not just the aggregate
  // funnel counts.
  const { data: recommendationStats, isLoading: recommendationStatsLoading } =
    useQuery({
      queryKey: ['platform-billing-recommendations'],
      queryFn: () =>
        api.get<RecommendationStatsShape>('/platform/billing-recommendations'),
      refetchInterval: 60_000,
    });
  const [showRecommendationDetails, setShowRecommendationDetails] =
    useState(false);

  // 30d discount-badge funnel rolled up by (couponId, promotionCode).
  // Independent of the recommendation banner above — same shape, but
  // the question this answers is "which active discounts moved the
  // needle?", not "which recommended tier converted?".
  const { data: discountStats, isLoading: discountStatsLoading } = useQuery({
    queryKey: ['platform-billing-discount-events'],
    queryFn: () =>
      api.get<DiscountStatsShape>('/platform/billing-discount-events'),
    refetchInterval: 60_000,
  });
  const [showDiscountDetails, setShowDiscountDetails] = useState(false);

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

  const { data: activationData, isLoading: activationLoading } = useQuery({
    queryKey: ['platform-activation-metrics'],
    queryFn: () => api.get<{ metrics: ActivationMetricRow[] }>('/platform/activation-metrics'),
    enabled: activeTab === 'activation',
    refetchInterval: 60_000,
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
      <PageHeader
        title={adminT('platform_admin.page_title')}
        description={adminT('platform_admin.page_subtitle')}
        icon={<Building2 className="h-5 w-5" />}
        className="mb-0"
      />

      <OperationsAlertsBanner />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard
          icon={Building2}
          label={adminT('platform_admin.stats.active_tenants')}
          value={statsLoading ? '...' : `${stats?.active_tenants ?? 0} / ${stats?.total_tenants ?? 0}`}
        />
        <StatCard
          icon={Users}
          label={adminT('platform_admin.stats.total_users')}
          value={statsLoading ? '...' : String(stats?.total_users ?? 0)}
        />
        <StatCard
          icon={PhoneCall}
          label={adminT('platform_admin.stats.calls_30d')}
          value={statsLoading ? '...' : `${stats?.calls_last_30d ?? 0}`}
          sub={statsLoading ? '' : adminT('platform_admin.stats.calls_24h_sub', { count: stats?.calls_last_24h ?? 0 })}
        />
        <StatCard
          icon={DollarSign}
          label={adminT('platform_admin.stats.revenue_30d')}
          value={statsLoading ? '...' : formatCents(stats?.revenue_last_30d_cents ?? '0')}
          sub={statsLoading ? '' : adminT('platform_admin.stats.revenue_total_sub', { amount: formatCents(stats?.total_revenue_cents ?? '0') })}
        />
        {/* Platform-wide hard-bounce dedup table size. Click jumps to the
            Support Inbox tab and scrolls to the BouncedRecipientsPanel so the
            admin can drill into the offending addresses. The 7d / 30d sub-line
            is what makes this a useful sender-reputation tripwire — a sudden
            jump in the 7d window is the signal worth paging on. */}
        <StatCard
          icon={ShieldAlert}
          label={adminT('platform_admin.stats.bounced_label')}
          value={
            bouncedStatsLoading
              ? '...'
              : String(bouncedStats?.total ?? 0)
          }
          sub={
            bouncedStatsLoading
              ? ''
              : adminT('platform_admin.stats.bounced_sub', { week: bouncedStats?.last_7d ?? 0, month: bouncedStats?.last_30d ?? 0 })
          }
          tone={
            !bouncedStatsLoading && (bouncedStats?.last_7d ?? 0) > 0
              ? 'warning'
              : undefined
          }
          onClick={() => {
            setActiveTab('support');
            // Defer the scroll until after the tab swap has rendered the
            // panel — the support inbox isn't mounted on other tabs, so
            // getElementById would otherwise return null on the first click
            // from a non-support tab.
            requestAnimationFrame(() => {
              setTimeout(() => {
                document
                  .getElementById('bounced-recipients-panel')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }, 0);
            });
          }}
        />
        {/* 30d funnel for the BillingEstimator recommendation banner.
            Clicking the tile toggles a per-recommended-tier breakdown
            (rendered just below the stats grid) so admins can see *which*
            tier the banner is moving MRR for, not just the global funnel. */}
        <StatCard
          icon={TrendingUp}
          label={adminT('platform_admin.stats.recommendation_label')}
          value={
            recommendationStatsLoading
              ? '...'
              : String(recommendationStats?.completedSwitches ?? 0)
          }
          sub={
            recommendationStatsLoading
              ? ''
              : adminT('platform_admin.stats.recommendation_sub', {
                  impressions: recommendationStats?.impressions ?? 0,
                  clicks: recommendationStats?.clicks ?? 0,
                })
          }
          onClick={() => setShowRecommendationDetails((v) => !v)}
        />
        {/* 30d funnel for the upgrade-card discount badge. Tile shows
            completed-discount-switches as the headline number; click
            toggles the per-coupon breakdown so an admin can see which
            promo is actually pulling weight. */}
        <StatCard
          icon={DollarSign}
          label={adminT('platform_admin.stats.discount_label')}
          value={
            discountStatsLoading
              ? '...'
              : String(discountStats?.completedSwitches ?? 0)
          }
          sub={
            discountStatsLoading
              ? ''
              : adminT('platform_admin.stats.discount_sub', {
                  impressions: discountStats?.impressions ?? 0,
                  clicks: discountStats?.clicks ?? 0,
                })
          }
          onClick={() => setShowDiscountDetails((v) => !v)}
        />
      </div>

      {showRecommendationDetails && (
        <RecommendationBreakdownPanel
          stats={recommendationStats}
          loading={recommendationStatsLoading}
          onClose={() => setShowRecommendationDetails(false)}
        />
      )}

      {showDiscountDetails && (
        <DiscountBreakdownPanel
          stats={discountStats}
          loading={discountStatsLoading}
          onClose={() => setShowDiscountDetails(false)}
        />
      )}

      <div
        role="tablist"
        aria-label={adminT('platform_admin.aria_tablist')}
        className="flex flex-wrap gap-1 border-b border-border overflow-x-auto"
      >
        {PLATFORM_ADMIN_TABS.map((t) => {
          const Icon = t.icon;
          const isActive = activeTab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(t.key)}
              className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              <Icon className="h-4 w-4" />
              {adminT(t.labelKey)}
            </button>
          );
        })}
      </div>

      {activeTab === 'integrations' && <IntegrationsStatusPanel />}
      {activeTab === 'connector-health' && <ConnectorHealthPanel />}
      {activeTab === 'push-health' && <PushDeliveryHealthPanel />}
      {activeTab === 'billing-health' && <BillingConfigHealthPanel />}
      {activeTab === 'retention' && <CallEventsRetentionPanel />}

      {activeTab === 'tenants' && (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="font-semibold">{adminT('platform_admin.tenants.title')}</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="w-8 px-2"></th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.tenants.header_tenant')}</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.tenants.header_status')}</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.tenants.header_plan')}</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.tenants.header_onboarding')}</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.tenants.header_users')}</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.tenants.header_calls_30d')}</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.tenants.header_last_activity')}</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.tenants.header_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {tenantsLoading ? (
                  <tr><td colSpan={9} className="text-center py-12 text-text-muted">{adminT('platform_admin.common_loading')}</td></tr>
                ) : !tenantsData?.tenants.length ? (
                  <tr><td colSpan={9} className="text-center py-12 text-text-muted">{adminT('platform_admin.tenants.no_tenants')}</td></tr>
                ) : (
                  tenantsData.tenants.map((tenant) => (
                    <Fragment key={tenant.id}>
                      <tr className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                        <td className="px-2">
                          <button
                            onClick={() => setExpandedTenant(expandedTenant === tenant.id ? null : tenant.id)}
                            className="p-1 rounded hover:bg-surface-secondary"
                          >
                            {expandedTenant === tenant.id
                              ? <ChevronDown className="h-4 w-4 text-text-muted" />
                              : <ChevronRight className="h-4 w-4 text-text-muted" />}
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium">{tenant.name}</div>
                          <div className="text-xs text-text-muted font-mono">{tenant.slug}</div>
                        </td>
                        <td className="px-4 py-3"><StatusBadge status={tenant.status} /></td>
                        <td className="px-4 py-3"><PlanBadge plan={tenant.plan} /></td>
                        <td className="px-4 py-3">
                          {/* Server returns NULL for both onboarding fields only when the tenant
                              has no active owner row. When an owner exists, `step` is server-clamped
                              to [1..3] and `completed` is COALESCE'd to a clean boolean, so we only
                              need to gate on `step` here. */}
                          {tenant.latest_owner_onboarding_step === null ? (
                            <span className="text-xs text-text-muted">—</span>
                          ) : (
                            <OwnerOnboardingBadge
                              step={tenant.latest_owner_onboarding_step}
                              completed={tenant.latest_owner_onboarding_completed ?? false}
                            />
                          )}
                        </td>
                        <td className="px-4 py-3 text-text-muted">{tenant.user_count}</td>
                        <td className="px-4 py-3 text-text-muted">{tenant.calls_last_30d}</td>
                        <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                          {tenant.last_call_at ? new Date(tenant.last_call_at).toLocaleDateString() : adminT('platform_admin.common.never')}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => setExpandedTenant(expandedTenant === tenant.id ? null : tenant.id)}
                              className="p-1.5 rounded hover:bg-surface-secondary text-text-muted hover:text-text-primary"
                              title={adminT('platform_admin.tenants.view_details')}
                            >
                              <Eye className="h-4 w-4" />
                            </button>
                            {tenant.status === 'active' ? (
                              <button
                                onClick={() => {
                                  if (confirm(adminT('platform_admin.tenants.confirm_suspend', { name: tenant.name }))) {
                                    statusMutation.mutate({ id: tenant.id, status: 'suspended' });
                                  }
                                }}
                                className="p-1.5 rounded hover:bg-danger-light text-text-muted hover:text-danger"
                                title={adminT('platform_admin.tenants.suspend_tenant')}
                              >
                                <Ban className="h-4 w-4" />
                              </button>
                            ) : tenant.status === 'suspended' ? (
                              <button
                                onClick={() => {
                                  if (confirm(adminT('platform_admin.tenants.confirm_reactivate', { name: tenant.name }))) {
                                    statusMutation.mutate({ id: tenant.id, status: 'active' });
                                  }
                                }}
                                className="p-1.5 rounded hover:bg-success-light text-text-muted hover:text-success"
                                title={adminT('platform_admin.tenants.reactivate_tenant')}
                              >
                                <CheckCircle className="h-4 w-4" />
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                      {expandedTenant === tenant.id && (
                        <tr className="border-b border-border">
                          <td colSpan={9} className="p-0">
                            <TenantDetailPanel tenantId={tenant.id} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
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
            <h2 className="font-semibold">{adminT('platform_admin.templates.title')}</h2>
            <p className="text-xs text-text-muted mt-0.5">{adminT('platform_admin.templates.subtitle')}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="w-8 px-2"></th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.templates.header_template')}</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.templates.header_slug')}</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.templates.header_current_version')}</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.templates.header_status')}</th>
                </tr>
              </thead>
              <tbody>
                {templatesLoading ? (
                  <tr><td colSpan={5} className="text-center py-12 text-text-muted">{adminT('platform_admin.templates.loading')}</td></tr>
                ) : !templatesData?.templates.length ? (
                  <tr><td colSpan={5} className="text-center py-12 text-text-muted">{adminT('platform_admin.templates.no_templates')}</td></tr>
                ) : (
                  templatesData.templates.map((t) => (
                    <Fragment key={t.id}>
                      <tr className="border-b border-border last:border-0 hover:bg-surface-secondary/50 cursor-pointer"
                          onClick={() => setExpandedTemplate(expandedTemplate === t.id ? null : t.id)}>
                        <td className="px-2">
                          <button aria-label={expandedTemplate === t.id ? adminT('platform_admin.templates.collapse_aria') : adminT('platform_admin.templates.expand_aria')} aria-expanded={expandedTemplate === t.id} className="p-1 rounded hover:bg-surface-secondary">
                            {expandedTemplate === t.id
                              ? <ChevronDown className="h-4 w-4 text-text-muted" />
                              : <ChevronRight className="h-4 w-4 text-text-muted" />}
                          </button>
                        </td>
                        <td className="px-4 py-3 font-medium">{t.displayName}</td>
                        <td className="px-4 py-3 text-text-muted font-mono text-xs">{t.slug}</td>
                        <td className="px-4 py-3 font-mono text-sm">v{t.currentVersion}</td>
                        <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
                      </tr>
                      {expandedTemplate === t.id && (
                        <tr className="border-b border-border">
                          <td colSpan={5} className="p-0">
                            <TemplateVersionManager templateId={t.id} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
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

      {activeTab === 'activation' && (
        <ActivationMetricsTab data={activationData} loading={activationLoading} />
      )}

      {activeTab === 'docs-feedback' && <DocsFeedbackTab />}

      {activeTab === 'support' && <SupportInboxTab />}
    </div>
  );
}

type DocsFeedbackReplyStateFilter = 'any' | 'failed' | 'hard_bounce';

function DocsFeedbackTab() {
  const { t: adminT } = useTranslation('admin');
  const [sort, setSort] = useState<DocsFeedbackSort>('lowest_ratio');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<DocsFeedbackStatusFilter>('new');
  const [replyStateFilter, setReplyStateFilter] = useState<DocsFeedbackReplyStateFilter>('any');
  const queryClient = useQueryClient();

  const replyFilterActive = replyStateFilter !== 'any';

  const { data: summaryData, isLoading: summaryLoading } = useQuery({
    queryKey: ['docs-feedback-summary', sort],
    queryFn: () => api.get<{ articles: DocsFeedbackArticle[] }>(`/docs/feedback/summary?sort=${sort}&limit=200`),
    refetchInterval: 60_000,
  });

  const { data: commentsData, isLoading: commentsLoading } = useQuery({
    queryKey: ['docs-feedback-comments', selectedSlug, statusFilter, replyStateFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('limit', selectedSlug ? '100' : '50');
      params.set('status', replyFilterActive ? 'all' : statusFilter);
      if (replyFilterActive) params.set('reply_state', replyStateFilter);
      if (selectedSlug) params.set('article_slug', selectedSlug);
      return api.get<{ comments: DocsFeedbackComment[] }>(`/docs/feedback/comments?${params.toString()}`);
    },
    refetchInterval: 60_000,
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: DocsFeedbackStatus }) =>
      api.patch<{ comment: DocsFeedbackComment }>(`/docs/feedback/comments/${id}`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['docs-feedback-comments'] });
    },
  });

  const articles = summaryData?.articles ?? [];
  const comments = commentsData?.comments ?? [];

  return (
    <div className="space-y-6">
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-semibold">{adminT('platform_admin.docs_feedback.articles_title')}</h2>
            <p className="text-xs text-text-muted mt-0.5">{adminT('platform_admin.docs_feedback.articles_subtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-text-muted">{adminT('platform_admin.docs_feedback.sort_label')}</label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as DocsFeedbackSort)}
              className="text-sm px-2 py-1.5 rounded border border-border bg-surface"
            >
              <option value="lowest_ratio">{adminT('platform_admin.docs_feedback.sort_lowest')}</option>
              <option value="highest_ratio">{adminT('platform_admin.docs_feedback.sort_highest')}</option>
              <option value="most_votes">{adminT('platform_admin.docs_feedback.sort_most_votes')}</option>
              <option value="recent">{adminT('platform_admin.docs_feedback.sort_recent')}</option>
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.docs_feedback.header_article')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.docs_feedback.header_helpfulness')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.docs_feedback.header_helpful')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.docs_feedback.header_not_helpful')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.docs_feedback.header_comments')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.docs_feedback.header_last_vote')}</th>
                <th className="text-right px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.docs_feedback.header_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {summaryLoading ? (
                <tr><td colSpan={7} className="text-center py-12 text-text-muted">{adminT('platform_admin.docs_feedback.loading_articles')}</td></tr>
              ) : articles.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-12 text-text-muted">{adminT('platform_admin.docs_feedback.no_articles')}</td></tr>
              ) : (
                articles.map((a) => {
                  const ratio = a.helpful_ratio;
                  const ratioColor =
                    ratio === null ? 'text-text-muted'
                      : ratio >= 75 ? 'text-success'
                      : ratio >= 50 ? 'text-warning'
                      : 'text-danger';
                  return (
                    <tr key={a.article_slug} className={`border-b border-border last:border-0 hover:bg-surface-secondary/50 ${selectedSlug === a.article_slug ? 'bg-surface-secondary/40' : ''}`}>
                      <td className="px-4 py-3 font-mono text-xs">{a.article_slug}</td>
                      <td className={`px-4 py-3 font-semibold ${ratioColor}`}>
                        {ratio === null ? adminT('platform_admin.common.em_dash') : `${ratio}%`}
                        <span className="text-text-muted font-normal ml-1">({a.total_votes})</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-success">
                          <ThumbsUp className="h-3.5 w-3.5" /> {a.helpful_count}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-danger">
                          <ThumbsDown className="h-3.5 w-3.5" /> {a.not_helpful_count}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          <span className="inline-flex items-center gap-1 text-text-muted">
                            <MessageSquare className="h-3.5 w-3.5" /> {a.comment_count}
                          </span>
                          {a.comment_count > 0 && (
                            <span className="text-xs text-text-muted">
                              {adminT('platform_admin.docs_feedback.breakdown_counts', { new: a.new_comment_count, resolved: a.resolved_comment_count, hidden: a.hidden_comment_count })}
                            </span>
                          )}
                          {a.pending_reply_count > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedSlug(a.article_slug);
                                setStatusFilter('pending_reply');
                              }}
                              className="inline-flex items-center gap-1 self-start px-1.5 py-0.5 rounded border border-warning/30 bg-warning-light text-warning text-[10px] font-medium hover:bg-warning/20"
                              title={adminT('platform_admin.docs_feedback.pending_reply_title')}
                            >
                              <Mail className="h-3 w-3" />
                              {adminT('platform_admin.docs_feedback.pending_reply', { count: a.pending_reply_count })}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                        {a.last_vote_at ? new Date(a.last_vote_at).toLocaleDateString() : adminT('platform_admin.common.em_dash')}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setSelectedSlug(selectedSlug === a.article_slug ? null : a.article_slug)}
                          className="text-xs px-2 py-1 rounded border border-border hover:bg-surface-secondary"
                        >
                          {selectedSlug === a.article_slug ? adminT('platform_admin.docs_feedback.clear_filter') : adminT('platform_admin.docs_feedback.view_comments')}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-semibold">
              {selectedSlug ? adminT('platform_admin.docs_feedback.comments_title_for', { slug: selectedSlug }) : adminT('platform_admin.docs_feedback.comments_title_recent')}
            </h2>
            <p className="text-xs text-text-muted mt-0.5">
              {selectedSlug
                ? adminT('platform_admin.docs_feedback.comments_subtitle_for')
                : adminT('platform_admin.docs_feedback.comments_subtitle_recent')}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-text-muted">{adminT('platform_admin.docs_feedback.reply_state_label')}</label>
            <select
              value={replyStateFilter}
              onChange={(e) => setReplyStateFilter(e.target.value as DocsFeedbackReplyStateFilter)}
              className={`text-sm px-2 py-1.5 rounded border border-border bg-surface ${
                replyStateFilter === 'hard_bounce'
                  ? 'text-warning font-medium'
                  : replyStateFilter === 'failed'
                    ? 'text-danger font-medium'
                    : ''
              }`}
              title={adminT('platform_admin.docs_feedback.reply_state_title')}
            >
              <option value="any">{adminT('platform_admin.docs_feedback.reply_state_any')}</option>
              <option value="failed">{adminT('platform_admin.docs_feedback.reply_state_failed')}</option>
              <option value="hard_bounce">{adminT('platform_admin.docs_feedback.reply_state_hard_bounce')}</option>
            </select>
            <label className="text-xs text-text-muted">{adminT('platform_admin.docs_feedback.status_label')}</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as DocsFeedbackStatusFilter)}
              disabled={replyFilterActive}
              className="text-sm px-2 py-1.5 rounded border border-border bg-surface disabled:opacity-50"
            >
              <option value="new">{adminT('platform_admin.docs_feedback.status_new')}</option>
              <option value="pending_reply">{adminT('platform_admin.docs_feedback.status_pending_reply')}</option>
              <option value="resolved">{adminT('platform_admin.docs_feedback.status_resolved')}</option>
              <option value="hidden">{adminT('platform_admin.docs_feedback.status_hidden')}</option>
              <option value="all">{adminT('platform_admin.docs_feedback.status_all')}</option>
            </select>
          </div>
        </div>
        <div className="divide-y divide-border">
          {commentsLoading ? (
            <div className="text-center py-12 text-text-muted">{adminT('platform_admin.docs_feedback.loading_comments')}</div>
          ) : comments.length === 0 ? (
            <div className="text-center py-12 text-text-muted">{adminT('platform_admin.docs_feedback.no_comments')}</div>
          ) : (
            comments.map((c) => (
              <DocsFeedbackCommentRow
                key={c.id}
                comment={c}
                onUpdateStatus={(status) => updateStatus.mutate({ id: c.id, status })}
                isStatusPending={updateStatus.isPending && updateStatus.variables?.id === c.id}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function DocsFeedbackCommentRow({
  comment: c,
  onUpdateStatus,
  isStatusPending,
}: {
  comment: DocsFeedbackComment;
  onUpdateStatus: (status: DocsFeedbackStatus) => void;
  isStatusPending: boolean;
}) {
  const { t: adminT } = useTranslation('admin');
  const queryClient = useQueryClient();
  const [showReply, setShowReply] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [replySubject, setReplySubject] = useState('');
  const [markResolved, setMarkResolved] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const { data: repliesData, isLoading: repliesLoading } = useQuery({
    queryKey: ['docs-feedback-replies', c.id],
    queryFn: () =>
      api.get<{ replies: DocsFeedbackReply[] }>(`/docs/feedback/comments/${c.id}/replies`),
    enabled: showHistory,
  });

  const sendReply = useMutation({
    mutationFn: () =>
      api.post<{ success: boolean; message_id?: string }>(
        `/docs/feedback/comments/${c.id}/reply`,
        {
          body: replyBody,
          subject: replySubject || undefined,
          mark_resolved: markResolved,
        },
      ),
    onSuccess: () => {
      setSuccess(adminT('platform_admin.docs_feedback.reply_sent'));
      setError(null);
      setReplyBody('');
      setReplySubject('');
      setShowReply(false);
      queryClient.invalidateQueries({ queryKey: ['docs-feedback-comments'] });
      queryClient.invalidateQueries({ queryKey: ['docs-feedback-replies', c.id] });
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      setError(detail || adminT('platform_admin.docs_feedback.reply_send_failed'));
      setSuccess(null);
    },
  });

  // Cooldown timestamp (ms) until the Retry button is allowed to fire again.
  // Set from `retry_after_seconds` on a 429 (so admins don't have to click
  // to discover they're locked out) and from `retry_cooldown_seconds` on a
  // successful retry (to mirror the server-side per-feedback debounce).
  const [retryCooldownUntil, setRetryCooldownUntil] = useState(0);

  const retryReply = useMutation({
    mutationFn: () =>
      api.post<{
        success: boolean;
        message_id?: string;
        subject?: string;
        retry_cooldown_seconds?: number;
      }>(
        `/docs/feedback/comments/${c.id}/reply/retry`,
        {},
      ),
    onSuccess: (data) => {
      setSuccess(adminT('platform_admin.docs_feedback.reply_resent'));
      setError(null);
      const cooldown = readPositiveSeconds(data, 'retry_cooldown_seconds');
      if (cooldown !== null) {
        setRetryCooldownUntil(Date.now() + cooldown * 1000);
      }
      queryClient.invalidateQueries({ queryKey: ['docs-feedback-comments'] });
      queryClient.invalidateQueries({ queryKey: ['docs-feedback-replies', c.id] });
    },
    onError: (err: unknown) => {
      const status = (err as { status?: number } | null)?.status;
      const body = (err as { body?: unknown } | null)?.body;
      if (status === 429) {
        const wait = readPositiveSeconds(body, 'retry_after_seconds');
        if (wait !== null) {
          setRetryCooldownUntil(Date.now() + wait * 1000);
        }
      }
      const detail = err instanceof Error ? err.message : String(err);
      setError(detail || adminT('platform_admin.docs_feedback.reply_resend_failed'));
      setSuccess(null);
    },
  });

  const now = useCountdownTick([retryCooldownUntil]);
  const retrySecondsLeft = Math.max(0, Math.ceil((retryCooldownUntil - now) / 1000));
  const retryDisabled = retryReply.isPending || retrySecondsLeft > 0;
  const retryLabel = retryReply.isPending
    ? adminT('platform_admin.docs_feedback.retrying')
    : retrySecondsLeft > 0
      ? adminT('platform_admin.docs_feedback.retry_available_in', { seconds: retrySecondsLeft })
      : adminT('platform_admin.docs_feedback.retry_send');

  const statusBadge =
    c.status === 'resolved' ? 'bg-success-light text-success border-success/30'
      : c.status === 'hidden' ? 'bg-surface-secondary text-text-muted border-border'
      : 'bg-info-light text-info border-info/30';

  const replies = repliesData?.replies ?? [];
  const lastReplyFailed = c.last_reply_failed === true;
  // Prefer the server-computed `last_reply_permanent` field (which uses the
  // same isPermanentSmtpError classifier that gates the auto-retry digest)
  // and fall back to the client mirror only if the field is missing — e.g.
  // an old API response cached before this rolled out. Either way, the
  // background scheduler will refuse to retry, so the inbox UI must too.
  const lastReplyPermanent =
    c.last_reply_permanent === true ||
    isHardBounce({
      retry_skipped_reason: c.last_reply_retry_skipped_reason,
      email_error: c.last_reply_error,
    }) ||
    (c.last_reply_permanent == null && isPermanentSmtpError(c.last_reply_error));

  return (
    <div
      className={`px-4 py-3 ${
        lastReplyPermanent
          ? 'border-l-4 border-l-warning bg-warning-light/40'
          : lastReplyFailed
            ? 'border-l-4 border-l-danger bg-danger-light/40'
            : ''
      }`}
    >
      {lastReplyFailed && (
        <div
          className={`mb-2 flex items-start gap-2 text-xs rounded px-2 py-1.5 border ${
            lastReplyPermanent
              ? 'text-warning bg-warning-light/60 border-warning/40'
              : 'text-danger bg-danger-light/60 border-danger/30'
          }`}
        >
          <Mail className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <div className="font-semibold flex items-center gap-2 flex-wrap">
              {lastReplyPermanent ? adminT('platform_admin.docs_feedback.hard_bounce_will_not_retry') : adminT('platform_admin.docs_feedback.last_reply_failed')}
              {lastReplyPermanent ? (
                <span
                  className="px-1.5 py-0.5 rounded border border-warning/50 bg-warning-light text-warning text-[10px] uppercase tracking-wide font-semibold"
                  title={adminT('platform_admin.docs_feedback.hard_bounce_title')}
                >
                  {adminT('platform_admin.docs_feedback.hard_bounce_label')}
                </span>
              ) : (
                <span
                  className="px-1.5 py-0.5 rounded border border-danger/40 bg-danger-light text-danger text-[10px] uppercase tracking-wide font-medium"
                  title={adminT('platform_admin.docs_feedback.transient_failed_title')}
                >
                  {adminT('platform_admin.docs_feedback.failed_label_short')}
                </span>
              )}
              {/* If the reply was skipped for a non-hard-bounce reason
                  (suppression, manual cancel, unsubscribe, …) show that
                  alongside the Failed pill so ops sees *why* further auto-
                  retries won't happen, even when the SMTP error itself wasn't
                  a 5xx hard bounce. Hidden on hard bounces because the badge
                  above already explains it. */}
              {!lastReplyPermanent &&
                c.last_reply_retry_skipped_reason &&
                !isHardBounce({
                  retry_skipped_reason: c.last_reply_retry_skipped_reason,
                  email_error: c.last_reply_error,
                }) && (
                  <RetrySkippedBadge reason={c.last_reply_retry_skipped_reason} />
                )}
              {/* Auto-retry counter: shown whenever the background
                  DocsFeedbackReplyRetryScheduler has touched this reply at
                  least once. The hover title surfaces the timestamp of the
                  last attempt so an admin can tell whether the scheduler
                  just gave up (recent) or gave up an hour ago — and the
                  pill turns amber once the auto-retry cap is exhausted so
                  it matches the "auto-retries exhausted" treatment of the
                  hard-bounce badge above. */}
              <DocsFeedbackAutoRetryBadge
                retryCount={c.last_reply_retry_count}
                lastRetryAt={c.last_reply_last_retry_at}
              />
            </div>
            {c.last_reply_error && (
              <div className={lastReplyPermanent ? 'text-warning' : 'text-danger'}>
                {c.last_reply_error}
              </div>
            )}
            <div className={lastReplyPermanent ? 'text-warning/90' : 'text-danger/80'}>
              {lastReplyPermanent ? (
                <>
                  {adminT('platform_admin.docs_feedback.hard_bounce_explainer_prefix')}{' '}
                  {c.reply_email ? (
                    <a
                      href={`mailto:${c.reply_email}`}
                      title={adminT('platform_admin.docs_feedback.contact_email_title', { email: c.reply_email })}
                      className="underline font-medium text-warning hover:text-warning/80"
                    >
                      {adminT('platform_admin.docs_feedback.contact_email', { email: c.reply_email })}
                    </a>
                  ) : (
                    adminT('platform_admin.docs_feedback.no_reply_email')
                  )}
                </>
              ) : (
                adminT('platform_admin.docs_feedback.retry_or_open_form')
              )}
              {c.last_reply_at && (
                <> {adminT('platform_admin.docs_feedback.reply_attempted_at', { time: new Date(c.last_reply_at).toLocaleString() })}</>
              )}
            </div>
          </div>
          {lastReplyPermanent ? (
            <span
              className="ml-2 self-start px-2 py-1 rounded border border-warning/40 bg-warning-light text-warning text-[11px] whitespace-nowrap cursor-not-allowed"
              title={adminT('platform_admin.docs_feedback.retry_disabled_title')}
            >
              {adminT('platform_admin.docs_feedback.retry_disabled')}
            </span>
          ) : (
            <button
              type="button"
              disabled={retryDisabled}
              onClick={() => {
                setError(null);
                setSuccess(null);
                retryReply.mutate();
              }}
              title={
                retrySecondsLeft > 0
                  ? adminT('platform_admin.docs_feedback.retry_cooldown_title', { seconds: retrySecondsLeft })
                  : undefined
              }
              className="ml-2 self-start px-2 py-1 rounded border border-danger/40 bg-surface text-danger hover:bg-danger-light disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {retryLabel}
            </button>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 text-xs text-text-muted mb-1 flex-wrap">
        {c.vote === 'helpful' ? (
          <span className="inline-flex items-center gap-1 text-success"><ThumbsUp className="h-3 w-3" /> {adminT('platform_admin.docs_feedback.vote_helpful')}</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-danger"><ThumbsDown className="h-3 w-3" /> {adminT('platform_admin.docs_feedback.vote_not_helpful')}</span>
        )}
        <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide font-medium ${statusBadge}`}>
          {c.status}
        </span>
        <span className="font-mono">{c.article_slug}</span>
        {c.page_path && <span className="text-text-muted">· {c.page_path}</span>}
        {c.reply_count > 0 && (
          <span className="inline-flex items-center gap-1 text-primary">
            <Mail className="h-3 w-3" /> {adminT('platform_admin.docs_feedback.replies', { count: c.reply_count })}
          </span>
        )}
        <span className="ml-auto">{new Date(c.created_at).toLocaleString()}</span>
      </div>
      <div className="text-sm whitespace-pre-wrap">{c.comment}</div>
      {c.reply_email && (
        <div className="mt-1 text-xs text-text-muted inline-flex items-center gap-1">
          <Mail className="h-3 w-3" />
          <a href={`mailto:${c.reply_email}`} className="text-primary hover:underline">{c.reply_email}</a>
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 text-xs flex-wrap">
        {c.reply_email && (
          <button
            type="button"
            onClick={() => {
              setShowReply((v) => !v);
              setError(null);
              setSuccess(null);
            }}
            className="px-2 py-1 rounded border border-primary/30 text-primary hover:bg-primary-light"
          >
            {showReply ? adminT('platform_admin.docs_feedback.cancel_reply') : adminT('platform_admin.docs_feedback.reply_by_email')}
          </button>
        )}
        {c.reply_email && (
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="px-2 py-1 rounded border border-border hover:bg-surface-secondary"
          >
            {showHistory
              ? adminT('platform_admin.docs_feedback.hide_replies')
              : c.reply_count > 0
                ? adminT('platform_admin.docs_feedback.show_n_replies', { count: c.reply_count })
                : adminT('platform_admin.docs_feedback.show_reply_history')}
          </button>
        )}
        {c.status !== 'resolved' && (
          <button
            type="button"
            disabled={isStatusPending}
            onClick={() => onUpdateStatus('resolved')}
            className="px-2 py-1 rounded border border-border hover:bg-surface-secondary disabled:opacity-50"
          >
            {adminT('platform_admin.docs_feedback.mark_resolved')}
          </button>
        )}
        {c.status !== 'hidden' && (
          <button
            type="button"
            disabled={isStatusPending}
            onClick={() => onUpdateStatus('hidden')}
            className="px-2 py-1 rounded border border-border hover:bg-surface-secondary disabled:opacity-50"
          >
            {adminT('platform_admin.docs_feedback.hide')}
          </button>
        )}
        {c.status !== 'new' && (
          <button
            type="button"
            disabled={isStatusPending}
            onClick={() => onUpdateStatus('new')}
            className="px-2 py-1 rounded border border-border hover:bg-surface-secondary disabled:opacity-50"
          >
            {adminT('platform_admin.docs_feedback.reopen')}
          </button>
        )}
        {c.status_updated_by && c.status_updated_at && (
          <span className="text-text-muted ml-auto">
            {adminT('platform_admin.docs_feedback.status_updated_by', { status: c.status, user: c.status_updated_by, time: new Date(c.status_updated_at).toLocaleString() })}
          </span>
        )}
      </div>

      {success && <div className="mt-2 text-xs text-success">{success}</div>}

      {showReply && c.reply_email && (
        <div className="mt-3 border border-primary/30 rounded-lg bg-primary-light/30 p-3 space-y-2">
          <div className="text-xs text-text-muted">
            {adminT('platform_admin.docs_feedback.reply_will_be_sent_prefix')} <span className="font-mono">{c.reply_email}</span>.
          </div>
          <input
            type="text"
            value={replySubject}
            onChange={(e) => setReplySubject(e.target.value)}
            placeholder={adminT('platform_admin.docs_feedback.reply_subject_placeholder', { slug: c.article_slug })}
            className="w-full px-2 py-1.5 rounded border border-border text-sm bg-surface"
          />
          <textarea
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            rows={5}
            placeholder={adminT('platform_admin.docs_feedback.reply_body_placeholder')}
            className="w-full px-2 py-1.5 rounded border border-border text-sm bg-surface"
          />
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={markResolved}
              onChange={(e) => setMarkResolved(e.target.checked)}
            />
            {adminT('platform_admin.docs_feedback.mark_after_send')}
          </label>
          {error && <div className="text-xs text-danger">{error}</div>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={sendReply.isPending || replyBody.trim().length === 0}
              onClick={() => {
                setError(null);
                sendReply.mutate();
              }}
              className="px-3 py-1.5 text-sm rounded bg-primary text-on-primary hover:bg-primary-hover disabled:opacity-50"
            >
              {sendReply.isPending ? adminT('platform_admin.docs_feedback.sending') : adminT('platform_admin.docs_feedback.send_reply')}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowReply(false);
                setError(null);
              }}
              className="px-3 py-1.5 text-sm rounded border border-border hover:bg-surface-secondary"
            >
              {adminT('platform_admin.common.cancel')}
            </button>
          </div>
        </div>
      )}

      {showHistory && (
        <div className="mt-3 border border-border rounded-lg bg-surface-secondary/30 p-3 space-y-2">
          {repliesLoading ? (
            <div className="text-xs text-text-muted">{adminT('platform_admin.docs_feedback.loading_replies')}</div>
          ) : replies.length === 0 ? (
            <div className="text-xs text-text-muted">{adminT('platform_admin.docs_feedback.no_replies')}</div>
          ) : (
            groupDocsFeedbackReplyChains(replies).map((chain) => {
              const r = chain.root;
              const totalAttempts = 1 + chain.retries.length;
              return (
                <div
                  key={r.id}
                  className="text-xs border border-border rounded p-2 bg-surface"
                >
                  <div className="flex items-center gap-2 text-text-muted mb-1 flex-wrap">
                    <span>{new Date(r.created_at).toLocaleString()}</span>
                    <span>· {adminT('platform_admin.docs_feedback.from_admin_label', { user: r.sent_by ?? 'admin' })}</span>
                    <span>· {adminT('platform_admin.docs_feedback.to_label', { email: r.to_email })}</span>
                    {r.email_error
                      ? (
                        <span className="text-danger inline-flex items-center gap-1">
                          · {adminT('platform_admin.docs_feedback.failed_label', { error: r.email_error })}
                          {isHardBounce(r) && (
                            <span
                              className="px-1 py-0.5 rounded border border-warning/40 bg-warning-light text-warning text-[9px] uppercase tracking-wide font-medium"
                              title={adminT('platform_admin.docs_feedback.hard_bounce_title_short')}
                            >
                              {adminT('platform_admin.docs_feedback.hard_bounce_label')}
                            </span>
                          )}
                          {/* Render a distinct badge for any *non-hard-bounce*
                              skip reason (suppression, manual cancel, recipient
                              unsubscribed, …). Unknown future reasons fall
                              through to the generic "Auto-retry skipped" pill
                              from describeRetrySkippedReason so the row never
                              breaks if the server starts writing a new value
                              before the client knows about it. */}
                          {!isHardBounce(r) && r.retry_skipped_reason && (
                            <RetrySkippedBadge reason={r.retry_skipped_reason} size="xs" />
                          )}
                          {/* Inline auto-retry counter from the background
                              scheduler (not the same as the manual chain
                              "{N} attempts" pill below — that one counts
                              chain.retries rows, this one counts in-place
                              auto-retries on this exact row). */}
                          <DocsFeedbackAutoRetryBadge
                            retryCount={r.retry_count}
                            lastRetryAt={r.last_retry_at}
                            size="xs"
                          />
                        </span>
                      )
                      : <span className="text-success">· {adminT('platform_admin.docs_feedback.delivered')}</span>}
                    {chain.retries.length > 0 && (
                      <span
                        className="px-1.5 py-0.5 rounded border border-warning/30 bg-warning-light text-warning text-[10px] uppercase tracking-wide"
                        title={adminT('platform_admin.docs_feedback.attempts_chain_title', { count: chain.retries.length })}
                      >
                        {adminT('platform_admin.docs_feedback.attempts', { count: totalAttempts })}
                      </span>
                    )}
                  </div>
                  <div className="text-sm font-medium mb-1">{r.subject}</div>
                  <div className="text-sm whitespace-pre-wrap">{r.body}</div>
                  {chain.retries.length > 0 && (
                    <div className="mt-2 pl-3 border-l-2 border-warning/30 space-y-1">
                      <div className="text-[10px] uppercase tracking-wide text-warning font-semibold">
                        {adminT('platform_admin.docs_feedback.retries_section')}
                      </div>
                      {chain.retries.map((retry, idx) => (
                        <div
                          key={retry.id}
                          className="flex items-center gap-2 text-text-muted flex-wrap"
                        >
                          <span
                            className="px-1.5 py-0.5 rounded border border-warning/30 bg-warning-light text-warning text-[10px] uppercase tracking-wide"
                            title={adminT('platform_admin.docs_feedback.retry_title', { time: new Date(r.created_at).toLocaleString() })}
                          >
                            {adminT('platform_admin.docs_feedback.retry_n', { n: idx + 1 })}
                          </span>
                          <span>{new Date(retry.created_at).toLocaleString()}</span>
                          <span>· {adminT('platform_admin.docs_feedback.from_admin_label', { user: retry.sent_by ?? 'admin' })}</span>
                          {retry.email_error
                            ? (
                              <span className="text-danger inline-flex items-center gap-1">
                                · {adminT('platform_admin.docs_feedback.failed_label', { error: retry.email_error })}
                                {isHardBounce(retry) && (
                                  <span
                                    className="px-1 py-0.5 rounded border border-warning/40 bg-warning-light text-warning text-[9px] uppercase tracking-wide font-medium"
                                    title={adminT('platform_admin.docs_feedback.hard_bounce_title_short')}
                                  >
                                    {adminT('platform_admin.docs_feedback.hard_bounce_label')}
                                  </span>
                                )}
                                {!isHardBounce(retry) && retry.retry_skipped_reason && (
                                  <RetrySkippedBadge reason={retry.retry_skipped_reason} size="xs" />
                                )}
                                <DocsFeedbackAutoRetryBadge
                                  retryCount={retry.retry_count}
                                  lastRetryAt={retry.last_retry_at}
                                  size="xs"
                                />
                              </span>
                            )
                            : <span className="text-success">· {adminT('platform_admin.docs_feedback.delivered')}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

interface SupportTicket {
  id: string;
  tenant_id: string | null;
  tenant_name: string | null;
  user_id: string | null;
  user_email: string | null;
  plan: string | null;
  topic: string;
  message: string;
  recent_errors: string | null;
  context: Record<string, unknown> | null;
  routed_to: string;
  status: string;
  email_message_id: string | null;
  email_error: string | null;
  retry_skipped_reason: string | null;
  created_at: string;
  updated_at: string;
  // Server-side LATERAL join: surfaces the most recent outbound admin reply's
  // SMTP error and timestamp so the inbox can render hard-bounce badges
  // against replies and apply the "Hard bounces only" filter without an
  // extra round trip per row.
  last_outbound_reply_error?: string | null;
  last_outbound_reply_at?: string | null;
}

interface SupportReply {
  id: number;
  ticket_id: string;
  direction: 'outbound' | 'inbound' | 'system';
  author_user_id: string | null;
  author_email: string | null;
  body: string;
  email_message_id: string | null;
  email_error: string | null;
  /**
   * Server-computed flag (via platform/email/smtpErrorClass.isPermanentSmtpError)
   * that's true when the prior delivery error is a hard SMTP failure (5xx,
   * "no such user", mailbox full, …). When true the manual /retry endpoint
   * refuses to re-send and the row also leaves the auto-retry pool.
   */
  permanent_failure?: boolean;
  /**
   * Persisted skip reason written by the scheduler / write-paths when they
   * decide not to auto-retry (currently only `'permanent_smtp_failure'`).
   * Drives the "Hard bounce — won't auto-retry" badge directly so the UI
   * does not depend on the client-side classifier for new rows.
   */
  retry_skipped_reason: string | null;
  source: string | null;
  created_at: string;
}

function SupportInboxTab() {
  const { t: adminT } = useTranslation('admin');
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'in_progress' | 'resolved' | 'closed'>('open');
  const [hardBounceOnly, setHardBounceOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['support-tickets', statusFilter, hardBounceOnly],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('status', statusFilter);
      params.set('limit', '200');
      if (hardBounceOnly) params.set('reply_state', 'hard_bounce');
      return api.get<{ tickets: SupportTicket[] }>(`/support/tickets?${params.toString()}`);
    },
    refetchInterval: 60_000,
  });

  const { data: stats } = useQuery({
    queryKey: ['support-ticket-stats'],
    queryFn: () =>
      api.get<{
        total: number;
        open: number;
        email_failed: number;
        email_failed_open: number;
        reply_email_failed: number;
        reply_email_failed_open: number;
        hard_bounce: number;
        hard_bounce_open: number;
      }>(`/support/tickets/stats`),
    refetchInterval: 60_000,
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/support/tickets/${id}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      queryClient.invalidateQueries({ queryKey: ['support-ticket-stats'] });
    },
  });

  const tickets = data?.tickets ?? [];

  const failedCount = stats?.email_failed ?? 0;
  const failedOpenCount = stats?.email_failed_open ?? 0;
  const replyFailedCount = stats?.reply_email_failed ?? 0;
  const replyFailedOpenCount = stats?.reply_email_failed_open ?? 0;
  const hardBounceCount = stats?.hard_bounce ?? 0;
  const hardBounceOpenCount = stats?.hard_bounce_open ?? 0;
  return (
    <div className="space-y-4">
      {failedCount > 0 && (
        <div className="flex items-start gap-3 p-3 rounded-lg border border-danger/40 bg-danger-light text-danger">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <div className="font-medium">
              {adminT('platform_admin.support_inbox.banner_failed_title', { count: failedCount })}
              {failedOpenCount > 0 && failedOpenCount !== failedCount && (
                <span className="font-normal">{adminT('platform_admin.support_inbox.banner_failed_open', { count: failedOpenCount })}</span>
              )}
            </div>
            <div className="text-xs mt-0.5">
              {adminT('platform_admin.support_inbox.banner_failed_explainer')}
            </div>
          </div>
        </div>
      )}
      {replyFailedCount > 0 && (
        <div className="flex items-start gap-3 p-3 rounded-lg border border-warning/40 bg-warning-light text-warning">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <div className="font-medium">
              {adminT('platform_admin.support_inbox.banner_reply_title', { count: replyFailedCount })}
              {replyFailedOpenCount > 0 && replyFailedOpenCount !== replyFailedCount && (
                <span className="font-normal">{adminT('platform_admin.support_inbox.banner_failed_open', { count: replyFailedOpenCount })}</span>
              )}
              {hardBounceCount > 0 && (
                <>
                  {' '}<span className="font-normal text-warning">·</span>{' '}
                  <span className="font-medium">
                    {adminT('platform_admin.support_inbox.banner_hard_bounce', { count: hardBounceCount })}
                  </span>
                  {hardBounceOpenCount > 0 && hardBounceOpenCount !== hardBounceCount && (
                    <span className="font-normal">{adminT('platform_admin.support_inbox.banner_failed_open', { count: hardBounceOpenCount })}</span>
                  )}
                </>
              )}
            </div>
            <div className="text-xs mt-0.5">
              {adminT('platform_admin.support_inbox.banner_reply_explainer')}
              {hardBounceCount > 0 && (
                <>{adminT('platform_admin.support_inbox.banner_hard_bounce_focus')}</>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex gap-2">
          {(['open', 'in_progress', 'resolved', 'closed', 'all'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-sm rounded-lg border ${
                statusFilter === s
                  ? 'bg-primary text-on-primary border-primary'
                  : 'bg-surface border-border text-text-muted hover:text-text-primary'
              }`}
            >
              {adminT(`platform_admin.support_inbox.filter_${s}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-1.5 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={hardBounceOnly}
              onChange={(e) => setHardBounceOnly(e.target.checked)}
            />
            <span className={hardBounceOnly ? 'text-danger font-medium' : ''}>
              {adminT('platform_admin.support_inbox.hard_bounce_only')}
              {/* The count next to this label has to be the global hard-bounce
                  total (status-agnostic) — the stats endpoint isn't
                  status-scoped, and showing "(7)" while the visible "open"
                  inbox only contains 2 of them would look inconsistent. To
                  avoid that confusion we only surface the count when the
                  status filter is "all" (the visible list matches the global
                  count) or when the hard-bounce filter is already on (the
                  user is explicitly asking for the global subset). */}
              {hardBounceCount > 0 && (statusFilter === 'all' || hardBounceOnly) && (
                <span className="ml-1 text-text-muted font-normal">({hardBounceCount})</span>
              )}
            </span>
          </label>
          <div className="text-xs text-text-muted">{adminT('platform_admin.support_inbox.tickets_count', { count: tickets.length })}</div>
        </div>
      </div>

      <BouncedRecipientsPanel
        onOpenTicket={(ticketId) => {
          setStatusFilter('all');
          setHardBounceOnly(false);
          setExpandedId(ticketId);
        }}
      />

      <UnsubscribedAddressesPanel />

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-secondary">
              <th className="w-8 px-2"></th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.header_ticket')}</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.header_from')}</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.header_topic')}</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.header_plan')}</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.header_routed_to')}</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.header_status')}</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.header_created')}</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.header_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={9} className="text-center py-12 text-text-muted">{adminT('platform_admin.support_inbox.loading_tickets')}</td></tr>
            ) : tickets.length === 0 ? (
              <tr><td colSpan={9} className="text-center py-12 text-text-muted">{adminT('platform_admin.support_inbox.no_tickets')}</td></tr>
            ) : (
              tickets.map((t) => (
                <Fragment key={t.id}>
                  <tr className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                    <td className="px-2">
                      <button
                        onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                        className="p-1 rounded hover:bg-surface-secondary"
                      >
                        {expandedId === t.id
                          ? <ChevronDown className="h-4 w-4 text-text-muted" />
                          : <ChevronRight className="h-4 w-4 text-text-muted" />}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs">{t.id}</div>
                      {t.email_error && (
                        <div
                          className="text-xs text-danger mt-1 flex items-center gap-1 flex-wrap"
                          title={t.email_error}
                        >
                          <AlertCircle className="h-3 w-3" />
                          {isHardBounce(t)
                            ? adminT('platform_admin.support_inbox.email_failed_hard_bounce')
                            : adminT('platform_admin.support_inbox.email_failed')}
                          {/* Surface non-hard-bounce skip reasons (suppression,
                              manual cancel, unsubscribe, …) as a distinct pill
                              so ops can triage from the row without expanding
                              the ticket. Unknown reasons fall through to the
                              generic "Auto-retry skipped" badge. */}
                          {!isHardBounce(t) && t.retry_skipped_reason && (
                            <RetrySkippedBadge reason={t.retry_skipped_reason} size="xs" />
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div>{t.user_email ?? adminT('platform_admin.common.em_dash')}</div>
                      <div className="text-xs text-text-muted">{t.tenant_name ?? t.tenant_id ?? adminT('platform_admin.common.em_dash')}</div>
                    </td>
                    <td className="px-4 py-3">{t.topic}</td>
                    <td className="px-4 py-3"><PlanBadge plan={t.plan ?? 'trial'} /></td>
                    <td className="px-4 py-3 text-text-muted text-xs">{t.routed_to}</td>
                    <td className="px-4 py-3">
                      <select
                        value={t.status}
                        onChange={(e) => updateStatus.mutate({ id: t.id, status: e.target.value })}
                        className="text-xs px-2 py-1 rounded border border-border bg-surface"
                      >
                        <option value="open">{adminT('platform_admin.support_inbox.status_open')}</option>
                        <option value="in_progress">{adminT('platform_admin.support_inbox.status_in_progress')}</option>
                        <option value="resolved">{adminT('platform_admin.support_inbox.status_resolved')}</option>
                        <option value="closed">{adminT('platform_admin.support_inbox.status_closed')}</option>
                      </select>
                    </td>
                    <td className="px-4 py-3 text-text-muted text-xs">{new Date(t.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      {t.user_email && (
                        <button
                          onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-primary text-on-primary hover:opacity-90"
                        >
                          <Mail className="h-3 w-3" /> {adminT('platform_admin.support_inbox.reply')}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedId === t.id && (
                    <tr className="bg-surface-secondary/30">
                      <td colSpan={9} className="px-6 py-4">
                        <TicketThread ticket={t} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface BouncedRecipientTicket {
  ticket_id: string;
  ticket_status: string;
  occurrence_count: number;
  last_failure_at: string;
  last_error: string;
}

interface SuppressionEntry {
  email_lower: string;
  reason: string;
  source: string | null;
  last_error: string | null;
  added_at: string;
  added_by_user_id: string | null;
  notes: string | null;
}

interface BouncedRecipient {
  user_email: string;
  occurrence_count: number;
  last_failure_at: string;
  last_error: string;
  ticket_count: number;
  tickets: BouncedRecipientTicket[];
  // ISO timestamp of when ops was first paged about this address. Null
  // means the per-recipient first-bounce alert hasn't fired yet for this
  // recipient, e.g. the address is being shown only because of bounces
  // recorded before the alert pipeline shipped. Populated server-side from
  // the `support_recipient_bounce_alerts` dedup table.
  alerted_at: string | null;
  suppression: SuppressionEntry | null;
}

interface BouncedRecipientsResponse {
  recipients: BouncedRecipient[];
  total: number;
  truncated: boolean;
}

function SuppressedBadge({
  suppression,
  size = 'sm',
}: {
  suppression: SuppressionEntry;
  size?: 'xs' | 'sm';
}) {
  const { t: adminT } = useTranslation('admin');
  const wasManual = !!suppression.added_by_user_id;
  const tooltipParts = [
    wasManual
      ? adminT('platform_admin.support_inbox.suppressed_by_admin_tt', { user: suppression.added_by_user_id ?? '?' })
      : adminT('platform_admin.support_inbox.auto_suppressed_tt', { source: suppression.source ?? 'system' }),
    adminT('platform_admin.support_inbox.added_at_tt', { time: new Date(suppression.added_at).toLocaleString() }),
    adminT('platform_admin.support_inbox.reason_tt', { reason: suppression.reason }),
  ];
  if (suppression.notes) tooltipParts.push(adminT('platform_admin.support_inbox.notes_tt', { notes: suppression.notes }));
  const padding = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border border-warning/40 bg-warning-light text-warning ${padding}`}
      title={tooltipParts.join(' · ')}
    >
      <ShieldOff className={size === 'xs' ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
      {wasManual ? adminT('platform_admin.support_inbox.suppressed_by_ops') : adminT('platform_admin.support_inbox.suppressed')}
    </span>
  );
}

function BouncedRecipientsPanel({
  onOpenTicket,
}: {
  onOpenTicket: (ticketId: string) => void;
}) {
  const { t: adminT } = useTranslation('admin');
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [openEmails, setOpenEmails] = useState<Set<string>>(new Set());
  // Per-row "show notes input" toggle. Drafts are kept here so flipping
  // between rows doesn't blow away half-typed text. Cleared after a
  // successful suppress so the next click on the same address starts blank.
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [showNoteFor, setShowNoteFor] = useState<string | null>(null);
  // Per-row error surface so a failed suppress / unsuppress doesn't get
  // silently swallowed — keyed on the lowercased email so the badge change
  // doesn't lose track of which row failed.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['support-bounced-recipients'],
    queryFn: () =>
      api.get<BouncedRecipientsResponse>(
        `/support/replies/bounced-recipients?limit=200`,
      ),
    refetchInterval: 60_000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['support-bounced-recipients'] });
    // Refresh any open ticket thread so the in-thread suppression badge
    // updates without a manual reload.
    queryClient.invalidateQueries({ queryKey: ['support-ticket-replies'] });
  };

  // Drops the dedup row in `support_recipient_bounce_alerts` so the next
  // bounce on this address re-fires the per-recipient first-bounce ops
  // alert. Optimistically clears `alerted_at` in the cached panel data so
  // the badge disappears immediately without waiting for the 60s refetch.
  const clearAlert = useMutation({
    mutationFn: (email: string) =>
      api.delete<{ cleared: boolean; email_lower: string }>(
        `/support/replies/bounced-recipients/${encodeURIComponent(email)}/alert`,
      ),
    onSuccess: (_data, email) => {
      queryClient.setQueryData<BouncedRecipientsResponse>(
        ['support-bounced-recipients'],
        (prev) => {
          if (!prev) return prev;
          const lower = email.trim().toLowerCase();
          return {
            ...prev,
            recipients: prev.recipients.map((r) =>
              r.user_email.trim().toLowerCase() === lower
                ? { ...r, alerted_at: null }
                : r,
            ),
          };
        },
      );
    },
  });

  const suppressMutation = useMutation({
    mutationFn: ({ email, notes }: { email: string; notes: string | null }) =>
      api.post<{ success: boolean; suppression: SuppressionEntry | null }>(
        `/support/email-suppressions`,
        { email, notes: notes ?? undefined },
      ),
    onSuccess: (_data, vars) => {
      const key = vars.email.toLowerCase();
      setRowErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setNoteDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setShowNoteFor((cur) => (cur === key ? null : cur));
      invalidate();
    },
    onError: (err, vars) => {
      const key = vars.email.toLowerCase();
      setRowErrors((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : adminT('platform_admin.support_inbox.suppress_failed'),
      }));
    },
  });

  const unsuppressMutation = useMutation({
    mutationFn: (email: string) =>
      api.delete<{ success: boolean }>(
        `/support/email-suppressions/${encodeURIComponent(email.toLowerCase())}`,
      ),
    onSuccess: (_data, email) => {
      const key = email.toLowerCase();
      setRowErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      invalidate();
    },
    onError: (err, email) => {
      const key = email.toLowerCase();
      setRowErrors((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : adminT('platform_admin.support_inbox.unsuppress_failed'),
      }));
    },
  });

  const recipients = data?.recipients ?? [];
  const total = data?.total ?? 0;
  const truncated = data?.truncated ?? false;

  // Hide the section entirely when there's nothing to act on — admins don't
  // need a "0 recipients" placeholder cluttering the inbox in the happy case.
  if (!isLoading && recipients.length === 0) {
    return null;
  }

  const toggleEmail = (email: string) => {
    setOpenEmails((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  };

  return (
    // The id is the scroll target for the "Recipients ever hard-bounced"
    // dashboard card — clicking the card switches to the support tab and
    // calls scrollIntoView on this element.
    <div
      id="bounced-recipients-panel"
      className="bg-surface border border-border rounded-xl overflow-hidden scroll-mt-4"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-secondary border-b border-border hover:bg-surface-secondary/70"
      >
        <div className="flex items-center gap-2 text-left">
          {expanded
            ? <ChevronDown className="h-4 w-4 text-text-muted" />
            : <ChevronRight className="h-4 w-4 text-text-muted" />}
          <ShieldAlert className="h-4 w-4 text-danger" />
          <div>
            <div className="text-sm font-medium">
              {adminT('platform_admin.support_inbox.bounced_title')}
              <span className="ml-2 text-xs text-text-muted font-normal">
                {isLoading
                  ? adminT('platform_admin.support_inbox.bounced_loading')
                  : adminT('platform_admin.support_inbox.bounced_count', { count: total })}
                {truncated && adminT('platform_admin.support_inbox.bounced_truncated', { count: 200 })}
              </span>
            </div>
            <div className="text-xs text-text-muted mt-0.5">
              {adminT('platform_admin.support_inbox.bounced_subtitle')}
            </div>
          </div>
        </div>
      </button>
      {expanded && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface">
              <th className="w-8 px-2"></th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.bounced_header_recipient')}</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.bounced_header_failures')}</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.bounced_header_tickets')}</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.bounced_header_last_failure')}</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.bounced_header_alerted')}</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.bounced_header_recent_error')}</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.bounced_header_suppression')}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="text-center py-8 text-text-muted">{adminT('platform_admin.support_inbox.loading_short')}</td></tr>
            ) : (
              recipients.map((r) => {
                const key = r.user_email.toLowerCase();
                const isSuppressed = !!r.suppression;
                const noteOpen = showNoteFor === key;
                const draft = noteDrafts[key] ?? '';
                const rowError = rowErrors[key];
                const suppressing =
                  suppressMutation.isPending &&
                  suppressMutation.variables?.email.toLowerCase() === key;
                const unsuppressing =
                  unsuppressMutation.isPending &&
                  unsuppressMutation.variables?.toLowerCase() === key;
                return (
                <Fragment key={r.user_email}>
                  <tr className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                    <td className="px-2">
                      <button
                        type="button"
                        onClick={() => toggleEmail(r.user_email)}
                        className="p-1 rounded hover:bg-surface-secondary"
                        aria-label={openEmails.has(r.user_email) ? adminT('platform_admin.support_inbox.collapse_tickets') : adminT('platform_admin.support_inbox.expand_tickets')}
                      >
                        {openEmails.has(r.user_email)
                          ? <ChevronDown className="h-4 w-4 text-text-muted" />
                          : <ChevronRight className="h-4 w-4 text-text-muted" />}
                      </button>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span>{r.user_email}</span>
                        {isSuppressed && (
                          <SuppressedBadge suppression={r.suppression!} size="xs" />
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-danger-light text-danger">
                        <AlertCircle className="h-3 w-3" />
                        {r.occurrence_count}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted">
                      {adminT('platform_admin.support_inbox.tickets_inline', { count: r.ticket_count })}
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted">
                      {new Date(r.last_failure_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {r.alerted_at ? (
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-warning-light text-warning"
                            title={adminT('platform_admin.support_inbox.alerted_title', { time: new Date(r.alerted_at).toLocaleString() })}
                          >
                            <ShieldAlert className="h-3 w-3" />
                            {adminT('platform_admin.support_inbox.alerted')}
                          </span>
                          <button
                            type="button"
                            onClick={() => clearAlert.mutate(r.user_email)}
                            disabled={
                              clearAlert.isPending &&
                              clearAlert.variables === r.user_email
                            }
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-border hover:bg-surface-secondary disabled:opacity-50"
                            title={adminT('platform_admin.support_inbox.clear_alert_title')}
                          >
                            {clearAlert.isPending &&
                            clearAlert.variables === r.user_email
                              ? adminT('platform_admin.support_inbox.clearing')
                              : adminT('platform_admin.support_inbox.clear_alert')}
                          </button>
                        </div>
                      ) : (
                        <span className="text-text-muted">{adminT('platform_admin.common.em_dash')}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-danger max-w-md truncate" title={r.last_error}>
                      {r.last_error}
                    </td>
                    <td className="px-4 py-3">
                      {/* Suppress / Unsuppress action. Suppression is reversible
                          (DELETE removes the row) but unsubscribes are not — we
                          never expose an unsubscribe-clear button here on
                          purpose, see the helper docstrings. */}
                      <div className="flex flex-col gap-1">
                        {isSuppressed ? (
                          <button
                            type="button"
                            disabled={unsuppressing}
                            onClick={() => unsuppressMutation.mutate(r.user_email)}
                            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-border bg-surface hover:bg-surface-secondary disabled:opacity-50"
                            title={adminT('platform_admin.support_inbox.unsuppress_title')}
                          >
                            <RotateCw className={`h-3 w-3 ${unsuppressing ? 'animate-spin' : ''}`} />
                            {unsuppressing ? adminT('platform_admin.support_inbox.unsuppressing') : adminT('platform_admin.support_inbox.unsuppress')}
                          </button>
                        ) : noteOpen ? (
                          <div className="flex flex-col gap-1">
                            <textarea
                              value={draft}
                              onChange={(e) =>
                                setNoteDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                              }
                              maxLength={1000}
                              rows={2}
                              placeholder={adminT('platform_admin.support_inbox.suppress_note_placeholder')}
                              className="text-xs px-2 py-1 rounded border border-border bg-surface w-56"
                            />
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                disabled={suppressing}
                                onClick={() =>
                                  suppressMutation.mutate({
                                    email: r.user_email,
                                    notes: draft.trim() ? draft.trim() : null,
                                  })
                                }
                                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-warning-light text-warning border border-warning/40 hover:bg-warning/20 disabled:opacity-50 font-medium"
                              >
                                <ShieldOff className="h-3 w-3" />
                                {suppressing ? adminT('platform_admin.support_inbox.suppressing') : adminT('platform_admin.support_inbox.suppress_confirm')}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setShowNoteFor(null);
                                }}
                                className="text-xs px-2 py-1 rounded border border-border hover:bg-surface-secondary"
                              >
                                {adminT('platform_admin.support_inbox.suppress_cancel')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setShowNoteFor(key)}
                            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-warning/40 bg-warning-light text-warning hover:bg-warning/20"
                            title={adminT('platform_admin.support_inbox.suppress_title')}
                          >
                            <ShieldOff className="h-3 w-3" />
                            {adminT('platform_admin.support_inbox.suppress')}
                          </button>
                        )}
                        {rowError && (
                          <div className="text-[10px] text-danger" title={rowError}>
                            {rowError}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                  {openEmails.has(r.user_email) && (
                    <tr className="bg-surface-secondary/30">
                      <td colSpan={7} className="px-6 py-3">
                        <div className="text-xs text-text-muted mb-2">
                          {adminT('platform_admin.support_inbox.affected_tickets')}
                        </div>
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-text-muted">
                              <th className="text-left py-1 font-medium">{adminT('platform_admin.support_inbox.inline_header_ticket')}</th>
                              <th className="text-left py-1 font-medium">{adminT('platform_admin.support_inbox.inline_header_status')}</th>
                              <th className="text-left py-1 font-medium">{adminT('platform_admin.support_inbox.inline_header_failures')}</th>
                              <th className="text-left py-1 font-medium">{adminT('platform_admin.support_inbox.inline_header_last_failure')}</th>
                              <th className="text-left py-1 font-medium">{adminT('platform_admin.support_inbox.inline_header_last_error')}</th>
                              <th className="py-1"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.tickets.map((tk) => (
                              <tr key={tk.ticket_id} className="border-t border-border/50">
                                <td className="py-1.5 pr-3 font-mono">{tk.ticket_id}</td>
                                <td className="py-1.5 pr-3">{tk.ticket_status}</td>
                                <td className="py-1.5 pr-3">{tk.occurrence_count}</td>
                                <td className="py-1.5 pr-3 text-text-muted">
                                  {new Date(tk.last_failure_at).toLocaleString()}
                                </td>
                                <td
                                  className="py-1.5 pr-3 text-danger max-w-xs truncate"
                                  title={tk.last_error}
                                >
                                  {tk.last_error}
                                </td>
                                <td className="py-1.5">
                                  <button
                                    type="button"
                                    onClick={() => onOpenTicket(tk.ticket_id)}
                                    className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-border hover:bg-surface"
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                    {adminT('platform_admin.support_inbox.open_ticket')}
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface UnsubscribedAddress {
  email_lower: string;
  source: string | null;
  unsubscribed_at: string;
}

interface RecentResubscribe {
  email_lower: string;
  resubscribed_source: string | null;
  resubscribed_at: string;
  previous_unsubscribed_at: string | null;
  previous_source: string | null;
}

interface UnsubscribedAddressesResponse {
  unsubscribes: UnsubscribedAddress[];
  total: number;
  truncated: boolean;
  recent_resubscribes?: RecentResubscribe[];
  resubscribe_window_days?: number;
  recent_resubscribes_truncated?: boolean;
}

// Lists addresses on the support unsubscribe list. The send-side gate
// (`checkSupportEmailSkip`) already blocks outbound mail to these recipients;
// this panel just gives ops a discoverable answer to "is X@Y opted out?"
// without dropping into SQL.
//
// We also surface a "Recently resubscribed" sub-section sourced from the
// `support_email_unsubscribe_audit` table. The resubscribe endpoint
// DELETEs the unsubscribe row, so without this audit trail an address
// would just silently disappear from the list with no explanation —
// support reps couldn't answer "I thought I asked to stop" complaints
// without grepping server logs. The window is 30 days (server-side
// constant), long enough to cover a typical complaint cycle.
function UnsubscribedAddressesPanel() {
  const { t: adminT } = useTranslation('admin');
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['support-unsubscribed-addresses'],
    queryFn: () =>
      api.get<UnsubscribedAddressesResponse>(`/support/unsubscribed?limit=200`),
    refetchInterval: 60_000,
  });

  const unsubscribes = data?.unsubscribes ?? [];
  const total = data?.total ?? 0;
  const truncated = data?.truncated ?? false;
  const recentResubscribes = data?.recent_resubscribes ?? [];
  const resubscribeWindowDays = data?.resubscribe_window_days ?? 30;
  const recentResubscribesTruncated = data?.recent_resubscribes_truncated ?? false;

  // Hide the panel entirely only when BOTH lists are empty — a recent
  // resubscribe is itself useful context for ops ("the address you're
  // hunting for came off the list two days ago"), so we keep the panel
  // visible whenever either list has content. The inbox still stays
  // uncluttered in the truly-quiet case.
  if (!isLoading && unsubscribes.length === 0 && recentResubscribes.length === 0) {
    return null;
  }

  const needle = filter.trim().toLowerCase();
  const filteredUnsubs = needle
    ? unsubscribes.filter((u) => u.email_lower.includes(needle))
    : unsubscribes;
  const filteredResubs = needle
    ? recentResubscribes.filter((r) => r.email_lower.includes(needle))
    : recentResubscribes;

  const summaryParts: string[] = [];
  if (isLoading) {
    summaryParts.push(adminT('platform_admin.support_inbox.bounced_loading'));
  } else {
    summaryParts.push(
      adminT('platform_admin.support_inbox.unsubs_count', { count: total }),
    );
    if (truncated) {
      summaryParts.push(adminT('platform_admin.support_inbox.unsubs_showing_first', { count: unsubscribes.length }));
    }
    if (recentResubscribes.length > 0) {
      summaryParts.push(
        adminT('platform_admin.support_inbox.unsubs_resubs_summary', {
          count: recentResubscribes.length,
          plus: recentResubscribesTruncated ? '+' : '',
          days: resubscribeWindowDays,
        }),
      );
    }
  }

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-secondary border-b border-border hover:bg-surface-secondary/70"
      >
        <div className="flex items-center gap-2 text-left">
          {expanded
            ? <ChevronDown className="h-4 w-4 text-text-muted" />
            : <ChevronRight className="h-4 w-4 text-text-muted" />}
          <MailX className="h-4 w-4 text-warning" />
          <div>
            <div className="text-sm font-medium">
              {adminT('platform_admin.support_inbox.unsubs_title')}
              <span className="ml-2 text-xs text-text-muted font-normal">
                {summaryParts.join(' · ')}
              </span>
            </div>
            <div className="text-xs text-text-muted mt-0.5">
              {adminT('platform_admin.support_inbox.unsubs_subtitle')}
            </div>
          </div>
        </div>
      </button>
      {expanded && (
        <div>
          <div className="px-4 py-2 border-b border-border bg-surface">
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={adminT('platform_admin.support_inbox.unsubs_filter_placeholder')}
              className="w-full max-w-sm text-xs px-2 py-1 rounded border border-border bg-surface"
            />
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface">
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.unsubs_header_address')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.unsubs_header_source')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.unsubs_header_unsubscribed_at')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={3} className="text-center py-8 text-text-muted">{adminT('platform_admin.support_inbox.loading_short')}</td></tr>
              ) : filteredUnsubs.length === 0 ? (
                <tr><td colSpan={3} className="text-center py-8 text-text-muted">{adminT('platform_admin.support_inbox.unsubs_no_match')}</td></tr>
              ) : (
                filteredUnsubs.map((u) => (
                  <tr
                    key={u.email_lower}
                    className="border-b border-border last:border-0 hover:bg-surface-secondary/50"
                  >
                    <td className="px-4 py-3 font-mono text-xs">{u.email_lower}</td>
                    <td className="px-4 py-3 text-xs text-text-muted">
                      {u.source ?? adminT('platform_admin.common.em_dash')}
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted">
                      {new Date(u.unsubscribed_at).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {/* "Recently resubscribed" — populated from the audit table. We
              render it as a separate sub-section below the active opt-out
              list (instead of mixing the two) because the row meanings
              are different: the top table is "currently blocked", this
              one is "previously blocked but opted back in". Conflating
              them would make the first table lie about the live state of
              the send-side gate. */}
          {recentResubscribes.length > 0 && (
            <div>
              <div className="px-4 py-3 border-y border-border bg-surface-secondary/40">
                <div className="text-xs font-medium text-text-muted">
                  {adminT('platform_admin.support_inbox.resubs_title', { days: resubscribeWindowDays })}
                </div>
                <div className="text-[11px] text-text-muted mt-0.5">
                  {adminT('platform_admin.support_inbox.resubs_subtitle')}
                </div>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface">
                    <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.resubs_header_address')}</th>
                    <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.resubs_header_via')}</th>
                    <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.resubs_header_at')}</th>
                    <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.support_inbox.resubs_header_originally')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredResubs.length === 0 ? (
                    <tr><td colSpan={4} className="text-center py-6 text-text-muted">{adminT('platform_admin.support_inbox.resubs_no_match')}</td></tr>
                  ) : (
                    filteredResubs.map((r) => (
                      <tr
                        key={`${r.email_lower}-${r.resubscribed_at}`}
                        className="border-b border-border last:border-0 hover:bg-surface-secondary/50"
                      >
                        <td className="px-4 py-3 font-mono text-xs">{r.email_lower}</td>
                        <td className="px-4 py-3 text-xs text-text-muted">
                          {r.resubscribed_source ?? adminT('platform_admin.common.em_dash')}
                        </td>
                        <td className="px-4 py-3 text-xs text-text-muted">
                          {new Date(r.resubscribed_at).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-xs text-text-muted">
                          {r.previous_unsubscribed_at
                            ? (
                              <>
                                {new Date(r.previous_unsubscribed_at).toLocaleString()}
                                {r.previous_source ? (
                                  <span className="ml-1 text-[11px]">
                                    {adminT('platform_admin.support_inbox.resubs_via_inline', { source: r.previous_source })}
                                  </span>
                                ) : null}
                              </>
                            )
                            : adminT('platform_admin.common.em_dash')}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TicketThread({ ticket }: { ticket: SupportTicket }) {
  const { t: adminT } = useTranslation('admin');
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['support-ticket-replies', ticket.id],
    queryFn: () =>
      api.get<{ replies: SupportReply[]; suppression: SuppressionEntry | null }>(
        `/support/tickets/${ticket.id}/replies`,
      ),
    refetchInterval: 30_000,
  });

  // Suppression state for the ticket recipient. Drives the "Suppressed by
  // ops" pill above the conversation and the in-thread Suppress / Unsuppress
  // toggle. The mutations target the same admin endpoints as the Bounced
  // recipients panel, so a change in either place reflects in the other on
  // the next invalidation.
  const [threadSuppressError, setThreadSuppressError] = useState<string | null>(null);
  const [threadNoteOpen, setThreadNoteOpen] = useState(false);
  const [threadNoteDraft, setThreadNoteDraft] = useState('');

  const suppressFromThread = useMutation({
    mutationFn: ({ email, notes }: { email: string; notes: string | null }) =>
      api.post<{ success: boolean }>(`/support/email-suppressions`, {
        email,
        notes: notes ?? undefined,
      }),
    onSuccess: () => {
      setThreadSuppressError(null);
      setThreadNoteOpen(false);
      setThreadNoteDraft('');
      queryClient.invalidateQueries({ queryKey: ['support-ticket-replies', ticket.id] });
      queryClient.invalidateQueries({ queryKey: ['support-bounced-recipients'] });
    },
    onError: (err) => {
      setThreadSuppressError(err instanceof Error ? err.message : adminT('platform_admin.support_inbox.suppress_failed'));
    },
  });

  const unsuppressFromThread = useMutation({
    mutationFn: (email: string) =>
      api.delete<{ success: boolean }>(
        `/support/email-suppressions/${encodeURIComponent(email.toLowerCase())}`,
      ),
    onSuccess: () => {
      setThreadSuppressError(null);
      queryClient.invalidateQueries({ queryKey: ['support-ticket-replies', ticket.id] });
      queryClient.invalidateQueries({ queryKey: ['support-bounced-recipients'] });
    },
    onError: (err) => {
      setThreadSuppressError(err instanceof Error ? err.message : adminT('platform_admin.support_inbox.unsuppress_failed'));
    },
  });

  const sendReply = useMutation({
    mutationFn: (body: string) =>
      api.post<{ success: boolean; email_delivered: boolean; reply: SupportReply }>(
        `/support/tickets/${ticket.id}/replies`,
        { body },
      ),
    onSuccess: () => {
      setDraft('');
      queryClient.invalidateQueries({ queryKey: ['support-ticket-replies', ticket.id] });
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
    },
  });

  const changeStatus = useMutation({
    mutationFn: (status: string) =>
      api.patch(`/support/tickets/${ticket.id}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-ticket-replies', ticket.id] });
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      queryClient.invalidateQueries({ queryKey: ['support-ticket-stats'] });
    },
  });

  // Track which reply id is mid-retry and per-reply error text. Multiple
  // failed replies in the same thread can each have their own retry button.
  const [retryingReplyId, setRetryingReplyId] = useState<number | null>(null);
  const [retryErrors, setRetryErrors] = useState<Record<number, string>>({});
  // Tracks which reply (if any) is currently being marked as "stop auto-
  // retrying" so we can disable the button + show a spinning indicator.
  // Errors from that endpoint are surfaced inline next to the row.
  const [cancellingReplyId, setCancellingReplyId] = useState<number | null>(null);
  const [cancelErrors, setCancelErrors] = useState<Record<number, string>>({});
  // Per-reply cooldown timestamps (ms) until the corresponding Retry button
  // is allowed to fire again. Populated from `retry_after_seconds` on a 429
  // and from `retry_cooldown_seconds` on a successful retry, so admins see
  // the same per-reply cooldown the server enforces without round-tripping a
  // click first.
  const [retryCooldownByReply, setRetryCooldownByReply] = useState<Record<number, number>>({});

  const retryReply = useMutation({
    mutationFn: (replyId: number) =>
      api.post<{
        success: boolean;
        email_delivered: boolean;
        reply: SupportReply;
        retry_cooldown_seconds?: number;
      }>(
        `/support/tickets/${ticket.id}/replies/${replyId}/retry`,
        {},
      ),
    onMutate: (replyId) => {
      setRetryingReplyId(replyId);
      setRetryErrors((prev) => {
        if (!(replyId in prev)) return prev;
        const next = { ...prev };
        delete next[replyId];
        return next;
      });
    },
    onSuccess: (data, replyId) => {
      // Whether the retry delivered or not, the server has already updated the
      // existing reply row with the latest email_message_id / email_error and
      // we'll re-render it via the invalidated query — no extra inline error
      // is needed here (it would just duplicate the "Email delivery error: …"
      // line below the body).
      setRetryErrors((prev) => {
        if (!(replyId in prev)) return prev;
        const next = { ...prev };
        delete next[replyId];
        return next;
      });
      const cooldown = readPositiveSeconds(data, 'retry_cooldown_seconds');
      if (cooldown !== null) {
        const until = Date.now() + cooldown * 1000;
        setRetryCooldownByReply((prev) => ({ ...prev, [replyId]: until }));
      }
      queryClient.invalidateQueries({ queryKey: ['support-ticket-replies', ticket.id] });
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      queryClient.invalidateQueries({ queryKey: ['support-ticket-stats'] });
    },
    onError: (err, replyId) => {
      const status = (err as { status?: number } | null)?.status;
      const body = (err as { body?: unknown } | null)?.body;
      if (status === 429) {
        const wait = readPositiveSeconds(body, 'retry_after_seconds');
        if (wait !== null) {
          const until = Date.now() + wait * 1000;
          setRetryCooldownByReply((prev) => ({ ...prev, [replyId]: until }));
        }
      }
      // The HTTP call itself failed (network error, 5xx, etc.) so the row
      // state on the server didn't change — surface the transport error
      // inline so the admin knows the retry never actually ran.
      setRetryErrors((prev) => ({
        ...prev,
        [replyId]: err instanceof Error ? err.message : adminT('platform_admin.support_inbox.retry_failed_short'),
      }));
    },
    onSettled: () => {
      setRetryingReplyId(null);
    },
  });

  // Manual "Stop auto-retries" — flips `retry_skipped_reason` to
  // `'manual_cancel'` on the server so the SupportReplyRetryScheduler will
  // skip this reply on its next sweep. Useful when ops has already replied
  // through another channel and doesn't want the customer to receive another
  // automated retry. The server returns the updated row so we can
  // invalidate the same caches as a successful retry.
  const cancelRetries = useMutation({
    mutationFn: (replyId: number) =>
      api.post<{ success: boolean; reply: SupportReply }>(
        `/support/tickets/${ticket.id}/replies/${replyId}/cancel-retries`,
        {},
      ),
    onMutate: (replyId) => {
      setCancellingReplyId(replyId);
      setCancelErrors((prev) => {
        if (!(replyId in prev)) return prev;
        const next = { ...prev };
        delete next[replyId];
        return next;
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-ticket-replies', ticket.id] });
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      queryClient.invalidateQueries({ queryKey: ['support-ticket-stats'] });
    },
    onError: (err, replyId) => {
      setCancelErrors((prev) => ({
        ...prev,
        [replyId]: err instanceof Error ? err.message : adminT('platform_admin.support_inbox.cancel_failed_short'),
      }));
    },
    onSettled: () => {
      setCancellingReplyId(null);
    },
  });

  // Drive the per-row "Retry available in Xs" countdown by ticking once a
  // second while at least one reply still has time left on its cooldown.
  const nowMs = useCountdownTick(Object.values(retryCooldownByReply));

  const isResolved = ticket.status === 'resolved' || ticket.status === 'closed';

  const replies = data?.replies ?? [];
  const suppression = data?.suppression ?? null;
  const trimmed = draft.trim();
  const sendError = sendReply.error instanceof Error ? sendReply.error.message : null;
  const lastReply = sendReply.data;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div className="space-y-3">
        <div>
          <div className="text-xs font-medium text-text-muted mb-1">{adminT('platform_admin.support_inbox.thread_original_message')}</div>
          <pre className="whitespace-pre-wrap text-sm bg-surface p-3 rounded border border-border">{ticket.message}</pre>
          <div className="text-xs text-text-muted mt-1 flex items-center gap-2 flex-wrap">
            <span>
              {ticket.user_email ?? adminT('platform_admin.common.em_dash')} · {new Date(ticket.created_at).toLocaleString()}
            </span>
            {suppression && <SuppressedBadge suppression={suppression} size="xs" />}
          </div>
          {/* In-thread suppress / unsuppress controls. Placed next to the
              recipient identity so the action is obvious in context — admins
              don't have to scroll back up to the Bounced recipients panel
              to flip the flag for the address they're already looking at. */}
          {ticket.user_email && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              {suppression ? (
                <button
                  type="button"
                  disabled={unsuppressFromThread.isPending}
                  onClick={() => unsuppressFromThread.mutate(ticket.user_email!)}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-border bg-surface hover:bg-surface-secondary disabled:opacity-50"
                  title={adminT('platform_admin.support_inbox.unsuppress_title')}
                >
                  <RotateCw className={`h-3 w-3 ${unsuppressFromThread.isPending ? 'animate-spin' : ''}`} />
                  {unsuppressFromThread.isPending ? adminT('platform_admin.support_inbox.unsuppressing') : adminT('platform_admin.support_inbox.thread_unsuppress_recipient')}
                </button>
              ) : threadNoteOpen ? (
                <div className="flex flex-col gap-1">
                  <textarea
                    value={threadNoteDraft}
                    onChange={(e) => setThreadNoteDraft(e.target.value)}
                    maxLength={1000}
                    rows={2}
                    placeholder={adminT('platform_admin.support_inbox.suppress_note_placeholder')}
                    className="text-xs px-2 py-1 rounded border border-border bg-surface w-72"
                  />
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={suppressFromThread.isPending}
                      onClick={() =>
                        suppressFromThread.mutate({
                          email: ticket.user_email!,
                          notes: threadNoteDraft.trim() ? threadNoteDraft.trim() : null,
                        })
                      }
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-warning-light text-warning border border-warning/40 hover:bg-warning/20 disabled:opacity-50 font-medium"
                    >
                      <ShieldOff className="h-3 w-3" />
                      {suppressFromThread.isPending ? adminT('platform_admin.support_inbox.suppressing') : adminT('platform_admin.support_inbox.thread_confirm_suppress')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setThreadNoteOpen(false);
                      }}
                      className="text-xs px-2 py-1 rounded border border-border hover:bg-surface-secondary"
                    >
                      {adminT('platform_admin.support_inbox.suppress_cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setThreadNoteOpen(true)}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-warning/40 bg-warning-light text-warning hover:bg-warning/20"
                  title={adminT('platform_admin.support_inbox.suppress_title')}
                >
                  <ShieldOff className="h-3 w-3" />
                  {adminT('platform_admin.support_inbox.thread_suppress_recipient')}
                </button>
              )}
              {threadSuppressError && (
                <div className="text-[10px] text-danger" title={threadSuppressError}>
                  {threadSuppressError}
                </div>
              )}
            </div>
          )}
        </div>
        {ticket.recent_errors && (
          <div>
            <div className="text-xs font-medium text-text-muted mb-1">{adminT('platform_admin.support_inbox.thread_recent_errors')}</div>
            <pre className="whitespace-pre-wrap text-xs bg-danger-light p-3 rounded border border-border font-mono">{ticket.recent_errors}</pre>
          </div>
        )}
        {ticket.context && Object.keys(ticket.context).length > 0 && (
          <div>
            <div className="text-xs font-medium text-text-muted mb-1">{adminT('platform_admin.support_inbox.thread_context')}</div>
            <pre className="text-xs bg-surface p-3 rounded border border-border font-mono">{JSON.stringify(ticket.context, null, 2)}</pre>
          </div>
        )}
        {ticket.email_error && (
          <div className="text-xs text-danger flex items-center gap-1 flex-wrap">
            <span>{adminT('platform_admin.support_inbox.thread_initial_error', { error: ticket.email_error })}</span>
            {isHardBounce(ticket) && (
              <span
                className="ml-1 px-1.5 py-0.5 rounded border border-warning/40 bg-warning-light text-warning text-[10px] uppercase tracking-wide font-medium"
                title={adminT('platform_admin.support_inbox.thread_hard_bounce_title')}
              >
                {adminT('platform_admin.support_inbox.thread_hard_bounce_label')}
              </span>
            )}
            {/* Non-hard-bounce skip reasons (suppression, manual cancel,
                unsubscribed, future) get the descriptive badge so the detail
                view explains why the initial routed-send won't be re-attempted. */}
            {!isHardBounce(ticket) && ticket.retry_skipped_reason && (
              <RetrySkippedBadge reason={ticket.retry_skipped_reason} variant="long" />
            )}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="text-xs font-medium text-text-muted">{adminT('platform_admin.support_inbox.thread_conversation')}</div>
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {isLoading ? (
            <div className="text-xs text-text-muted">{adminT('platform_admin.support_inbox.thread_loading_replies')}</div>
          ) : replies.length === 0 ? (
            <div className="text-xs text-text-muted italic">{adminT('platform_admin.support_inbox.thread_no_replies')}</div>
          ) : (
            replies.map((r) => {
              if (r.direction === 'system') {
                return (
                  <div
                    key={r.id}
                    className="text-xs text-text-muted italic text-center py-1.5 px-3 border-y border-dashed border-border"
                  >
                    {r.body} · {new Date(r.created_at).toLocaleString()}
                  </div>
                );
              }
              const isOutbound = r.direction === 'outbound';
              // Drive the hard-bounce signal from the authoritative server
              // state. `permanent_failure` is the live flag the server
              // computes per request from email_error; `retry_skipped_reason`
              // is the persisted column the scheduler / write-paths stamp
              // (currently `'permanent_smtp_failure'`). Either one is enough
              // — they match for new rows and `retry_skipped_reason` keeps
              // the badge stable across renders for older rows whose server
              // flag may not be populated. `isHardBounce` falls back to the
              // legacy SMTP classifier on email_error for pre-migration rows.
              const isPermanentFailure =
                isOutbound &&
                !!r.email_error &&
                (r.permanent_failure === true || isHardBounce(r));
              // Any non-hard-bounce skip reason (manual cancel, suppression,
              // unsubscribed, …) — surface it as its own pill alongside the
              // generic Failed badge so ops sees *why* further auto-retries
              // were turned off without having to read the SMTP error string.
              const otherSkipDescriptor =
                isOutbound &&
                !!r.email_error &&
                !isPermanentFailure &&
                r.retry_skipped_reason
                  ? describeRetrySkippedReason(r.retry_skipped_reason)
                  : null;
              let badge: { label: string; className: string; title: string } | null = null;
              if (isOutbound) {
                if (r.email_error) {
                  badge = isPermanentFailure
                    ? {
                        label: adminT('platform_admin.support_inbox.badge_permanent_failure'),
                        className:
                          'bg-danger-light text-danger border-danger/60 font-semibold',
                        title: adminT('platform_admin.support_inbox.badge_permanent_failure_title'),
                      }
                    : {
                        label: adminT('platform_admin.support_inbox.badge_failed'),
                        className:
                          'bg-danger-light text-danger border-danger/40',
                        title: r.email_error,
                      };
                } else if (r.email_message_id) {
                  badge = {
                    label: adminT('platform_admin.support_inbox.badge_sent'),
                    className: 'bg-success-light text-success border-success/40',
                    title: adminT('platform_admin.support_inbox.badge_sent_title', { id: r.email_message_id }),
                  };
                } else {
                  badge = {
                    label: adminT('platform_admin.support_inbox.badge_logged_dev'),
                    className: 'bg-muted/30 text-text-muted border-border',
                    title: adminT('platform_admin.support_inbox.badge_logged_dev_title'),
                  };
                }
              }
              // Suppress the retry button for hard bounces: re-sending to a
              // recipient the server has explicitly rejected only burns
              // sender reputation (server enforces the same gate via 409).
              // We allow manual retry for the other skip reasons (suppression
              // / manual cancel / unsubscribe) on purpose — admins still need
              // an escape hatch in case the suppression entry was wrong, the
              // cancel was a mistake, or the unsubscribe was for a different
              // address. The server returns 409 if it disagrees, so even a
              // mis-click can't actually re-send to a hard-bounced recipient.
              const canRetry =
                isOutbound && !!r.email_error && !isPermanentFailure && !!ticket.user_email;
              // Show the "Stop auto-retries" button only when the row is
              // currently failing AND hasn't already been skipped by some
              // other path (hard bounce / manual cancel / etc.). Hard bounces
              // already leave the auto-retry pool on their own.
              const canCancelRetries =
                isOutbound &&
                !!r.email_error &&
                !isPermanentFailure &&
                !r.retry_skipped_reason;
              const isRetrying = retryingReplyId === r.id && retryReply.isPending;
              const retryError = retryErrors[r.id];
              const cooldownUntil = retryCooldownByReply[r.id] ?? 0;
              const retrySecondsLeft = Math.max(0, Math.ceil((cooldownUntil - nowMs) / 1000));
              const retryDisabled = isRetrying || retrySecondsLeft > 0;
              const retryLabel = isRetrying
                ? adminT('platform_admin.support_inbox.retrying')
                : retrySecondsLeft > 0
                  ? adminT('platform_admin.support_inbox.retry_available_in', { seconds: retrySecondsLeft })
                  : adminT('platform_admin.support_inbox.retry_send');
              return (
                <div
                  key={r.id}
                  className={`p-3 rounded border ${
                    isOutbound
                      ? r.email_error
                        ? 'bg-danger-light border-danger/40'
                        : 'bg-primary/5 border-primary/20'
                      : 'bg-surface border-border'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs text-text-muted mb-1 gap-2">
                    <span className="flex items-center gap-2 min-w-0 flex-wrap">
                      <strong className="text-text-primary">
                        {isOutbound ? adminT('platform_admin.support_inbox.thread_support') : adminT('platform_admin.support_inbox.thread_customer')}
                      </strong>
                      {r.author_email ? <span className="truncate">· {r.author_email}</span> : null}
                      {badge && (
                        <span
                          title={badge.title}
                          className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wide cursor-help ${badge.className}`}
                        >
                          {badge.label}
                        </span>
                      )}
                      {/* Distinct skip-reason pill (manual cancel, suppression,
                          unsubscribed, …) — keeps the existing "Failed" / "Permanent
                          failure" semantics intact while explaining *why* further
                          auto-retries are off. Hard bounces are intentionally
                          excluded because the "Permanent failure" badge above
                          already conveys that. */}
                      {otherSkipDescriptor && (
                        <RetrySkippedBadge reason={r.retry_skipped_reason!} />
                      )}
                      {canRetry && (
                        <button
                          type="button"
                          onClick={() => retryReply.mutate(r.id)}
                          disabled={retryDisabled}
                          title={
                            retrySecondsLeft > 0
                              ? adminT('platform_admin.support_inbox.retry_cooldown_title', { seconds: retrySecondsLeft })
                              : adminT('platform_admin.support_inbox.retry_resend_title', { email: ticket.user_email })
                          }
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-danger/40 bg-surface text-danger text-[11px] font-medium hover:bg-danger-light disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          <RotateCw className={`h-3 w-3 ${isRetrying ? 'animate-spin' : ''}`} />
                          {retryLabel}
                        </button>
                      )}
                      {canCancelRetries && (
                        <button
                          type="button"
                          onClick={() => cancelRetries.mutate(r.id)}
                          disabled={cancellingReplyId === r.id && cancelRetries.isPending}
                          title={adminT('platform_admin.support_inbox.stop_auto_retries_title')}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-border bg-surface text-text-muted text-[11px] font-medium hover:bg-surface-secondary disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          {adminT('platform_admin.support_inbox.stop_auto_retries')}
                        </button>
                      )}
                    </span>
                    <span className="shrink-0">{new Date(r.created_at).toLocaleString()}</span>
                  </div>
                  <div className="whitespace-pre-wrap text-sm">{r.body}</div>
                  {r.email_error && (
                    <div className="text-xs text-danger mt-1">
                      {adminT('platform_admin.support_inbox.email_delivery_error', { error: r.email_error })}
                      {isPermanentFailure && (
                        <div className="text-warning mt-0.5">
                          {adminT('platform_admin.support_inbox.permanent_classification')}
                        </div>
                      )}
                    </div>
                  )}
                  {isPermanentFailure && (
                    <div className="text-xs text-danger mt-1">
                      {adminT('platform_admin.support_inbox.wont_retry_long')}
                    </div>
                  )}
                  {retryError && (
                    <div className="text-xs text-danger mt-1">{adminT('platform_admin.support_inbox.retry_failed_inline', { error: retryError })}</div>
                  )}
                  {cancelErrors[r.id] && (
                    <div className="text-xs text-danger mt-1">
                      {adminT('platform_admin.support_inbox.cancel_failed_inline', { error: cancelErrors[r.id] })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="space-y-2 pt-2 border-t border-border">
          <label className="text-xs font-medium text-text-muted">
            {adminT('platform_admin.support_inbox.reply_to_label', { email: ticket.user_email ?? adminT('platform_admin.support_inbox.reply_to_customer_fallback') })}
          </label>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
            placeholder={adminT('platform_admin.support_inbox.reply_textarea_placeholder')}
            className="w-full text-sm rounded-lg border border-border bg-surface p-3 focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs text-text-muted">
              {adminT('platform_admin.support_inbox.reply_helper')}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => changeStatus.mutate(isResolved ? 'open' : 'resolved')}
                disabled={changeStatus.isPending}
                className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg border border-border bg-surface hover:bg-surface-secondary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {changeStatus.isPending
                  ? adminT('platform_admin.support_inbox.updating')
                  : isResolved
                    ? adminT('platform_admin.support_inbox.reopen_ticket')
                    : adminT('platform_admin.support_inbox.mark_resolved')}
              </button>
              <button
                type="button"
                onClick={() => trimmed && sendReply.mutate(trimmed)}
                disabled={!trimmed || sendReply.isPending || !ticket.user_email}
                className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg bg-primary text-on-primary hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Mail className="h-3.5 w-3.5" />
                {sendReply.isPending ? adminT('platform_admin.support_inbox.sending') : adminT('platform_admin.support_inbox.send_reply')}
              </button>
            </div>
          </div>
          {changeStatus.error instanceof Error && (
            <div className="text-xs text-danger">{changeStatus.error.message}</div>
          )}
          {sendError && <div className="text-xs text-danger">{sendError}</div>}
          {lastReply && !sendError && (
            <div className="text-xs text-success">
              {lastReply.email_delivered ? adminT('platform_admin.support_inbox.reply_sent_ok') : adminT('platform_admin.support_inbox.reply_sent_fail')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type CheckoutDirectionTotals = {
  upgrade: number;
  downgrade: number;
  interval_change: number;
  same: number;
  new: number;
  unknown: number;
};
type CheckoutDirectionByDay = { day: string; direction: keyof CheckoutDirectionTotals; count: number };
type CheckoutDirectionTransition = { fromPlan: string | null; toPlan: string | null; count: number };
type CheckoutDirectionsResponse = {
  windowDays: number;
  totals: CheckoutDirectionTotals;
  byDay: CheckoutDirectionByDay[];
  topDowngradeTransitions: CheckoutDirectionTransition[];
};

const DIRECTION_LABELS: Record<keyof CheckoutDirectionTotals, string> = {
  upgrade: 'Upgrades',
  downgrade: 'Downgrades',
  interval_change: 'Interval changes',
  same: 'No-op',
  new: 'New subscriptions',
  unknown: 'Unknown',
};

const DIRECTION_BAR_COLOR: Record<keyof CheckoutDirectionTotals, string> = {
  upgrade: 'bg-success',
  downgrade: 'bg-danger',
  interval_change: 'bg-info',
  same: 'bg-text-muted/40',
  new: 'bg-primary',
  unknown: 'bg-text-muted/30',
};

function PlanChangeDirectionsPanel() {
  const [days, setDays] = useState<number>(30);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['platform-checkout-directions', days],
    queryFn: () =>
      api.get<CheckoutDirectionsResponse>(`/platform/checkout-directions?days=${days}`),
    refetchInterval: 60_000,
  });

  const dayMap = new Map<string, Partial<Record<keyof CheckoutDirectionTotals, number>>>();
  for (const row of data?.byDay ?? []) {
    const existing = dayMap.get(row.day) ?? {};
    existing[row.direction] = (existing[row.direction] ?? 0) + row.count;
    dayMap.set(row.day, existing);
  }
  const dailyRows = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, counts]) => {
      const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
      return { day, counts, total };
    });
  const maxDailyTotal = dailyRows.reduce((max, r) => Math.max(max, r.total), 0) || 1;

  const totals = data?.totals;
  const grandTotal = totals
    ? totals.upgrade + totals.downgrade + totals.interval_change + totals.same + totals.new + totals.unknown
    : 0;

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h3 className="font-semibold">Checkout-session direction</h3>
          <p className="text-xs text-text-muted mt-0.5">
            Breakdown of /billing/checkout sessions by upgrade / downgrade / interval-only over time. Downgrades counted at checkout-rejection time; subsequent scheduled-downgrade audits are not double-counted here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-text-muted" htmlFor="plan-change-window">Window</label>
          <select
            id="plan-change-window"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="text-sm px-2 py-1.5 rounded border border-border bg-surface"
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={365}>365 days</option>
          </select>
        </div>
      </div>

      <div className="p-4 space-y-6">
        {isLoading ? (
          <div className="text-center py-8 text-text-muted">Loading plan-change data...</div>
        ) : isError ? (
          <div className="text-center py-8 text-danger">Failed to load plan-change data.</div>
        ) : !data || grandTotal === 0 ? (
          <div className="text-center py-8 text-text-muted">
            No checkouts recorded in the last {data?.windowDays ?? days} days.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {(Object.keys(DIRECTION_LABELS) as Array<keyof CheckoutDirectionTotals>).map((dir) => {
                const count = totals?.[dir] ?? 0;
                const pct = grandTotal > 0 ? Math.round((count / grandTotal) * 100) : 0;
                return (
                  <div key={dir} className="bg-surface-secondary border border-border rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`inline-block h-2.5 w-2.5 rounded-full ${DIRECTION_BAR_COLOR[dir]}`} />
                      <span className="text-xs text-text-muted">{DIRECTION_LABELS[dir]}</span>
                    </div>
                    <div className="text-lg font-bold tabular-nums">{count.toLocaleString()}</div>
                    <div className="text-[11px] text-text-muted">{pct}% of total</div>
                  </div>
                );
              })}
            </div>

            {dailyRows.length > 0 && (
              <div>
                <div className="text-xs text-text-muted mb-2">Daily checkouts (stacked by direction)</div>
                <div className="space-y-1">
                  {dailyRows.map((row) => (
                    <div key={row.day} className="flex items-center gap-2 text-xs">
                      <div className="w-24 shrink-0 text-text-muted tabular-nums">
                        {row.day}
                      </div>
                      <div className="flex-1 h-4 bg-surface-secondary rounded overflow-hidden flex">
                        {(Object.keys(DIRECTION_LABELS) as Array<keyof CheckoutDirectionTotals>).map((dir) => {
                          const c = row.counts[dir] ?? 0;
                          if (c === 0) return null;
                          const widthPct = (c / maxDailyTotal) * 100;
                          return (
                            <div
                              key={dir}
                              className={DIRECTION_BAR_COLOR[dir]}
                              style={{ width: `${widthPct}%` }}
                              title={`${DIRECTION_LABELS[dir]}: ${c}`}
                            />
                          );
                        })}
                      </div>
                      <div className="w-10 shrink-0 text-right tabular-nums text-text-muted">
                        {row.total}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.topDowngradeTransitions.length > 0 && (
              <div>
                <div className="text-xs text-text-muted mb-2">Top downgrade transitions</div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-secondary">
                      <th className="text-left px-3 py-2 font-medium text-text-muted">From</th>
                      <th className="text-left px-3 py-2 font-medium text-text-muted">To</th>
                      <th className="text-right px-3 py-2 font-medium text-text-muted">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topDowngradeTransitions.map((row, idx) => (
                      <tr key={`${row.fromPlan ?? 'null'}-${row.toPlan ?? 'null'}-${idx}`} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 capitalize">{row.fromPlan ?? '—'}</td>
                        <td className="px-3 py-2 capitalize">{row.toPlan ?? '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CostMonitoringTab({ data, loading }: { data: { monitoring: CostMonitoringData } | undefined; loading: boolean }) {
  const { t: adminT } = useTranslation('admin');
  if (loading) return <div className="text-center py-12 text-text-muted">{adminT('platform_admin.cost_monitoring.loading')}</div>;
  if (!data) return <div className="text-center py-12 text-text-muted">{adminT('platform_admin.cost_monitoring.no_data')}</div>;

  const m = data.monitoring;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="h-4 w-4 text-text-muted" />
            <span className="text-sm text-text-muted">{adminT('platform_admin.cost_monitoring.daily_call_minutes')}</span>
          </div>
          <div className="text-2xl font-bold">{m.daily.callMinutes.toLocaleString()}</div>
          <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.cost_monitoring.calls_today', { count: m.daily.callCount })}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="h-4 w-4 text-text-muted" />
            <span className="text-sm text-text-muted">{adminT('platform_admin.cost_monitoring.daily_ai_cost')}</span>
          </div>
          <div className="text-2xl font-bold">{formatCents(String(m.daily.aiCostCents))}</div>
          <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.cost_monitoring.total_cost', { amount: formatCents(String(m.daily.totalCostCents)) })}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <PhoneCall className="h-4 w-4 text-text-muted" />
            <span className="text-sm text-text-muted">{adminT('platform_admin.cost_monitoring.daily_twilio_spend')}</span>
          </div>
          <div className="text-2xl font-bold">{formatCents(String(m.daily.twilioCostCents))}</div>
          <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.cost_monitoring.sms_amount', { amount: formatCents(String(m.daily.smsCostCents)) })}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Users className="h-4 w-4 text-text-muted" />
            <span className="text-sm text-text-muted">{adminT('platform_admin.cost_monitoring.active_trials')}</span>
          </div>
          <div className="text-2xl font-bold">{m.trials.activeTrials}</div>
          <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.cost_monitoring.paid_accounts', { count: m.trials.paidAccounts })}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-border rounded-xl p-6">
          <h3 className="font-semibold mb-4">{adminT('platform_admin.cost_monitoring.trial_to_paid_conversion')}</h3>
          <div className="flex items-center gap-4">
            <div className="text-4xl font-bold text-primary">{m.trials.conversionRate}%</div>
            <div className="text-sm text-text-muted">
              <div>{adminT('platform_admin.cost_monitoring.paid_total', { paid: m.trials.paidAccounts, total: m.trials.totalAccounts })}</div>
              <div>{adminT('platform_admin.cost_monitoring.active_trials_inline', { count: m.trials.activeTrials })}</div>
            </div>
          </div>
        </div>

        <div className="bg-surface border border-border rounded-xl p-6">
          <h3 className="font-semibold mb-4">{adminT('platform_admin.cost_monitoring.unit_economics')}</h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.cost_per_call')}</div>
              <div className="text-lg font-bold">{formatCents(String(m.economics.costPerCallCents))}</div>
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.revenue_per_call')}</div>
              <div className="text-lg font-bold text-success">{formatCents(String(m.economics.revenuePerCallCents))}</div>
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.margin_per_call')}</div>
              <div className={`text-lg font-bold ${m.economics.marginPerCallCents >= 0 ? 'text-success' : 'text-danger'}`}>
                {formatCents(String(m.economics.marginPerCallCents))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6">
        <h3 className="font-semibold mb-4">{adminT('platform_admin.cost_monitoring.monthly_summary')}</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <div>
            <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.call_minutes')}</div>
            <div className="text-lg font-bold">{m.monthly.callMinutes.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.total_calls')}</div>
            <div className="text-lg font-bold">{m.monthly.callCount.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.ai_cost')}</div>
            <div className="text-lg font-bold">{formatCents(String(m.monthly.aiCostCents))}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.twilio_cost')}</div>
            <div className="text-lg font-bold">{formatCents(String(m.monthly.twilioCostCents))}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.total_cost_label')}</div>
            <div className="text-lg font-bold">{formatCents(String(m.monthly.totalCostCents))}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.revenue')}</div>
            <div className="text-lg font-bold text-success">{formatCents(String(m.monthly.revenueCents))}</div>
          </div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6">
        <h3 className="font-semibold mb-4">{adminT('platform_admin.cost_monitoring.daily_usage')}</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.tool_executions_today')}</div>
            <div className="text-lg font-bold">{m.daily.toolExecutions.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.api_requests_today')}</div>
            <div className="text-lg font-bold">{m.daily.apiRequests.toLocaleString()}</div>
          </div>
        </div>
      </div>

      <PlanChangeDirectionsPanel />

      {m.trend.length > 0 && (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="font-semibold">{adminT('platform_admin.cost_monitoring.trend_30d')}</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.cost_monitoring.trend_header_date')}</th>
                  <th className="text-right px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.cost_monitoring.trend_header_calls')}</th>
                  <th className="text-right px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.cost_monitoring.trend_header_minutes')}</th>
                  <th className="text-right px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.cost_monitoring.trend_header_cost')}</th>
                </tr>
              </thead>
              <tbody>
                {m.trend.map((day) => (
                  <tr key={day.day} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-text-muted">{new Date(day.day).toLocaleDateString()}</td>
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
      className="text-right px-4 py-3 font-medium text-text-muted cursor-pointer select-none hover:text-text-primary transition-colors"
      onClick={() => onSort(field)}
    >
      <span className="inline-flex items-center gap-1 justify-end">
        {label}
        {active ? (
          <span className="text-primary text-[10px]">{currentDir === 'asc' ? '\u25B2' : '\u25BC'}</span>
        ) : (
          <span className="text-text-muted/40 text-[10px]">{'\u25BC'}</span>
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
            <div className="w-32 truncate text-xs text-text-muted text-right" title={String(d[labelKey])}>
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
              <span className="text-xs tabular-nums text-text-muted w-12 text-right">{val.toLocaleString()}</span>
              {secondaryKey && (
                <span className="text-xs tabular-nums text-text-muted/60 w-12 text-right">{secVal.toLocaleString()}</span>
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
  const { t: adminT } = useTranslation('admin');
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
        <BarChart3 className="h-10 w-10 text-text-muted mx-auto mb-3" />
        <p className="text-text-muted">{adminT('platform_admin.template_analytics.no_data_title')}</p>
        <p className="text-xs text-text-muted mt-1">{adminT('platform_admin.template_analytics.no_data_subtitle')}</p>
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
          label={adminT('platform_admin.template_analytics.total_installs')}
          value={String(templates.reduce((s, t) => s + t.totalInstalls, 0))}
          sub={adminT('platform_admin.template_analytics.active_count', { count: templates.reduce((s, t) => s + t.activeInstalls, 0) })}
        />
        <StatCard
          icon={Activity}
          label={adminT('platform_admin.template_analytics.avg_activation_rate')}
          value={`${templates.length > 0 ? Math.round(templates.reduce((s, t) => s + t.activationRate, 0) / templates.length) : 0}%`}
        />
        <StatCard
          icon={PhoneCall}
          label={adminT('platform_admin.template_analytics.template_calls_30d')}
          value={String(templates.reduce((s, t) => s + t.callsLast30d, 0))}
          sub={adminT('platform_admin.template_analytics.total_count', { count: templates.reduce((s, t) => s + t.totalCalls, 0) })}
        />
        <StatCard
          icon={TrendingUp}
          label={adminT('platform_admin.template_analytics.avg_satisfaction')}
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
          <h3 className="font-semibold text-sm mb-1">{adminT('platform_admin.template_analytics.installs_by_template')}</h3>
          <p className="text-xs text-text-muted mb-4">{adminT('platform_admin.template_analytics.installs_chart_subtitle')}</p>
          <BarChart data={chartData} labelKey="displayName" valueKey="activeInstalls" secondaryKey="totalInstalls" barColor="bg-primary" secondaryColor="bg-primary/25" />
        </div>
        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="font-semibold text-sm mb-1">{adminT('platform_admin.template_analytics.call_volume_by_template')}</h3>
          <p className="text-xs text-text-muted mb-4">{adminT('platform_admin.template_analytics.call_volume_subtitle')}</p>
          <BarChart data={[...templates].sort((a, b) => b.callsLast30d - a.callsLast30d).slice(0, 10)} labelKey="displayName" valueKey="callsLast30d" barColor="bg-success" />
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="font-semibold">{adminT('platform_admin.template_analytics.template_performance')}</h2>
          <p className="text-xs text-text-muted mt-0.5">{adminT('platform_admin.template_analytics.performance_subtitle')}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-3 font-medium text-text-muted cursor-pointer select-none hover:text-text-primary" onClick={() => onSort('displayName')}>
                  <span className="inline-flex items-center gap-1">
                    {adminT('platform_admin.template_analytics.header_template')}
                    {sortField === 'displayName' ? <span className="text-primary text-[10px]">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span> : <span className="text-text-muted/40 text-[10px]">{'\u25BC'}</span>}
                  </span>
                </th>
                <SortableHeader label={adminT('platform_admin.template_analytics.header_installs')} field="totalInstalls" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <th className="text-right px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.template_analytics.header_active')}</th>
                <SortableHeader label={adminT('platform_admin.template_analytics.header_activation')} field="activationRate" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <SortableHeader label={adminT('platform_admin.template_analytics.header_upgrade_adoption')} field="upgradeAdoption" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <SortableHeader label={adminT('platform_admin.template_analytics.header_uninstalls')} field="uninstallRate" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <SortableHeader label={adminT('platform_admin.template_analytics.header_calls_30d')} field="callsLast30d" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <SortableHeader label={adminT('platform_admin.template_analytics.header_campaigns')} field="totalCampaigns" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <th className="text-right px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.template_analytics.header_avg_duration')}</th>
                <SortableHeader label={adminT('platform_admin.template_analytics.header_csat')} field="avgSatisfaction" currentField={sortField} currentDir={sortDir} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                  <td className="px-4 py-3">
                    <div className="font-medium">{t.displayName}</div>
                    <div className="text-xs text-text-muted font-mono">{adminT('platform_admin.template_analytics.slug_version', { slug: t.slug, version: t.currentVersion })}</div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.totalInstalls}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.activeInstalls}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`inline-flex items-center gap-1 ${t.activationRate >= 70 ? 'text-success' : t.activationRate >= 40 ? 'text-warning' : 'text-danger'}`}>
                      {t.activationRate >= 70 ? <TrendingUp className="h-3 w-3" /> : t.activationRate < 40 ? <TrendingDown className="h-3 w-3" /> : null}
                      {t.activationRate}%
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <span className={`inline-flex items-center gap-1 ${t.upgradeAdoption >= 50 ? 'text-success' : t.upgradeAdoption >= 20 ? 'text-warning' : 'text-text-muted'}`}>
                      {t.upgradeAdoption}%
                      <span className="text-text-muted/60">({t.upgradeCount})</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <span className={t.uninstallRate > 30 ? 'text-danger' : ''}>{adminT('platform_admin.template_analytics.uninstall_inline', { count: t.uninstallCount, rate: t.uninstallRate })}</span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.callsLast30d.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.totalCampaigns > 0 ? adminT('platform_admin.template_analytics.campaigns_inline', { completed: t.completedCampaigns, total: t.totalCampaigns }) : adminT('platform_admin.common.em_dash')}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.avgCallDuration > 0 ? adminT('platform_admin.template_analytics.duration_minutes_seconds', { minutes: Math.floor(t.avgCallDuration / 60), seconds: t.avgCallDuration % 60 }) : adminT('platform_admin.common.em_dash')}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.avgSatisfaction > 0 ? t.avgSatisfaction.toFixed(1) : adminT('platform_admin.common.em_dash')}</td>
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
                <p className="text-xs text-text-muted">{adminT('platform_admin.template_analytics.version_label', { version: t.currentVersion })}</p>
              </div>
              <StatusBadge status={t.status} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <MetricItem label={adminT('platform_admin.template_analytics.conversion_rate')} value={`${t.activationRate}%`} trend={t.activationRate >= 50 ? 'up' : t.activationRate >= 20 ? 'neutral' : 'down'} />
              <MetricItem label={adminT('platform_admin.template_analytics.avg_call_duration')} value={t.avgCallDuration > 0 ? adminT('platform_admin.template_analytics.duration_minutes_seconds', { minutes: Math.floor(t.avgCallDuration / 60), seconds: t.avgCallDuration % 60 }) : adminT('platform_admin.common.em_dash')} />
              <MetricItem label={adminT('platform_admin.template_analytics.csat_score')} value={t.avgSatisfaction > 0 ? t.avgSatisfaction.toFixed(1) : adminT('platform_admin.common.em_dash')} trend={t.avgSatisfaction >= 4 ? 'up' : t.avgSatisfaction >= 3 ? 'neutral' : t.avgSatisfaction > 0 ? 'down' : undefined} />
              <MetricItem label={adminT('platform_admin.template_analytics.calls_30d_card')} value={t.callsLast30d.toLocaleString()} />
              <MetricItem label={adminT('platform_admin.template_analytics.upgrade_adoption_card')} value={`${t.upgradeAdoption}%`} trend={t.upgradeAdoption >= 50 ? 'up' : t.upgradeAdoption >= 20 ? 'neutral' : 'down'} />
              <MetricItem label={adminT('platform_admin.template_analytics.uninstall_rate_card')} value={`${t.uninstallRate}%`} trend={t.uninstallRate <= 10 ? 'up' : t.uninstallRate <= 30 ? 'neutral' : 'down'} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricItem({ label, value, trend }: { label: string; value: string; trend?: 'up' | 'down' | 'neutral' }) {
  return (
    <div>
      <p className="text-xs text-text-muted mb-0.5">{label}</p>
      <div className="flex items-center gap-1">
        <span className="text-sm font-semibold">{value}</span>
        {trend === 'up' && <TrendingUp className="h-3 w-3 text-success" />}
        {trend === 'down' && <TrendingDown className="h-3 w-3 text-danger" />}
      </div>
    </div>
  );
}

function MilestoneIcon({ done }: { done: boolean }) {
  if (done) return <CheckCircle className="h-4 w-4 text-success" />;
  return <AlertCircle className="h-4 w-4 text-text-muted" />;
}

function formatHours(hours: number | null, t: (k: string) => string): string {
  if (hours === null) return t('platform_admin.common.em_dash');
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

// Shape returned by `/platform/onboarding-funnel` (Task #612). All counts
// are bucketised server-side with FILTER (...) over the canonicalised
// step + completed flags so the UI just renders the numbers.
interface OnboardingFunnel {
  total: number;
  completed: number;
  step_1: number;
  step_2: number;
  step_3: number;
}

function OnboardingFunnelCards() {
  const { t: adminT } = useTranslation('admin');
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery({
    queryKey: ['platform-onboarding-funnel', days],
    queryFn: () =>
      api.get<{ days: number; funnel: OnboardingFunnel }>(
        `/platform/onboarding-funnel?days=${days}`,
      ),
    refetchInterval: 60_000,
  });
  const funnel = data?.funnel;
  // Percent-of-total helper. Returns "—" when the total is 0 so the card
  // doesn't render a bogus "0%" the moment the platform is freshly
  // bootstrapped.
  const pct = (n: number | undefined): string => {
    if (!funnel || !funnel.total) return adminT('platform_admin.common.em_dash');
    const v = n ?? 0;
    return `${Math.round((v / funnel.total) * 100)}%`;
  };
  return (
    <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-semibold">{adminT('platform_admin.onboarding_funnel.title')}</h2>
          <p className="text-xs text-text-muted">
            {adminT('platform_admin.onboarding_funnel.subtitle')}
          </p>
        </div>
        <select
          aria-label={adminT('platform_admin.onboarding_funnel.window_aria')}
          value={days}
          onChange={(e) => setDays(parseInt(e.target.value, 10))}
          className="text-sm border border-border rounded-lg px-2 py-1 bg-surface focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          <option value={7}>{adminT('platform_admin.onboarding_funnel.last_7_days')}</option>
          <option value={30}>{adminT('platform_admin.onboarding_funnel.last_30_days')}</option>
          <option value={90}>{adminT('platform_admin.onboarding_funnel.last_90_days')}</option>
        </select>
      </div>
      {isLoading ? (
        <div className="text-sm text-text-muted">{adminT('platform_admin.onboarding_funnel.loading')}</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div className="border border-border rounded-lg p-3">
            <div className="text-xs text-text-muted">{adminT('platform_admin.onboarding_funnel.new_owners')}</div>
            <div className="text-2xl font-bold">{funnel?.total ?? 0}</div>
            <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.onboarding_funnel.in_window')}</div>
          </div>
          <div className="border border-border rounded-lg p-3">
            <div className="text-xs text-text-muted">{adminT('platform_admin.onboarding_funnel.step_1_provisioning')}</div>
            <div className="text-2xl font-bold text-warning">
              {funnel?.step_1 ?? 0}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {adminT('platform_admin.onboarding_funnel.pct_of_new', { pct: pct(funnel?.step_1) })}
            </div>
          </div>
          <div className="border border-border rounded-lg p-3">
            <div className="text-xs text-text-muted">{adminT('platform_admin.onboarding_funnel.step_2_template')}</div>
            <div className="text-2xl font-bold text-warning">
              {funnel?.step_2 ?? 0}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {adminT('platform_admin.onboarding_funnel.pct_of_new', { pct: pct(funnel?.step_2) })}
            </div>
          </div>
          <div className="border border-border rounded-lg p-3">
            <div className="text-xs text-text-muted">{adminT('platform_admin.onboarding_funnel.step_3_phone')}</div>
            <div className="text-2xl font-bold text-warning">
              {funnel?.step_3 ?? 0}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {adminT('platform_admin.onboarding_funnel.pct_of_new', { pct: pct(funnel?.step_3) })}
            </div>
          </div>
          <div className="border border-border rounded-lg p-3">
            <div className="text-xs text-text-muted">{adminT('platform_admin.onboarding_funnel.completed')}</div>
            <div className="text-2xl font-bold text-success">
              {funnel?.completed ?? 0}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {adminT('platform_admin.onboarding_funnel.pct_of_new', { pct: pct(funnel?.completed) })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActivationMetricsTab({ data, loading }: { data: { metrics: ActivationMetricRow[] } | undefined; loading: boolean }) {
  const { t: adminT } = useTranslation('admin');
  // Render the wizard funnel even if the per-tenant activation table is
  // still loading or empty — the two are independent queries and product
  // cares about the funnel even on a fresh platform with no completed
  // activations yet.
  if (loading) {
    return (
      <div className="space-y-6">
        <OnboardingFunnelCards />
        <div className="text-center py-12 text-text-muted">{adminT('platform_admin.activation_metrics.loading')}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-6">
        <OnboardingFunnelCards />
        <div className="text-center py-12 text-text-muted">{adminT('platform_admin.activation_metrics.no_data')}</div>
      </div>
    );
  }

  const metrics = data.metrics;
  const totalTenants = metrics.length;
  const withAgent = metrics.filter((m) => m.agent_created_at).length;
  const withCall = metrics.filter((m) => m.first_call_at).length;
  const withWorkflow = metrics.filter((m) => m.first_workflow_at).length;
  const stuckTenants = metrics.filter((m) => m.milestones_completed < 2 && m.milestones_completed > 0);

  const TOTAL_MILESTONES = 6;
  const avgTimeToAgent = metrics
    .filter((m) => m.time_to_agent_hours !== null)
    .reduce((sum, m, _, arr) => sum + (m.time_to_agent_hours ?? 0) / arr.length, 0);
  const avgTimeToCall = metrics
    .filter((m) => m.time_to_call_hours !== null)
    .reduce((sum, m, _, arr) => sum + (m.time_to_call_hours ?? 0) / arr.length, 0);
  const avgTimeToWorkflow = metrics
    .filter((m) => m.time_to_workflow_hours !== null)
    .reduce((sum, m, _, arr) => sum + (m.time_to_workflow_hours ?? 0) / arr.length, 0);

  return (
    <div className="space-y-6">
      <OnboardingFunnelCards />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-sm text-text-muted mb-1">{adminT('platform_admin.activation_metrics.agent_created')}</div>
          <div className="text-2xl font-bold">{withAgent} <span className="text-sm text-text-muted font-normal">/ {totalTenants}</span></div>
          <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.activation_metrics.avg_time', { value: formatHours(avgTimeToAgent, adminT) })}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-sm text-text-muted mb-1">{adminT('platform_admin.activation_metrics.first_call')}</div>
          <div className="text-2xl font-bold">{withCall} <span className="text-sm text-text-muted font-normal">/ {totalTenants}</span></div>
          <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.activation_metrics.avg_time', { value: formatHours(avgTimeToCall, adminT) })}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-sm text-text-muted mb-1">{adminT('platform_admin.activation_metrics.first_workflow')}</div>
          <div className="text-2xl font-bold">{withWorkflow} <span className="text-sm text-text-muted font-normal">/ {totalTenants}</span></div>
          <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.activation_metrics.avg_time', { value: formatHours(avgTimeToWorkflow, adminT) })}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-sm text-text-muted mb-1">{adminT('platform_admin.activation_metrics.stuck_tenants')}</div>
          <div className="text-2xl font-bold text-warning">{stuckTenants.length}</div>
          <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.activation_metrics.stuck_subtitle')}</div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="font-semibold">{adminT('platform_admin.activation_metrics.tenant_progress')}</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_tenant')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_plan')}</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_agent')}</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_deploy')}</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_phone')}</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_tools')}</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_first_call')}</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_workflow')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_time_to_agent')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_time_to_call')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_time_to_workflow')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_progress')}</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m) => (
                <tr key={m.tenant_id} className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                  <td className="px-4 py-3">
                    <div className="font-medium">{m.tenant_name}</div>
                    <div className="text-xs text-text-muted">{new Date(m.tenant_created_at).toLocaleDateString()}</div>
                  </td>
                  <td className="px-4 py-3"><PlanBadge plan={m.tenant_plan} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.agent_created_at} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.agent_deployed_at} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.phone_connected_at} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.tools_connected_at} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.first_call_at} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.first_workflow_at} /></td>
                  <td className="px-4 py-3 text-text-muted">{formatHours(m.time_to_agent_hours, adminT)}</td>
                  <td className="px-4 py-3 text-text-muted">{formatHours(m.time_to_call_hours, adminT)}</td>
                  <td className="px-4 py-3 text-text-muted">{formatHours(m.time_to_workflow_hours, adminT)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-16 bg-surface-hover rounded-full h-2">
                        <div
                          className={`h-2 rounded-full ${
                            m.milestones_completed >= 5 ? 'bg-success' :
                            m.milestones_completed >= 3 ? 'bg-info' :
                            m.milestones_completed >= 1 ? 'bg-warning' : 'bg-text-muted/40'
                          }`}
                          style={{ width: `${Math.round((m.milestones_completed / TOTAL_MILESTONES) * 100)}%` }}
                        />
                      </div>
                      <span className="text-xs text-text-muted">{adminT('platform_admin.activation_metrics.milestones_progress', { done: m.milestones_completed, total: TOTAL_MILESTONES })}</span>
                    </div>
                  </td>
                </tr>
              ))}
              {metrics.length === 0 && (
                <tr><td colSpan={12} className="text-center py-12 text-text-muted">{adminT('platform_admin.activation_metrics.no_tenant_data')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
