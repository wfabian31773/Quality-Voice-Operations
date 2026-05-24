import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../lib/api';
import { useRole } from '../lib/useRole';
import {
  Plus, ArrowLeft, Play, Pause, XCircle, Upload, Trash2, X,
  Megaphone, Users, ShieldOff, AlertCircle,
  ChevronLeft, ChevronRight,
  Calendar, UserPlus, Star, RefreshCw, TrendingUp, Phone,
  Info, CheckCircle2, ShieldCheck,
  Activity, Clock, PhoneCall, PhoneMissed, Voicemail, SkipForward,
} from 'lucide-react';
import EmptyState from '../components/EmptyState';
import { PageSkeleton, Skeleton, SkeletonRows } from '../components/state';
import Modal from '../components/Modal';
import { PageHeader, StatCard } from '../components/ui';

type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled';
type ContactStatus = 'pending' | 'dialing' | 'connected' | 'completed' | 'failed' | 'skipped' | 'no_answer' | 'voicemail' | 'opted_out';
type CampaignType = 'outbound_call' | 'appointment_reminder' | 'lead_followup' | 'review_request' | 'customer_reactivation' | 'upsell';

interface CampaignTypeDefinition {
  type: CampaignType;
  label: string;
  description: string;
  icon: string;
  dispositions: Array<{ value: string; label: string }>;
  primaryMetricLabel: string;
  primaryDispositions: string[];
  promptTemplate: string;
  configFields: Array<{
    key: string;
    label: string;
    type: 'text' | 'url' | 'number' | 'boolean';
    placeholder?: string;
    helpText?: string;
    required?: boolean;
  }>;
  contactMetadataFields: Array<{
    key: string;
    label: string;
    helpText?: string;
  }>;
}

/**
 * Mirrors `platform/campaigns/types.ts#CampaignScheduleConfig` but every field
 * is optional because rows persisted before a given setting was introduced can
 * (and do) omit it. Per-campaign-type config fields (appointment date field,
 * lead source field, review URL, etc.) live on the same blob and are
 * intersected in via `CampaignTypeConfigFields` below — so a typo like
 * `appointmentDateFiled` becomes a compile error instead of silently slipping
 * through an index signature. Dynamic registry-driven reads/writes that key in
 * by `CampaignTypeDefinition.configFields[].key` use a one-line
 * `as Record<string, unknown>` view inside their loops, not a type-system
 * escape hatch on the underlying shape.
 */
interface CampaignScheduleConfig {
  timezone?: string;
  callWindowStart?: string;
  callWindowEnd?: string;
  daysOfWeek?: number[];
  maxConcurrentCalls?: number;
  /** Legacy alias for `maxConcurrentCalls`; still read by the dialer. */
  maxConcurrent?: number;
  maxAttempts?: number;
  retryDelayMinutes?: number;
  respectContactTimezone?: boolean;
  areaCodeTimezones?: Record<string, string>;
  callWindows?: Array<{ start: string; end: string; days: number[] }>;
  verifiedCallerId?: string | null;
}

/**
 * Per-campaign-type config interfaces. These mirror the same-named interfaces
 * in `platform/campaigns/types.ts` and must stay in sync — adding a field on
 * one side without the other will silently drop it from the UI form / detail
 * panel. All fields are optional because the registry decides which ones to
 * render for each campaign type.
 */
interface AppointmentReminderConfig {
  appointmentDateField?: string;
  appointmentTimeField?: string;
  providerNameField?: string;
  locationField?: string;
  allowReschedule?: boolean;
}

interface LeadFollowupConfig {
  sourceField?: string;
  productInterestField?: string;
  followupGoal?: string;
}

interface ReviewRequestConfig {
  serviceNameField?: string;
  reviewUrl?: string;
  minimumSatisfactionToAskReview?: number;
}

interface ReactivationConfig {
  inactiveDaysThreshold?: number;
  offerField?: string;
  reengagementMessage?: string;
}

interface UpsellConfig {
  currentProductField?: string;
  upsellProductField?: string;
  discountField?: string;
}

/**
 * Flattened intersection of every per-campaign-type config interface. All
 * keys are optional, so this is safe to merge into the schedule config
 * without forcing any one type's fields. Adding a new type-specific field
 * (in one of the source interfaces above) automatically propagates here and
 * into `CampaignConfig`.
 */
type CampaignTypeConfigFields =
  & AppointmentReminderConfig
  & LeadFollowupConfig
  & ReviewRequestConfig
  & ReactivationConfig
  & UpsellConfig;

type CampaignConfig = CampaignScheduleConfig & CampaignTypeConfigFields;

interface Campaign {
  id: string;
  tenantId: string;
  agentId: string;
  name: string;
  type: string;
  status: CampaignStatus;
  config: CampaignConfig;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contactCount?: number;
}

interface CampaignMetrics {
  total: number;
  attempted: number;
  pending: number;
  dialing: number;
  connected: number;
  completed: number;
  failed: number;
  noAnswer: number;
  voicemail: number;
  skipped: number;
  optedOut: number;
}

interface TypeSpecificMetrics {
  campaignType: CampaignType;
  dispositions: Record<string, number>;
  primaryRate: number;
  primaryRateLabel: string;
}

/**
 * Mirrors `platform/campaigns/types.ts#CampaignContact.metadata`. Known fields
 * (set server-side by the dialer / outcome classifier / opt-out flow) are
 * declared explicitly so the UI catches schema drift at compile time, while the
 * `Record<string, unknown>` intersection preserves the escape hatch for
 * arbitrary CSV columns saved at import time (see the upload help text).
 */
interface CampaignContactMetadataKnown {
  /** Set by `classifyTypeDisposition` after a connected typed-campaign call. */
  typeDisposition?: string;
  /** Set by `bulkMarkOptedOut` (e.g. "dnc_match", "manual_review"). */
  optOutReason?: string;
}

type CampaignContactMetadata = CampaignContactMetadataKnown & Record<string, unknown>;

interface CampaignContact {
  id: string;
  phoneNumber: string;
  name: string | null;
  status: ContactStatus;
  outcome: string | null;
  attemptCount: number;
  lastAttemptedAt: string | null;
  metadata: CampaignContactMetadata;
  createdAt: string;
}

interface Agent {
  id: string;
  name: string;
  type: string;
  status: string;
}

interface ComplianceReport {
  ok: boolean;
  totalContacts: number;
  scannedContacts?: number;
  optedOutCount: number;
  dncMatchCount: number;
  tenantDncMatchCount?: number;
  federalDncMatchCount?: number;
  federalDncRegistryVersion?: string | null;
  dncMatches: Array<{
    contactId: string;
    phoneRedacted: string;
    contactName: string | null;
    source?: 'tenant' | 'federal';
  }>;
  /**
   * SMS coverage flags surfaced in the compliance panel so operators see a
   * single number across both voice and SMS channels (Task #604). Optional
   * for forward compatibility with reports generated before the feature
   * shipped.
   */
  smsQuietHoursEnforced?: boolean;
  smsQuietHoursWindow?: string;
  /**
   * Task #990: true when the tenant has tightened the SMS quiet-hours
   * window beyond the federal default. Drives the "Tenant override"
   * badge in the channel coverage strip.
   */
  smsQuietHoursTenantOverride?: boolean;
  smsQuietHoursFederalWindow?: string;
  hasQuietHoursConfig?: boolean;
  respectsContactTimezone?: boolean;
  complianceScore: number;
  recommendations: string[];
  preflightTruncated?: boolean;
  generatedAt?: string;
}

interface SmsComplianceSettings {
  federalDefault: { windowStart: string; windowEnd: string };
  tenantOverride: { windowStart: string | null; windowEnd: string | null };
  effective: {
    windowStart: string;
    windowEnd: string;
    isTenantOverride: boolean;
    display: string;
  };
}

interface DncEntry {
  id: string;
  phoneNumber: string;
  reason: string | null;
  source: string;
  createdAt: string;
}

interface TrustedCallerSummary {
  id: string;
  phoneNumber: string;
  friendlyName: string | null;
  status: 'pending' | 'verified' | 'failed' | 'rotated';
  attestationLevel: 'A' | 'B' | 'C' | null;
}

const STATUS_COLORS: Record<CampaignStatus, string> = {
  draft: 'bg-text-muted/10 text-text-muted',
  scheduled: 'bg-warning/10 text-warning',
  running: 'bg-success/10 text-success',
  paused: 'bg-warning/10 text-warning',
  completed: 'bg-primary/10 text-primary',
  cancelled: 'bg-danger/10 text-danger',
};

const CONTACT_STATUS_COLORS: Record<ContactStatus, string> = {
  pending: 'bg-text-muted/10 text-text-muted',
  dialing: 'bg-primary/10 text-primary',
  connected: 'bg-success/10 text-success',
  completed: 'bg-success/10 text-success',
  failed: 'bg-danger/10 text-danger',
  skipped: 'bg-text-muted/10 text-text-muted',
  no_answer: 'bg-warning/10 text-warning',
  voicemail: 'bg-primary/10 text-primary',
  opted_out: 'bg-danger/10 text-danger',
};

function statusLabel(t: TFunction, status: string): string {
  return t(`campaigns.status.${status}`, { defaultValue: status.replace(/_/g, ' ') });
}

function contactStatusLabel(t: TFunction, status: string): string {
  return t(`campaigns.contact_status.${status}`, { defaultValue: status.replace(/_/g, ' ') });
}

const DISPOSITION_COLORS: Record<string, string> = {
  confirmed: 'text-success',
  rescheduled: 'text-warning',
  cancelled: 'text-danger',
  interested: 'text-primary',
  not_interested: 'text-text-muted',
  callback_requested: 'text-warning',
  converted: 'text-success',
  review_left: 'text-success',
  feedback_given: 'text-primary',
  declined: 'text-text-muted',
  reactivated: 'text-success',
  accepted: 'text-success',
  no_response: 'text-text-muted',
};

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const CAMPAIGN_TYPE_ICONS: Record<string, React.ReactNode> = {
  Phone: <Phone className="h-5 w-5" />,
  Calendar: <Calendar className="h-5 w-5" />,
  UserPlus: <UserPlus className="h-5 w-5" />,
  Star: <Star className="h-5 w-5" />,
  RefreshCw: <RefreshCw className="h-5 w-5" />,
  TrendingUp: <TrendingUp className="h-5 w-5" />,
};

function StatusBadge({ status, label, colors }: { status: string; label?: string; colors: Record<string, string> }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${colors[status] ?? 'bg-text-muted/10 text-text-muted'}`}>
      {label ?? status.replace(/_/g, ' ')}
    </span>
  );
}

function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return raw;
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function CampaignTypeSelector({
  types,
  selectedType,
  onSelect,
}: {
  types: CampaignTypeDefinition[];
  selectedType: CampaignType;
  onSelect: (type: CampaignType) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {types.map((t) => (
        <button
          key={t.type}
          type="button"
          onClick={() => onSelect(t.type)}
          className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-all ${
            selectedType === t.type
              ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
              : 'border-border hover:border-primary/30 hover:bg-surface-hover'
          }`}
        >
          <div className={`mt-0.5 ${selectedType === t.type ? 'text-primary' : 'text-text-muted'}`}>
            {CAMPAIGN_TYPE_ICONS[t.icon] ?? <Phone className="h-5 w-5" />}
          </div>
          <div className="min-w-0">
            <p className={`text-sm font-medium ${selectedType === t.type ? 'text-primary' : 'text-text-primary'}`}>
              {t.label}
            </p>
            <p className="text-xs text-text-muted mt-0.5 line-clamp-2">{t.description}</p>
          </div>
          {selectedType === t.type && (
            <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0 mt-0.5" />
          )}
        </button>
      ))}
    </div>
  );
}

function TypeConfigFields({
  typeDef,
  typeConfig,
  onChange,
}: {
  typeDef: CampaignTypeDefinition;
  typeConfig: CampaignTypeConfigFields;
  onChange: (config: CampaignTypeConfigFields) => void;
}) {
  const { t: tenantT } = useTranslation('tenant');
  if (typeDef.configFields.length === 0) return null;

  // Per-field reads/writes are keyed by `CampaignTypeDefinition.configFields[].key`,
  // so we take a one-line `Record<string, unknown>` view of the typed config to
  // keep the dynamic loop ergonomic without giving up compile-time checking on
  // the underlying shape.
  const view = typeConfig as Record<string, unknown>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-text-primary">{tenantT('campaigns.create_modal.type_settings', { type: typeDef.label })}</h3>
        <div className="group relative">
          <Info className="h-3.5 w-3.5 text-text-muted cursor-help" />
          <div className="hidden group-hover:block absolute left-0 top-5 z-popover w-64 p-2 bg-surface border border-border rounded-lg shadow-lg text-xs text-text-muted">
            {tenantT('campaigns.create_modal.type_tooltip', { type: typeDef.label.toLowerCase() })}
          </div>
        </div>
      </div>
      {typeDef.configFields.map((field) => (
        <div key={field.key}>
          <label className="block text-sm font-medium text-text-primary mb-1">{field.label}</label>
          {field.type === 'boolean' ? (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!!view[field.key]}
                onChange={(e) => onChange({ ...view, [field.key]: e.target.checked } as CampaignTypeConfigFields)}
                className="rounded border-border text-primary focus:ring-primary/30"
              />
              <span className="text-sm text-text-secondary">{field.helpText}</span>
            </label>
          ) : (
            <>
              <input
                type={field.type === 'number' ? 'number' : 'text'}
                value={(view[field.key] as string | number) ?? ''}
                onChange={(e) => onChange({ ...view, [field.key]: field.type === 'number' ? (e.target.value ? parseInt(e.target.value) : '') : e.target.value } as CampaignTypeConfigFields)}
                placeholder={field.placeholder}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              {field.helpText && <p className="text-xs text-text-muted mt-1">{field.helpText}</p>}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function CreateCampaignModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t: tenantT, i18n } = useTranslation('tenant');
  const { data: agentsData } = useQuery({ queryKey: ['agents'], queryFn: () => api.get<{ agents: Agent[] }>('/agents') });
  const agents = agentsData?.agents ?? [];

  const { data: typesData } = useQuery({
    queryKey: ['campaign-types'],
    queryFn: () => api.get<{ types: CampaignTypeDefinition[] }>('/campaigns/types'),
  });
  const campaignTypes = typesData?.types ?? [];

  const { data: callersData } = useQuery({
    queryKey: ['trusted-callers'],
    queryFn: () => api.get<{ callers: TrustedCallerSummary[] }>('/trusted-callers'),
  });
  const verifiedCallers = (callersData?.callers ?? []).filter((c) => c.status === 'verified');

  const [step, setStep] = useState<'type' | 'config'>('type');
  const [form, setForm] = useState({
    name: '',
    agentId: '',
    type: 'outbound_call' as CampaignType,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    callWindowStart: '09:00',
    callWindowEnd: '17:00',
    daysOfWeek: [1, 2, 3, 4, 5] as number[],
    respectContactTimezone: true,
    maxConcurrentCalls: 5,
    maxAttempts: 3,
    retryDelayMinutes: 30,
    verifiedCallerId: '',
  });
  const [typeConfig, setTypeConfig] = useState<CampaignTypeConfigFields>({});
  const [error, setError] = useState('');

  useEffect(() => {
    if (agents.length > 0 && !form.agentId) setForm((f) => ({ ...f, agentId: agents[0].id }));
  }, [agents, form.agentId]);

  const selectedTypeDef = campaignTypes.find((t) => t.type === form.type);

  const mutation = useMutation({
    mutationFn: () => {
      const config: CampaignConfig = {
        timezone: form.timezone,
        callWindowStart: form.callWindowStart,
        callWindowEnd: form.callWindowEnd,
        daysOfWeek: form.daysOfWeek,
        respectContactTimezone: form.respectContactTimezone,
        maxConcurrentCalls: form.maxConcurrentCalls,
        maxAttempts: form.maxAttempts,
        retryDelayMinutes: form.retryDelayMinutes,
        verifiedCallerId: form.verifiedCallerId || null,
        ...typeConfig,
      };
      return api.post('/campaigns', {
        name: form.name,
        agentId: form.agentId,
        type: form.type,
        config,
      });
    },
    onSuccess: () => { onCreated(); onClose(); },
    onError: (err: Error) => setError(err.message),
  });

  const toggleDay = (d: number) => {
    setForm((f) => ({
      ...f,
      daysOfWeek: f.daysOfWeek.includes(d) ? f.daysOfWeek.filter((x) => x !== d) : [...f.daysOfWeek, d].sort(),
    }));
  };

  return (
    <Modal open onClose={onClose} ariaLabel={step === 'type' ? tenantT('campaigns.create_modal.aria_choose_type') : tenantT('campaigns.create_modal.aria_configure')} panelClassName="bg-surface border border-border rounded-xl shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            {step === 'config' && (
              <button onClick={() => setStep('type')} className="text-text-muted hover:text-text-primary">
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <h2 className="text-lg font-semibold text-text-primary">
              {step === 'type' ? tenantT('campaigns.create_modal.title_choose_type') : tenantT('campaigns.create_modal.title_configure')}
            </h2>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X className="h-5 w-5" /></button>
        </div>

        {step === 'type' ? (
          <div className="p-6 space-y-4">
            <p className="text-sm text-text-muted">{tenantT('campaigns.create_modal.intro')}</p>
            {campaignTypes.length > 0 ? (
              <CampaignTypeSelector
                types={campaignTypes}
                selectedType={form.type}
                onSelect={(type) => {
                  setForm((f) => ({ ...f, type }));
                  setTypeConfig({});
                }}
              />
            ) : (
              <SkeletonRows count={4} rowClassName="h-16" />
            )}
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setStep('config')}
                className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg"
              >
                {tenantT('campaigns.create_modal.continue')}
              </button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => { e.preventDefault(); if (form.name && form.agentId) mutation.mutate(); }}
            className="p-6 space-y-4"
          >
            {error && <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-lg">{error}</div>}

            {selectedTypeDef && selectedTypeDef.type !== 'outbound_call' && (
              <div className="flex items-center gap-2 px-3 py-2 bg-primary/5 border border-primary/20 rounded-lg">
                <div className="text-primary">{CAMPAIGN_TYPE_ICONS[selectedTypeDef.icon]}</div>
                <span className="text-sm font-medium text-primary">{selectedTypeDef.label}</span>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">{tenantT('campaigns.create_modal.campaign_name')}</label>
              <input
                type="text"
                required
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                placeholder={selectedTypeDef
                  ? tenantT('campaigns.create_modal.name_placeholder', {
                      type: selectedTypeDef.label,
                      date: new Date().toLocaleDateString(i18n.language || 'en-US', { month: 'long', year: 'numeric' }),
                    })
                  : tenantT('campaigns.create_modal.name_placeholder_default')}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">{tenantT('campaigns.create_modal.agent')}</label>
              <select
                value={form.agentId}
                onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>

            {selectedTypeDef && selectedTypeDef.configFields.length > 0 && (
              <div className="border-t border-border pt-4">
                <TypeConfigFields
                  typeDef={selectedTypeDef}
                  typeConfig={typeConfig}
                  onChange={setTypeConfig}
                />
              </div>
            )}

            <div className="border-t border-border pt-4">
              <label className="block text-sm font-medium text-text-primary mb-1">{tenantT('campaigns.create_modal.verified_caller_id')}</label>
              <select
                value={form.verifiedCallerId}
                onChange={(e) => setForm((f) => ({ ...f, verifiedCallerId: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">{tenantT('campaigns.create_modal.use_default_outbound')}</option>
                {verifiedCallers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.friendlyName ? `${c.friendlyName} — ${c.phoneNumber}` : c.phoneNumber}
                    {c.attestationLevel ? ` (${tenantT('campaigns.create_modal.attestation', { level: c.attestationLevel })})` : ''}
                  </option>
                ))}
              </select>
              <p className="text-xs text-text-muted mt-1">
                {tenantT('campaigns.create_modal.verified_caller_help')}
              </p>
              {verifiedCallers.length === 0 && (
                <p className="text-xs text-warning mt-1">
                  {tenantT('campaigns.create_modal.no_verified_callers')}
                </p>
              )}
            </div>

            <div className="border-t border-border pt-4">
              <h3 className="text-sm font-medium text-text-primary mb-3">{tenantT('campaigns.create_modal.schedule_settings')}</h3>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-text-primary mb-1">{tenantT('campaigns.create_modal.window_start')}</label>
                    <input type="time" value={form.callWindowStart} onChange={(e) => setForm((f) => ({ ...f, callWindowStart: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-primary mb-1">{tenantT('campaigns.create_modal.window_end')}</label>
                    <input type="time" value={form.callWindowEnd} onChange={(e) => setForm((f) => ({ ...f, callWindowEnd: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">{tenantT('campaigns.create_modal.timezone')}</label>
                  <input
                    type="text"
                    value={form.timezone}
                    onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">{tenantT('campaigns.create_modal.days_of_week')}</label>
                  <div className="flex gap-1">
                    {DAYS.map((dayKey, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => toggleDay(i)}
                        className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                          form.daysOfWeek.includes(i)
                            ? 'bg-primary text-white'
                            : 'bg-surface-hover text-text-secondary'
                        }`}
                      >
                        {tenantT(`campaigns.days.${dayKey}`)}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.respectContactTimezone}
                    onChange={(e) => setForm((f) => ({ ...f, respectContactTimezone: e.target.checked }))}
                    className="mt-0.5 rounded border-border text-primary focus:ring-primary/30"
                  />
                  <span className="text-sm text-text-secondary">
                    {tenantT('campaigns.create_modal.respect_contact_tz')}
                  </span>
                </label>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-text-primary mb-1">{tenantT('campaigns.create_modal.concurrency')}</label>
                    <input type="number" min={1} max={50} value={form.maxConcurrentCalls} onChange={(e) => setForm((f) => ({ ...f, maxConcurrentCalls: parseInt(e.target.value) || 1 }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-primary mb-1">{tenantT('campaigns.create_modal.max_attempts')}</label>
                    <input type="number" min={1} max={10} value={form.maxAttempts} onChange={(e) => setForm((f) => ({ ...f, maxAttempts: parseInt(e.target.value) || 1 }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-primary mb-1">{tenantT('campaigns.create_modal.retry_min')}</label>
                    <input type="number" min={1} value={form.retryDelayMinutes} onChange={(e) => setForm((f) => ({ ...f, retryDelayMinutes: parseInt(e.target.value) || 1 }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary">{tenantT('campaigns.create_modal.cancel')}</button>
              <button type="submit" disabled={mutation.isPending} className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50">
                {mutation.isPending ? tenantT('campaigns.create_modal.creating') : tenantT('campaigns.create_modal.create')}
              </button>
            </div>
          </form>
        )}
    </Modal>
  );
}

function AddContactsModal({ campaignId, onClose, onAdded }: { campaignId: string; onClose: () => void; onAdded: () => void }) {
  const { t: tenantT } = useTranslation('tenant');
  const [mode, setMode] = useState<'manual' | 'csv' | 'json'>('manual');
  const [manualPhone, setManualPhone] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualEntries, setManualEntries] = useState<Array<{ phone: string; name: string }>>([]);
  const [csvText, setCsvText] = useState('');
  const [jsonText, setJsonText] = useState('');
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ inserted: number; skippedInvalid: number }>(`/campaigns/${campaignId}/contacts`, body),
    onSuccess: () => {
      onAdded();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const addManualEntry = () => {
    if (!manualPhone.trim()) return;
    setManualEntries((prev) => [...prev, { phone: manualPhone.trim(), name: manualName.trim() }]);
    setManualPhone('');
    setManualName('');
  };

  const handleSubmit = () => {
    setError('');
    if (mode === 'csv') {
      if (!csvText.trim()) { setError(tenantT('campaigns.add_contacts.err_paste_csv')); return; }
      mutation.mutate({ csv: csvText });
    } else if (mode === 'json') {
      if (!jsonText.trim()) { setError(tenantT('campaigns.add_contacts.err_paste_json')); return; }
      try {
        const parsed = JSON.parse(jsonText);
        const contacts = Array.isArray(parsed) ? parsed : parsed.contacts;
        if (!Array.isArray(contacts)) { setError(tenantT('campaigns.add_contacts.err_json_array')); return; }
        mutation.mutate({ contacts: contacts.map((c: Record<string, string>) => ({ phoneNumber: c.phoneNumber || c.phone || c.phone_number, name: c.name || undefined })) });
      } catch { setError(tenantT('campaigns.add_contacts.err_invalid_json')); }
    } else {
      if (manualEntries.length === 0) { setError(tenantT('campaigns.add_contacts.err_min_one')); return; }
      mutation.mutate({ contacts: manualEntries.map((e) => ({ phoneNumber: e.phone, name: e.name || undefined })) });
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setCsvText(ev.target?.result as string ?? ''); setMode('csv'); };
    reader.readAsText(file);
  };

  return (
    <Modal open onClose={onClose} ariaLabel={tenantT('campaigns.add_contacts.aria_label')} panelClassName="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">{tenantT('campaigns.add_contacts.title')}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          {error && <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-lg">{error}</div>}

          <div className="flex gap-2">
            <button onClick={() => setMode('manual')} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${mode === 'manual' ? 'bg-primary text-white' : 'bg-surface-hover text-text-secondary'}`}>{tenantT('campaigns.add_contacts.manual_entry')}</button>
            <button onClick={() => setMode('csv')} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${mode === 'csv' ? 'bg-primary text-white' : 'bg-surface-hover text-text-secondary'}`}>{tenantT('campaigns.add_contacts.csv_upload')}</button>
            <button onClick={() => setMode('json')} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${mode === 'json' ? 'bg-primary text-white' : 'bg-surface-hover text-text-secondary'}`}>{tenantT('campaigns.add_contacts.json')}</button>
          </div>

          {mode === 'json' ? (
            <>
              <textarea
                rows={8}
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                placeholder={'[\n  { "phoneNumber": "2125551234", "name": "Jane Smith" },\n  { "phoneNumber": "3105559876", "name": "Bob Jones" }\n]'}
              />
              <p className="text-xs text-text-muted">{tenantT('campaigns.add_contacts.json_help')}</p>
            </>
          ) : mode === 'manual' ? (
            <>
              <div className="flex gap-2">
                <input type="text" placeholder={tenantT('campaigns.add_contacts.phone_placeholder')} value={manualPhone} onChange={(e) => setManualPhone(e.target.value)} className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                <input type="text" placeholder={tenantT('campaigns.add_contacts.name_optional')} value={manualName} onChange={(e) => setManualName(e.target.value)} className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                <button type="button" onClick={addManualEntry} className="px-3 py-2 bg-primary hover:bg-primary-hover text-white text-sm rounded-lg"><Plus className="h-4 w-4" /></button>
              </div>
              {manualEntries.length > 0 && (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {manualEntries.map((e, i) => (
                    <div key={i} className="flex items-center justify-between px-3 py-1.5 bg-surface-hover rounded text-sm">
                      <span className="text-text-primary">{e.phone} {e.name && <span className="text-text-muted">({e.name})</span>}</span>
                      <button onClick={() => setManualEntries((prev) => prev.filter((_, j) => j !== i))} className="text-text-muted hover:text-danger"><X className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                  <p className="text-xs text-text-muted">{tenantT('campaigns.add_contacts.ready', { count: manualEntries.length })}</p>
                </div>
              )}
            </>
          ) : (
            <>
              <div>
                <label className="flex items-center gap-2 px-4 py-3 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary/50 transition-colors">
                  <Upload className="h-5 w-5 text-text-muted" />
                  <span className="text-sm text-text-secondary">{tenantT('campaigns.add_contacts.choose_csv')}</span>
                  <input type="file" accept=".csv,.txt" onChange={handleFileUpload} className="hidden" />
                </label>
              </div>
              <textarea
                rows={6}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                placeholder={'phone,name\n2125551234,Jane Smith\n3105559876,Bob Jones'}
              />
              <p className="text-xs text-text-muted">{tenantT('campaigns.add_contacts.csv_help')}</p>
            </>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary">{tenantT('campaigns.add_contacts.cancel')}</button>
            <button onClick={handleSubmit} disabled={mutation.isPending} className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50">
              {mutation.isPending ? tenantT('campaigns.add_contacts.uploading') : tenantT('campaigns.add_contacts.submit')}
            </button>
          </div>
        </div>
    </Modal>
  );
}

function TypeMetricsPanel({ campaignId, campaignType }: { campaignId: string; campaignType: string }) {
  const { t: tenantT } = useTranslation('tenant');
  const { data: typeMetricsData } = useQuery({
    queryKey: ['campaign-type-metrics', campaignId],
    queryFn: () => api.get<{ typeMetrics: TypeSpecificMetrics | null }>(`/campaigns/${campaignId}/type-metrics`),
    refetchInterval: 15000,
  });

  const { data: typesData } = useQuery({
    queryKey: ['campaign-types'],
    queryFn: () => api.get<{ types: CampaignTypeDefinition[] }>('/campaigns/types'),
  });

  const typeMetrics = typeMetricsData?.typeMetrics;
  const typeDef = typesData?.types?.find((t) => t.type === campaignType);

  if (!typeMetrics || !typeDef || typeDef.dispositions.length === 0) return null;

  const totalDispositions = Object.values(typeMetrics.dispositions).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
        {CAMPAIGN_TYPE_ICONS[typeDef.icon]}
        {tenantT('campaigns.type_metrics.title', { type: typeDef.label })}
      </h3>

      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-text-primary">{typeMetrics.primaryRateLabel}</span>
          <span className="text-2xl font-bold text-primary">
            {(typeMetrics.primaryRate * 100).toFixed(1)}%
          </span>
        </div>
        {totalDispositions > 0 && (
          <div className="h-3 bg-surface-hover rounded-full overflow-hidden flex">
            {typeDef.dispositions.map((d) => {
              const count = typeMetrics.dispositions[d.value] ?? 0;
              if (count === 0) return null;
              const pct = (count / totalDispositions) * 100;
              const colorClass = DISPOSITION_COLORS[d.value] ?? 'text-text-muted';
              const bgClass = colorClass.replace('text-', 'bg-');
              return (
                <div
                  key={d.value}
                  className={`${bgClass} h-full`}
                  style={{ width: `${pct}%` }}
                  title={`${d.label}: ${count} (${pct.toFixed(1)}%)`}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {typeDef.dispositions.map((d) => (
          <div key={d.value} className="flex items-center justify-between px-3 py-2 bg-surface border border-border rounded-lg">
            <span className="text-sm text-text-muted capitalize">{d.label}</span>
            <span className={`text-sm font-semibold ${DISPOSITION_COLORS[d.value] ?? 'text-text-primary'}`}>
              {typeMetrics.dispositions[d.value] ?? 0}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CampaignListPrimaryRate({ campaignId, campaignType }: { campaignId: string; campaignType: string }) {
  const { data } = useQuery({
    queryKey: ['campaign-type-metrics', campaignId],
    queryFn: () => api.get<{ typeMetrics: TypeSpecificMetrics | null }>(`/campaigns/${campaignId}/type-metrics`),
    enabled: campaignType !== 'outbound_call',
    staleTime: 30000,
  });

  if (campaignType === 'outbound_call' || !data?.typeMetrics) {
    return <span className="text-text-muted">—</span>;
  }

  const rate = data.typeMetrics.primaryRate;
  const color = rate >= 0.5 ? 'text-green-600 dark:text-green-400' : rate >= 0.25 ? 'text-amber-600 dark:text-amber-400' : 'text-text-muted';

  return (
    <span className={`text-sm font-medium ${color}`}>
      {(rate * 100).toFixed(0)}%
    </span>
  );
}

/**
 * Tenant-level SMS quiet-hours override editor (Task #990).
 *
 * Lets admins tighten the SMS quiet-hours window beyond the federal
 * default (08:00–21:00 local). The server clamps any value back inside
 * the federal floor and rejects loosenings with a 400, so this editor
 * stays simple — a pair of HH:MM inputs and a Reset button. Only shown
 * to roles that already have campaign-launch privileges (manager+).
 */
function SmsQuietHoursOverrideEditor() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['sms-compliance-settings'],
    queryFn: () => api.get<{ settings: SmsComplianceSettings }>(`/sms-inbox/compliance-settings`),
  });
  const [start, setStart] = useState<string>('');
  const [end, setEnd] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.settings) {
      setStart(data.settings.tenantOverride.windowStart ?? '');
      setEnd(data.settings.tenantOverride.windowEnd ?? '');
    }
  }, [data]);

  const save = useMutation({
    mutationFn: (body: { windowStart: string | null; windowEnd: string | null }) =>
      api.put<{ settings: SmsComplianceSettings }>('/sms-inbox/compliance-settings', body),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['sms-compliance-settings'] });
      // The campaign-compliance report includes the effective SMS window;
      // refresh it so the channel coverage strip re-renders without a
      // page reload.
      await queryClient.invalidateQueries({ queryKey: ['campaign-compliance'] });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Failed to save SMS quiet hours';
      setError(msg);
    },
  });

  if (isLoading || !data) {
    return (
      <div className="mt-3" aria-busy="true" aria-live="polite">
        <Skeleton className="h-12 w-full rounded-md" />
      </div>
    );
  }

  const fed = data.settings.federalDefault;
  const tenantHasOverride = Boolean(
    data.settings.tenantOverride.windowStart || data.settings.tenantOverride.windowEnd,
  );
  const dirty =
    (start || null) !== (data.settings.tenantOverride.windowStart ?? null)
    || (end || null) !== (data.settings.tenantOverride.windowEnd ?? null);

  return (
    <div className="mt-3 rounded-md border border-border bg-surface-hover px-3 py-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-text-primary flex items-center gap-2">
          <ShieldCheck className="h-3.5 w-3.5" />
          Tenant SMS quiet-hours override
        </p>
        <span className="text-[10px] text-text-muted">
          Federal default: {fed.windowStart}–{fed.windowEnd}
        </span>
      </div>
      <p className="text-[11px] text-text-muted mb-2">
        Tighten the SMS window for stricter state laws (e.g. FL HB 761) or
        enterprise contracts. Values outside the federal window are rejected.
        Leave a side blank to fall back to the federal default for that side.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[11px] text-text-secondary">
          <span className="block mb-0.5">Start (HH:MM)</span>
          <input
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            min={fed.windowStart}
            max={fed.windowEnd}
            className="px-2 py-1 text-xs bg-surface border border-border rounded-md w-28"
          />
        </label>
        <label className="text-[11px] text-text-secondary">
          <span className="block mb-0.5">End (HH:MM)</span>
          <input
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            min={fed.windowStart}
            max={fed.windowEnd}
            className="px-2 py-1 text-xs bg-surface border border-border rounded-md w-28"
          />
        </label>
        <button
          type="button"
          disabled={!dirty || save.isPending}
          onClick={() =>
            save.mutate({
              windowStart: start || null,
              windowEnd: end || null,
            })
          }
          className="px-2.5 py-1 text-xs font-medium rounded-md bg-primary text-white hover:bg-primary/90 disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {tenantHasOverride && (
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate({ windowStart: null, windowEnd: null })}
            className="px-2.5 py-1 text-xs font-medium rounded-md bg-surface border border-border hover:bg-surface-hover disabled:opacity-50"
          >
            Reset to federal default
          </button>
        )}
      </div>
      {error && (
        <p className="mt-2 text-[11px] text-danger flex items-start gap-1">
          <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" /> {error}
        </p>
      )}
      <p className="mt-2 text-[11px] text-text-muted">
        Currently in force: <span className="font-mono">{data.settings.effective.display}</span>
        {data.settings.effective.isTenantOverride && (
          <span className="ml-1 text-primary">(tenant override)</span>
        )}
      </p>
    </div>
  );
}

function CompliancePanel({
  campaignId,
  canScrub,
  onScrub,
  scrubbing,
}: {
  campaignId: string;
  canScrub?: boolean;
  onScrub?: () => void;
  scrubbing?: boolean;
}) {
  const { t: tenantT } = useTranslation('tenant');
  const { data, isLoading, error } = useQuery({
    queryKey: ['campaign-compliance', campaignId],
    queryFn: () => api.get<{ compliance: ComplianceReport }>(`/campaigns/${campaignId}/compliance`),
    refetchInterval: 60000,
  });

  if (isLoading) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-live="polite"
        aria-label={tenantT('campaigns.compliance.checking')}
        className="bg-surface border border-border rounded-lg p-4"
      >
        <Skeleton className="h-4 w-1/3 mb-2" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-surface border border-border rounded-lg p-4 flex items-center gap-2 text-text-muted">
        <AlertCircle className="h-4 w-4" />
        <span className="text-sm">{tenantT('campaigns.compliance.unavailable')}</span>
      </div>
    );
  }

  const report = data.compliance;
  const score = report.complianceScore;
  const scoreColor = score >= 85 ? 'text-success' : score >= 60 ? 'text-warning' : 'text-danger';
  const ringColor = score >= 85 ? 'bg-success/10' : score >= 60 ? 'bg-warning/10' : 'bg-danger/10';

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          {tenantT('campaigns.compliance.title')}
        </h3>
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
          report.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
        }`}>
          {report.ok ? tenantT('campaigns.compliance.ready_to_launch') : tenantT('campaigns.compliance.action_required')}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <div className={`rounded-lg p-3 text-center ${ringColor}`}>
          <p className={`text-2xl font-bold ${scoreColor}`}>{score}</p>
          <p className="text-xs text-text-muted mt-0.5">{tenantT('campaigns.compliance.score')}</p>
        </div>
        <div className="rounded-lg p-3 text-center bg-surface-hover">
          <p className="text-2xl font-bold text-text-primary">{report.totalContacts.toLocaleString()}</p>
          <p className="text-xs text-text-muted mt-0.5">{tenantT('campaigns.compliance.contacts')}</p>
        </div>
        <div className="rounded-lg p-3 text-center bg-surface-hover">
          <p className={`text-2xl font-bold ${report.dncMatchCount > 0 ? 'text-danger' : 'text-text-primary'}`}>
            {report.dncMatchCount}
          </p>
          <p className="text-xs text-text-muted mt-0.5">{tenantT('campaigns.compliance.dnc_matches')}</p>
          {((report.tenantDncMatchCount ?? 0) > 0 || (report.federalDncMatchCount ?? 0) > 0) && (
            <p className="text-[10px] text-text-muted mt-0.5">
              {tenantT('campaigns.compliance.tenant_federal_summary', {
                tenant: report.tenantDncMatchCount ?? 0,
                federal: report.federalDncMatchCount ?? 0,
              })}
            </p>
          )}
        </div>
        <div className="rounded-lg p-3 text-center bg-surface-hover">
          <p className="text-2xl font-bold text-text-muted">{report.optedOutCount}</p>
          <p className="text-xs text-text-muted mt-0.5">{tenantT('campaigns.compliance.opted_out')}</p>
        </div>
      </div>

      {report.federalDncRegistryVersion && (
        <p className="mt-2 text-[11px] text-text-muted">
          {tenantT('campaigns.compliance.fed_registry_version_label')} <span className="font-mono">{report.federalDncRegistryVersion}</span>
        </p>
      )}

      {/*
        Channel coverage strip: confirms voice quiet hours come from the
        campaign config and that SMS is locked to the platform-wide TCPA
        window. Shows operators a single picture of both channels — Task #604.
      */}
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md border border-border bg-surface-hover px-2.5 py-2 flex items-start gap-2">
          <ShieldCheck className={`h-3.5 w-3.5 mt-0.5 flex-shrink-0 ${report.hasQuietHoursConfig ? 'text-success' : 'text-warning'}`} />
          <div>
            <p className="font-medium text-text-primary">{tenantT('campaigns.compliance.voice_quiet_hours')}</p>
            <p className="text-text-muted">
              {report.hasQuietHoursConfig
                ? (report.respectsContactTimezone
                    ? tenantT('campaigns.compliance.voice_configured_local')
                    : tenantT('campaigns.compliance.voice_configured_campaign'))
                : tenantT('campaigns.compliance.voice_not_configured')}
            </p>
          </div>
        </div>
        <div className="rounded-md border border-border bg-surface-hover px-2.5 py-2 flex items-start gap-2">
          <ShieldCheck className={`h-3.5 w-3.5 mt-0.5 flex-shrink-0 ${report.smsQuietHoursEnforced === false ? 'text-warning' : 'text-success'}`} />
          <div>
            <p className="font-medium text-text-primary flex items-center gap-1.5">
              {tenantT('campaigns.compliance.sms_quiet_hours')}
              {report.smsQuietHoursTenantOverride && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary">
                  {tenantT('campaigns.compliance.tenant_override')}
                </span>
              )}
            </p>
            <p className="text-text-muted">
              {report.smsQuietHoursEnforced === false
                ? tenantT('campaigns.compliance.sms_not_enforced')
                : tenantT('campaigns.compliance.sms_enforced', { window: report.smsQuietHoursWindow ?? tenantT('campaigns.compliance.sms_default_window') })}
            </p>
            {report.smsQuietHoursTenantOverride && report.smsQuietHoursFederalWindow && (
              <p className="text-text-muted text-[10px]">
                {tenantT('campaigns.compliance.federal_default', { window: report.smsQuietHoursFederalWindow })}
              </p>
            )}
          </div>
        </div>
      </div>

      {canScrub && <SmsQuietHoursOverrideEditor />}

      {report.dncMatches.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-text-secondary">
              {report.dncMatchCount > report.dncMatches.length
                ? tenantT('campaigns.compliance.dnc_matches_showing', { count: report.dncMatches.length })
                : tenantT('campaigns.compliance.dnc_matches_label')}
            </p>
            {canScrub && onScrub && (
              <button
                type="button"
                onClick={onScrub}
                disabled={scrubbing}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-danger/10 hover:bg-danger/20 text-danger text-xs font-medium rounded-md disabled:opacity-50"
              >
                {scrubbing ? (
                  <div className="animate-spin h-3 w-3 border-2 border-danger border-t-transparent rounded-full" />
                ) : (
                  <ShieldOff className="h-3.5 w-3.5" />
                )}
                {scrubbing ? tenantT('campaigns.compliance.scrubbing') : tenantT('campaigns.compliance.scrub', { count: report.dncMatchCount })}
              </button>
            )}
          </div>
          <div className="bg-surface-hover rounded-lg divide-y divide-border max-h-40 overflow-y-auto">
            {report.dncMatches.map((m) => (
              <div key={m.contactId} className="flex items-center justify-between px-3 py-2 gap-2">
                <span className="text-sm text-text-primary font-mono truncate">{m.phoneRedacted ?? '•••'}</span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {/*
                    Source badge: distinguish "Tenant DNC" (something this
                    tenant explicitly added or that an opt-out flow recorded)
                    from "Federal DNC" (FTC National Registry snapshot).
                    Operators care about the difference because federal
                    matches can't be removed by editing dnc_list — they need
                    to either drop the contact or rely on a documented
                    EBR/express-consent exemption.
                  */}
                  {m.source === 'federal' ? (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-warning/10 text-warning whitespace-nowrap">
                      {tenantT('campaigns.compliance.federal_dnc')}
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface text-text-secondary whitespace-nowrap">
                      {tenantT('campaigns.compliance.tenant_dnc')}
                    </span>
                  )}
                  <span className="text-xs text-text-muted truncate max-w-[120px]">{m.contactName ?? '—'}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {report.recommendations.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {report.recommendations.map((r, i) => (
            <li key={i} className="text-xs text-text-secondary flex items-start gap-1.5">
              <Info className="h-3.5 w-3.5 mt-0.5 text-text-muted flex-shrink-0" />
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CampaignDetail({ campaignId, onBack }: { campaignId: string; onBack: () => void }) {
  const { t: tenantT } = useTranslation('tenant');
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'overview' | 'contacts' | 'dnc'>('overview');
  const [showAddContacts, setShowAddContacts] = useState(false);
  const [contactPage, setContactPage] = useState(1);
  const { isManager } = useRole();

  const { data: campaignData, isLoading: loadingCampaign } = useQuery({
    queryKey: ['campaign', campaignId],
    queryFn: () => api.get<{ campaign: Campaign }>(`/campaigns/${campaignId}`),
  });
  const campaign = campaignData?.campaign;

  const { data: metricsData, error: metricsError } = useQuery({
    queryKey: ['campaign-metrics', campaignId],
    queryFn: () => api.get<{ metrics: CampaignMetrics }>(`/campaigns/${campaignId}/metrics`),
    refetchInterval: campaign?.status === 'running' ? 5000 : 30000,
  });
  const metrics = metricsData?.metrics;

  const { data: contactsData, error: contactsError, isLoading: loadingContacts } = useQuery({
    queryKey: ['campaign-contacts', campaignId, contactPage],
    queryFn: () => api.get<{ contacts: CampaignContact[]; total: number }>(`/campaigns/${campaignId}/contacts?page=${contactPage}&limit=20`),
    enabled: tab === 'contacts',
  });

  const { data: typesData } = useQuery({
    queryKey: ['campaign-types'],
    queryFn: () => api.get<{ types: CampaignTypeDefinition[] }>('/campaigns/types'),
  });

  const [launchBlock, setLaunchBlock] = useState<{ message: string; report: ComplianceReport } | null>(null);
  const [scrubResult, setScrubResult] = useState<{ scrubbed: number; relaunched: boolean; retryError?: string | null } | null>(null);

  const statusMutation = useMutation({
    mutationFn: (status: string) => api.patch(`/campaigns/${campaignId}`, { status }),
    onSuccess: () => {
      setLaunchBlock(null);
      setScrubResult(null);
      queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] });
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['campaign-compliance', campaignId] });
    },
    onError: async (err: Error & { status?: number; body?: { error?: string; compliance?: ComplianceReport } }) => {
      const body = err.body;
      if (err.status === 409 && body?.compliance) {
        setLaunchBlock({ message: body.error ?? tenantT('campaigns.detail.compliance_failed_default'), report: body.compliance });
        queryClient.setQueryData(['campaign-compliance', campaignId], { compliance: body.compliance });
      }
    },
  });

  // Scrub-and-launch helper for the launch-blocked banner. When called from
  // the banner we pass `retryStatus: 'running'` so the backend re-checks
  // compliance and (if clean) flips the campaign back to running in one round
  // trip. When invoked from the compliance panel without a launch attempt, we
  // omit retryStatus so we just scrub without changing campaign status.
  const scrubMutation = useMutation({
    mutationFn: (retryStatus?: 'running' | 'scheduled') =>
      api.post<{
        scrubbed: number;
        preflightTruncated: boolean;
        compliance: ComplianceReport;
        campaign: Campaign | null;
        retryError: string | null;
      }>(`/campaigns/${campaignId}/scrub-dnc`, retryStatus ? { retryStatus } : {}),
    onSuccess: (data, retryStatus) => {
      const relaunched = !!(retryStatus && data.campaign);
      setScrubResult({ scrubbed: data.scrubbed, relaunched, retryError: data.retryError });
      queryClient.setQueryData(['campaign-compliance', campaignId], { compliance: data.compliance });
      if (relaunched) {
        setLaunchBlock(null);
        queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] });
        queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      } else if (launchBlock) {
        setLaunchBlock({
          message: launchBlock.message,
          report: data.compliance,
        });
      }
    },
  });

  if (loadingCampaign) return <PageSkeleton />;
  if (!campaign) return <div className="text-center py-20 text-text-muted">{tenantT('campaigns.detail.not_found')}</div>;

  const config = campaign.config;
  const typeDef = typesData?.types?.find((t) => t.type === campaign.type);
  const isTypedCampaign = campaign.type !== 'outbound_call' && typeDef && typeDef.dispositions.length > 0;

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onBack} className="p-1.5 rounded-lg hover:bg-surface-hover text-text-muted hover:text-text-primary">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-text-primary">{campaign.name}</h1>
            <StatusBadge status={campaign.status} colors={STATUS_COLORS} label={statusLabel(tenantT, campaign.status)} />
            {typeDef && typeDef.type !== 'outbound_call' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary">
                {CAMPAIGN_TYPE_ICONS[typeDef.icon]}
                {typeDef.label}
              </span>
            )}
          </div>
          <p className="text-sm text-text-muted mt-0.5">{tenantT('campaigns.detail.created_at', { date: formatDate(campaign.createdAt) })}</p>
        </div>
        {isManager && (
          <div className="flex items-center gap-2">
            {campaign.status === 'draft' && (
              <button onClick={() => statusMutation.mutate('running')} disabled={statusMutation.isPending} className="inline-flex items-center gap-1.5 px-3 py-2 bg-success hover:bg-success/90 text-white text-sm font-medium rounded-lg disabled:opacity-50">
                <Play className="h-4 w-4" /> {tenantT('campaigns.detail.start')}
              </button>
            )}
            {campaign.status === 'running' && (
              <button onClick={() => statusMutation.mutate('paused')} disabled={statusMutation.isPending} className="inline-flex items-center gap-1.5 px-3 py-2 bg-warning hover:bg-warning/90 text-white text-sm font-medium rounded-lg disabled:opacity-50">
                <Pause className="h-4 w-4" /> {tenantT('campaigns.detail.pause')}
              </button>
            )}
            {campaign.status === 'paused' && (
              <button onClick={() => statusMutation.mutate('running')} disabled={statusMutation.isPending} className="inline-flex items-center gap-1.5 px-3 py-2 bg-success hover:bg-success/90 text-white text-sm font-medium rounded-lg disabled:opacity-50">
                <Play className="h-4 w-4" /> {tenantT('campaigns.detail.resume')}
              </button>
            )}
            {['draft', 'running', 'paused'].includes(campaign.status) && (
              <button onClick={() => statusMutation.mutate('cancelled')} disabled={statusMutation.isPending} className="inline-flex items-center gap-1.5 px-3 py-2 bg-danger hover:bg-danger/90 text-white text-sm font-medium rounded-lg disabled:opacity-50">
                <XCircle className="h-4 w-4" /> {tenantT('campaigns.detail.cancel')}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-1 mb-6 border-b border-border">
        {(['overview', 'contacts', 'dnc'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t ? 'border-primary text-primary' : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {tenantT(`campaigns.detail.tab_${t === 'dnc' ? 'dnc' : t}`)}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-6">
          {metricsError && (
            <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-lg flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              {tenantT('campaigns.detail.metrics_failed', { message: metricsError.message })}
            </div>
          )}

          {launchBlock && (
            <div className="bg-danger/10 border border-danger/30 text-danger text-sm px-4 py-3 rounded-lg">
              <div className="flex items-start gap-2">
                <ShieldOff className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="font-medium">{tenantT('campaigns.detail.launch_blocked', { message: launchBlock.message })}</p>
                  {launchBlock.report.dncMatchCount > 0 && (
                    <p className="text-xs mt-1 text-danger/80">
                      {tenantT('campaigns.detail.dnc_summary', { count: launchBlock.report.dncMatchCount })}
                      {((launchBlock.report.tenantDncMatchCount ?? 0) > 0 || (launchBlock.report.federalDncMatchCount ?? 0) > 0) && (
                        tenantT('campaigns.detail.dnc_summary_breakdown', {
                          tenant: launchBlock.report.tenantDncMatchCount ?? 0,
                          federal: launchBlock.report.federalDncMatchCount ?? 0,
                        })
                      )}
                      {tenantT('campaigns.detail.dnc_summary_suffix')}
                    </p>
                  )}
                  {isManager && launchBlock.report.dncMatchCount > 0 && (
                    <button
                      type="button"
                      onClick={() => scrubMutation.mutate('running')}
                      disabled={scrubMutation.isPending}
                      className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-danger hover:bg-danger/90 text-white text-xs font-medium rounded-md disabled:opacity-50"
                    >
                      {scrubMutation.isPending ? (
                        <div className="animate-spin h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full" />
                      ) : (
                        <ShieldOff className="h-3.5 w-3.5" />
                      )}
                      {scrubMutation.isPending
                        ? tenantT('campaigns.detail.scrubbing_relaunching')
                        : tenantT('campaigns.detail.scrub_relaunch', { count: launchBlock.report.dncMatchCount })}
                    </button>
                  )}
                </div>
                <button onClick={() => setLaunchBlock(null)} className="text-danger/70 hover:text-danger">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {scrubMutation.isError && (
            <div className="bg-danger/10 border border-danger/30 text-danger text-sm px-4 py-3 rounded-lg flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{tenantT('campaigns.detail.failed_to_scrub', { message: (scrubMutation.error as Error)?.message ?? tenantT('campaigns.detail.unknown_error') })}</span>
            </div>
          )}

          {scrubResult && (
            <div className={`text-sm px-4 py-3 rounded-lg flex items-start gap-2 ${
              scrubResult.relaunched
                ? 'bg-success/10 border border-success/30 text-success'
                : scrubResult.retryError
                  ? 'bg-warning/10 border border-warning/30 text-warning'
                  : 'bg-primary/10 border border-primary/30 text-primary'
            }`}>
              {scrubResult.relaunched ? (
                <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
              ) : (
                <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
              )}
              <div className="flex-1">
                <p className="font-medium">
                  {tenantT('campaigns.detail.scrubbed', { count: scrubResult.scrubbed })}
                </p>
                {scrubResult.relaunched && (
                  <p className="text-xs mt-1 opacity-80">{tenantT('campaigns.detail.launch_retried')}</p>
                )}
                {scrubResult.retryError && (
                  <p className="text-xs mt-1 opacity-80">{scrubResult.retryError}</p>
                )}
              </div>
              <button onClick={() => setScrubResult(null)} className="opacity-70 hover:opacity-100">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <CompliancePanel
            campaignId={campaignId}
            canScrub={isManager}
            onScrub={() => scrubMutation.mutate(undefined)}
            scrubbing={scrubMutation.isPending}
          />

          {isTypedCampaign && (
            <TypeMetricsPanel campaignId={campaignId} campaignType={campaign.type} />
          )}

          {metrics && (
            <div>
              <h3 className="text-sm font-semibold text-text-primary mb-3">{tenantT('campaigns.detail.call_metrics')}</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <StatCard icon={Users} label={tenantT('campaigns.detail.stat_total')} value={metrics.total.toLocaleString()} tone="neutral" />
                <StatCard icon={Clock} label={tenantT('campaigns.detail.stat_pending')} value={metrics.pending.toLocaleString()} tone="neutral" />
                <StatCard icon={Phone} label={tenantT('campaigns.detail.stat_dialing')} value={metrics.dialing.toLocaleString()} tone="primary" />
                <StatCard icon={PhoneCall} label={tenantT('campaigns.detail.stat_connected')} value={metrics.connected.toLocaleString()} tone="success" />
                <StatCard icon={CheckCircle2} label={tenantT('campaigns.detail.stat_completed')} value={metrics.completed.toLocaleString()} tone="success" />
                <StatCard icon={XCircle} label={tenantT('campaigns.detail.stat_failed')} value={metrics.failed.toLocaleString()} tone="danger" />
                <StatCard icon={PhoneMissed} label={tenantT('campaigns.detail.stat_no_answer')} value={metrics.noAnswer.toLocaleString()} tone="warning" />
                <StatCard icon={Voicemail} label={tenantT('campaigns.detail.stat_voicemail')} value={metrics.voicemail.toLocaleString()} tone="primary" />
                <StatCard icon={SkipForward} label={tenantT('campaigns.detail.stat_skipped')} value={metrics.skipped.toLocaleString()} tone="neutral" />
                <StatCard icon={ShieldOff} label={tenantT('campaigns.detail.stat_opted_out')} value={metrics.optedOut.toLocaleString()} tone="danger" />
              </div>
              <div className="mt-3">
                <StatCard icon={Activity} label={tenantT('campaigns.detail.stat_attempted')} value={metrics.attempted.toLocaleString()} tone="info" />
              </div>
              {metrics.total > 0 && (
                <div className="mt-3 h-3 bg-surface-hover rounded-full overflow-hidden flex">
                  {metrics.completed > 0 && <div className="bg-success h-full" style={{ width: `${(metrics.completed / metrics.total) * 100}%` }} />}
                  {metrics.failed > 0 && <div className="bg-danger h-full" style={{ width: `${(metrics.failed / metrics.total) * 100}%` }} />}
                  {metrics.noAnswer > 0 && <div className="bg-warning h-full" style={{ width: `${(metrics.noAnswer / metrics.total) * 100}%` }} />}
                  {metrics.voicemail > 0 && <div className="bg-primary h-full" style={{ width: `${(metrics.voicemail / metrics.total) * 100}%` }} />}
                  {metrics.optedOut > 0 && <div className="bg-danger/50 h-full" style={{ width: `${(metrics.optedOut / metrics.total) * 100}%` }} />}
                </div>
              )}
            </div>
          )}

          <div>
            <h3 className="text-sm font-semibold text-text-primary mb-3">{tenantT('campaigns.detail.configuration')}</h3>
            <div className="bg-surface border border-border rounded-lg divide-y divide-border">
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-text-muted">{tenantT('campaigns.detail.type')}</span>
                <span className="text-sm text-text-primary flex items-center gap-1.5">
                  {typeDef && CAMPAIGN_TYPE_ICONS[typeDef.icon]}
                  {typeDef?.label ?? campaign.type.replace(/_/g, ' ')}
                </span>
              </div>
              {config.timezone && (
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-text-muted">{tenantT('campaigns.detail.timezone')}</span>
                  <span className="text-sm text-text-primary">{config.timezone}</span>
                </div>
              )}
              {config.callWindowStart && (
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-text-muted">{tenantT('campaigns.detail.call_window')}</span>
                  <span className="text-sm text-text-primary">{config.callWindowStart} — {config.callWindowEnd}</span>
                </div>
              )}
              {Array.isArray(config.daysOfWeek) && config.daysOfWeek.length > 0 && (
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-text-muted">{tenantT('campaigns.detail.days')}</span>
                  <span className="text-sm text-text-primary">{config.daysOfWeek.map((d) => tenantT(`campaigns.days.${DAYS[d]}`)).join(', ')}</span>
                </div>
              )}
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-text-muted">{tenantT('campaigns.detail.concurrency')}</span>
                <span className="text-sm text-text-primary">{config.maxConcurrentCalls ?? config.maxConcurrent ?? '—'}</span>
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-text-muted">{tenantT('campaigns.detail.max_attempts')}</span>
                <span className="text-sm text-text-primary">{config.maxAttempts ?? '—'}</span>
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-text-muted">{tenantT('campaigns.detail.retry_delay')}</span>
                <span className="text-sm text-text-primary">{config.retryDelayMinutes != null ? tenantT('campaigns.detail.retry_delay_min', { count: config.retryDelayMinutes }) : '—'}</span>
              </div>
              {campaign.startedAt && (
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-text-muted">{tenantT('campaigns.detail.started')}</span>
                  <span className="text-sm text-text-primary">{formatDate(campaign.startedAt)}</span>
                </div>
              )}
              {campaign.completedAt && (
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-text-muted">{tenantT('campaigns.detail.completed_at')}</span>
                  <span className="text-sm text-text-primary">{formatDate(campaign.completedAt)}</span>
                </div>
              )}
            </div>
          </div>

          {typeDef && typeDef.configFields.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-text-primary mb-3">{tenantT('campaigns.detail.type_configuration', { type: typeDef.label })}</h3>
              <div className="bg-surface border border-border rounded-lg divide-y divide-border">
                {typeDef.configFields.map((field) => {
                  // Per-field reads keyed by `CampaignTypeDefinition.configFields[].key`
                  // — same one-line `Record<string, unknown>` view trick as the
                  // create/edit form, no type-system escape hatch on `CampaignConfig`.
                  const val = (config as Record<string, unknown>)[field.key];
                  if (val === undefined || val === null || val === '') return null;
                  return (
                    <div key={field.key} className="flex items-center justify-between px-4 py-3">
                      <span className="text-sm text-text-muted">{field.label}</span>
                      <span className="text-sm text-text-primary">
                        {typeof val === 'boolean' ? (val ? tenantT('campaigns.detail.yes') : tenantT('campaigns.detail.no')) : String(val)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'contacts' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-text-primary">
              {tenantT('campaigns.detail.contacts_section')} {contactsData && <span className="text-text-muted font-normal">({contactsData.total})</span>}
            </h3>
            {isManager && ['draft', 'paused'].includes(campaign.status) && (
              <button onClick={() => setShowAddContacts(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg">
                <Upload className="h-3.5 w-3.5" /> {tenantT('campaigns.detail.add_contacts_btn')}
              </button>
            )}
          </div>

          {contactsError ? (
            <div className="text-center py-12 text-danger">
              <AlertCircle className="h-8 w-8 mx-auto mb-2 opacity-70" />
              <p className="text-sm">{tenantT('campaigns.detail.load_contacts_failed')}</p>
              <p className="text-xs text-text-muted mt-1">{contactsError.message}</p>
            </div>
          ) : loadingContacts || !contactsData ? (
            <SkeletonRows count={5} rowClassName="h-12" />
          ) : contactsData.contacts.length === 0 ? (
            <EmptyState
              icon={Users}
              title={tenantT('campaigns.detail.no_contacts_title')}
              description={tenantT('campaigns.detail.no_contacts_desc')}
              primaryAction={isManager && ['draft', 'paused'].includes(campaign.status)
                ? { label: tenantT('campaigns.detail.add_contacts_btn'), onClick: () => setShowAddContacts(true), icon: Upload }
                : undefined}
              variant="compact"
            />
          ) : (
            <>
              <div className="bg-surface border border-border rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border bg-surface-secondary">
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">{tenantT('campaigns.detail.header_phone')}</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">{tenantT('campaigns.detail.header_name')}</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">{tenantT('campaigns.detail.header_status')}</th>
                      {isTypedCampaign && (
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">{tenantT('campaigns.detail.header_disposition')}</th>
                      )}
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">{tenantT('campaigns.detail.header_attempts')}</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">{tenantT('campaigns.detail.header_last_attempt')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {contactsData.contacts.map((c) => (
                      <tr key={c.id} className="hover:bg-surface-hover">
                        <td className="px-4 py-2.5 text-sm text-text-primary font-mono">{formatPhone(c.phoneNumber)}</td>
                        <td className="px-4 py-2.5 text-sm text-text-primary">{c.name ?? '—'}</td>
                        <td className="px-4 py-2.5"><StatusBadge status={c.status} colors={CONTACT_STATUS_COLORS} label={contactStatusLabel(tenantT, c.status)} /></td>
                        {isTypedCampaign && (
                          <td className="px-4 py-2.5">
                            {c.metadata?.typeDisposition ? (
                              <span className={`text-sm font-medium capitalize ${DISPOSITION_COLORS[c.metadata.typeDisposition] ?? 'text-text-muted'}`}>
                                {c.metadata.typeDisposition.replace(/_/g, ' ')}
                              </span>
                            ) : (
                              <span className="text-sm text-text-muted">—</span>
                            )}
                          </td>
                        )}
                        <td className="px-4 py-2.5 text-sm text-text-muted">{c.attemptCount}</td>
                        <td className="px-4 py-2.5 text-sm text-text-muted">{c.lastAttemptedAt ? formatDate(c.lastAttemptedAt) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {contactsData.total > 20 && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-text-muted">{tenantT('campaigns.detail.page_of', { page: contactPage, total: Math.ceil(contactsData.total / 20) })}</p>
                  <div className="flex gap-2">
                    <button disabled={contactPage <= 1} onClick={() => setContactPage((p) => p - 1)} className="p-1.5 rounded border border-border disabled:opacity-30 hover:bg-surface-hover"><ChevronLeft className="h-4 w-4" /></button>
                    <button disabled={contactPage >= Math.ceil(contactsData.total / 20)} onClick={() => setContactPage((p) => p + 1)} className="p-1.5 rounded border border-border disabled:opacity-30 hover:bg-surface-hover"><ChevronRight className="h-4 w-4" /></button>
                  </div>
                </div>
              )}
            </>
          )}

          {showAddContacts && (
            <AddContactsModal
              campaignId={campaignId}
              onClose={() => setShowAddContacts(false)}
              onAdded={() => queryClient.invalidateQueries({ queryKey: ['campaign-contacts', campaignId] })}
            />
          )}
        </div>
      )}

      {tab === 'dnc' && <DncPanel />}
    </div>
  );
}

function DncPanel() {
  const { t: tenantT } = useTranslation('tenant');
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [addPhone, setAddPhone] = useState('');
  const [addReason, setAddReason] = useState('');
  const [error, setError] = useState('');

  const { data: dncData, isLoading, error: dncError } = useQuery({
    queryKey: ['dnc', page],
    queryFn: () => api.get<{ entries: DncEntry[]; total: number }>(`/campaigns/dnc?page=${page}&limit=50`),
  });

  const addMutation = useMutation({
    mutationFn: () => api.post('/campaigns/dnc', { phone: addPhone, reason: addReason || undefined }),
    onSuccess: () => { setAddPhone(''); setAddReason(''); queryClient.invalidateQueries({ queryKey: ['dnc'] }); },
    onError: (err: Error) => setError(err.message),
  });

  const handleRemove = async (phone: string) => {
    try {
      const token = localStorage.getItem('auth_token');
      const res = await fetch('/api/campaigns/dnc', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
        body: JSON.stringify({ phone }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed: ${res.status}`);
      }
      queryClient.invalidateQueries({ queryKey: ['dnc'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : tenantT('campaigns.dnc_panel.remove_failed'));
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary">
          {tenantT('campaigns.dnc_panel.title')} {dncData && <span className="text-text-muted font-normal">({dncData.total})</span>}
        </h3>
      </div>

      <div className="mb-4 flex gap-2">
        <input type="text" placeholder={tenantT('campaigns.dnc_panel.phone_placeholder')} value={addPhone} onChange={(e) => setAddPhone(e.target.value)} className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
        <input type="text" placeholder={tenantT('campaigns.dnc_panel.reason_placeholder')} value={addReason} onChange={(e) => setAddReason(e.target.value)} className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
        <button onClick={() => { setError(''); addMutation.mutate(); }} disabled={!addPhone.trim() || addMutation.isPending} className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50">
          {tenantT('campaigns.dnc_panel.add')}
        </button>
      </div>
      {error && <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-lg mb-3">{error}</div>}

      {dncError ? (
        <div className="text-center py-12 text-danger">
          <AlertCircle className="h-8 w-8 mx-auto mb-2 opacity-70" />
          <p className="text-sm">{tenantT('campaigns.dnc_panel.load_failed')}</p>
          <p className="text-xs text-text-muted mt-1">{dncError.message}</p>
        </div>
      ) : isLoading ? (
        <SkeletonRows count={5} rowClassName="h-12" />
      ) : !dncData || dncData.entries.length === 0 ? (
        <EmptyState
          icon={ShieldOff}
          title={tenantT('campaigns.dnc_panel.empty_title')}
          description={tenantT('campaigns.dnc_panel.empty_desc')}
          variant="compact"
        />
      ) : (
        <>
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">{tenantT('campaigns.dnc_panel.header_phone')}</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">{tenantT('campaigns.dnc_panel.header_reason')}</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">{tenantT('campaigns.dnc_panel.header_source')}</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">{tenantT('campaigns.dnc_panel.header_added')}</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {dncData.entries.map((e) => (
                  <tr key={e.id} className="hover:bg-surface-hover">
                    <td className="px-4 py-2.5 text-sm text-text-primary font-mono">{formatPhone(e.phoneNumber)}</td>
                    <td className="px-4 py-2.5 text-sm text-text-muted">{e.reason ?? '—'}</td>
                    <td className="px-4 py-2.5 text-sm text-text-muted capitalize">{e.source}</td>
                    <td className="px-4 py-2.5 text-sm text-text-muted">{formatDate(e.createdAt)}</td>
                    <td className="px-4 py-2.5">
                      <button onClick={() => handleRemove(e.phoneNumber)} className="text-text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {dncData.total > 50 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-text-muted">{tenantT('campaigns.detail.page_of', { page, total: Math.ceil(dncData.total / 50) })}</p>
              <div className="flex gap-2">
                <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="p-1.5 rounded border border-border disabled:opacity-30 hover:bg-surface-hover"><ChevronLeft className="h-4 w-4" /></button>
                <button disabled={page >= Math.ceil(dncData.total / 50)} onClick={() => setPage((p) => p + 1)} className="p-1.5 rounded border border-border disabled:opacity-30 hover:bg-surface-hover"><ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function getCampaignTypeIcon(type: string) {
  const iconMap: Record<string, React.ReactNode> = {
    appointment_reminder: <Calendar className="h-4 w-4" />,
    lead_followup: <UserPlus className="h-4 w-4" />,
    review_request: <Star className="h-4 w-4" />,
    customer_reactivation: <RefreshCw className="h-4 w-4" />,
    upsell: <TrendingUp className="h-4 w-4" />,
    outbound_call: <Phone className="h-4 w-4" />,
  };
  return iconMap[type] ?? <Phone className="h-4 w-4" />;
}

export default function Campaigns() {
  const { t: tenantT } = useTranslation('tenant');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState<CampaignStatus | ''>('');
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();
  const { isManager } = useRole();

  const { data, isLoading } = useQuery({
    queryKey: ['campaigns', statusFilter, page],
    queryFn: () =>
      api.get<{ campaigns: Campaign[]; total: number }>(
        `/campaigns?page=${page}&limit=20${statusFilter ? `&status=${statusFilter}` : ''}`,
      ),
  });

  if (selectedId) {
    return (
      <CampaignDetail
        campaignId={selectedId}
        onBack={() => { setSelectedId(null); queryClient.invalidateQueries({ queryKey: ['campaigns'] }); }}
      />
    );
  }

  const campaigns = data?.campaigns ?? [];
  const total = data?.total ?? 0;

  return (
    <div>
      <PageHeader
        title={tenantT('campaigns.page_title')}
        description={tenantT('campaigns.page_subtitle')}
        icon={<Megaphone className="h-5 w-5" />}
        actions={
          isManager ? (
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Plus className="h-4 w-4" /> {tenantT('campaigns.list.new_campaign')}
            </button>
          ) : undefined
        }
      />

      <div
        role="tablist"
        aria-label={tenantT('campaigns.list.filter_aria')}
        className="flex flex-wrap gap-1 mb-6 border-b border-border"
      >
        {(['', 'draft', 'running', 'paused', 'completed', 'cancelled'] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={statusFilter === s}
            onClick={() => { setStatusFilter(s); setPage(1); }}
            className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              statusFilter === s
                ? 'border-primary text-primary'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {s ? tenantT(`campaigns.list.filter_${s}`) : tenantT('campaigns.list.filter_all')}
          </button>
        ))}
      </div>

      {isLoading ? (
        <SkeletonRows count={6} rowClassName="h-14" />
      ) : campaigns.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title={statusFilter
            ? tenantT('campaigns.list.empty_status_title', { status: tenantT(`campaigns.status.${statusFilter}`) })
            : tenantT('campaigns.list.empty_title')}
          description={statusFilter
            ? tenantT('campaigns.list.empty_status_desc')
            : tenantT('campaigns.list.empty_desc')}
          primaryAction={isManager
            ? { label: tenantT('campaigns.list.new_campaign'), onClick: () => setShowCreate(true), icon: Plus }
            : undefined}
          secondaryAction={statusFilter ? { label: tenantT('campaigns.list.show_all'), onClick: () => { setStatusFilter(''); setPage(1); } } : undefined}
        />
      ) : (
        <>
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-4 py-3 text-xs font-medium text-text-muted">{tenantT('campaigns.list.header_name')}</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-text-muted">{tenantT('campaigns.list.header_status')}</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-text-muted">{tenantT('campaigns.list.header_contacts')}</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-text-muted">{tenantT('campaigns.list.header_type')}</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-text-muted">{tenantT('campaigns.list.header_primary_rate')}</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-text-muted">{tenantT('campaigns.list.header_created')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {campaigns.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className="hover:bg-surface-hover cursor-pointer"
                  >
                    <td className="px-4 py-3 text-sm font-medium text-text-primary">{c.name}</td>
                    <td className="px-4 py-3"><StatusBadge status={c.status} colors={STATUS_COLORS} label={statusLabel(tenantT, c.status)} /></td>
                    <td className="px-4 py-3 text-sm text-text-muted">{(c.contactCount ?? 0).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 text-sm text-text-muted">
                        {getCampaignTypeIcon(c.type)}
                        <span className="capitalize">{c.type.replace(/_/g, ' ')}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <CampaignListPrimaryRate campaignId={c.id} campaignType={c.type} />
                    </td>
                    <td className="px-4 py-3 text-sm text-text-muted">{formatDate(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > 20 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-text-muted">{tenantT('campaigns.list.showing_count', { shown: campaigns.length, total })}</p>
              <div className="flex gap-2">
                <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="p-1.5 rounded border border-border disabled:opacity-30 hover:bg-surface-hover"><ChevronLeft className="h-4 w-4" /></button>
                <button disabled={page >= Math.ceil(total / 20)} onClick={() => setPage((p) => p + 1)} className="p-1.5 rounded border border-border disabled:opacity-30 hover:bg-surface-hover"><ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>
          )}
        </>
      )}

      {showCreate && (
        <CreateCampaignModal
          onClose={() => setShowCreate(false)}
          onCreated={() => queryClient.invalidateQueries({ queryKey: ['campaigns'] })}
        />
      )}
    </div>
  );
}
