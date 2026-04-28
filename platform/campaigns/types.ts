export type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled';
export type ContactStatus = 'pending' | 'dialing' | 'connected' | 'completed' | 'failed' | 'skipped' | 'no_answer' | 'voicemail' | 'opted_out';
export type ContactOutcome = 'human_answered' | 'voicemail_left' | 'no_answer' | 'completed' | 'failed';

export type CampaignType =
  | 'outbound_call'
  | 'appointment_reminder'
  | 'lead_followup'
  | 'review_request'
  | 'customer_reactivation'
  | 'upsell';

export type AppointmentDisposition = 'confirmed' | 'rescheduled' | 'cancelled' | 'no_response';
export type LeadFollowupDisposition = 'interested' | 'not_interested' | 'callback_requested' | 'converted' | 'no_response';
export type ReviewRequestDisposition = 'review_left' | 'feedback_given' | 'declined' | 'no_response';
export type ReactivationDisposition = 'reactivated' | 'interested' | 'not_interested' | 'no_response';
export type UpsellDisposition = 'accepted' | 'interested' | 'declined' | 'no_response';

export type TypeDisposition =
  | AppointmentDisposition
  | LeadFollowupDisposition
  | ReviewRequestDisposition
  | ReactivationDisposition
  | UpsellDisposition;

export interface CampaignScheduleConfig {
  timezone: string;
  callWindowStart: string;
  callWindowEnd: string;
  daysOfWeek: number[];
  maxConcurrentCalls: number;
  retryDelayMinutes: number;
  maxAttempts: number;
  /**
   * When true (default), quiet hours are evaluated in the called party's
   * local timezone (resolved from the NANP area code) instead of the
   * campaign owner's timezone. Required for TCPA compliance.
   */
  respectContactTimezone: boolean;
  /** Optional per-area-code timezone overrides. */
  areaCodeTimezones: Record<string, string>;
  /** Optional multi-window schedule. Takes precedence over single window. */
  callWindows: Array<{ start: string; end: string; days: number[] }>;
}

/**
 * Persisted campaign config blob. Mirrors the client-side `CampaignConfig`
 * (see `client-app/src/pages/Campaigns.tsx`): every scheduling field is
 * optional because rows persisted before a setting was introduced can
 * (and do) omit it. Per-campaign-type config fields (appointment date
 * field, lead source field, review URL, etc.) live on the same JSONB blob
 * and are intersected in via `CampaignTypeConfigFields` below — so any
 * known type-specific key is type-checked instead of silently slipping
 * through an index signature.
 */
export type CampaignConfig =
  & Partial<CampaignScheduleConfig>
  & {
    /** Legacy alias for `maxConcurrentCalls`; still read by the dialer. */
    maxConcurrent?: number;
    /** Verified outbound caller ID (Trusted Caller record id) or null when unset. */
    verifiedCallerId?: string | null;
    /**
     * Business name substituted into the per-type prompt templates as
     * the `{{businessName}}` token (see `CampaignTypeRegistry` and
     * `buildCampaignTypePromptAugmentation`).
     */
    businessName?: string;
    /**
     * Origin metadata stamped on campaigns launched by the Workforce
     * outbound launcher (`platform/workforce/WorkforceOutboundService.ts`).
     * Persisted on the JSONB blob so admin tooling can trace a campaign
     * back to the workforce task that spawned it.
     */
    workforceMeta?: {
      workforceTaskId: string;
      teamId: string | null;
      campaignType: string;
    };
  }
  & CampaignTypeConfigFields;

export interface CampaignComplianceMatch {
  contactId: string;
  phoneRedacted: string;
  contactName: string | null;
}

export interface CampaignComplianceReport {
  ok: boolean;
  totalContacts: number;
  dncMatches: CampaignComplianceMatch[];
  dncMatchCount: number;
  optedOutCount: number;
  unknownTimezoneCount: number;
  hasQuietHoursConfig: boolean;
  respectsContactTimezone: boolean;
  complianceScore: number;
  recommendations: string[];
}

export interface AppointmentReminderConfig {
  appointmentDateField?: string;
  appointmentTimeField?: string;
  providerNameField?: string;
  locationField?: string;
  allowReschedule?: boolean;
}

export interface LeadFollowupConfig {
  sourceField?: string;
  productInterestField?: string;
  followupGoal?: string;
}

export interface ReviewRequestConfig {
  serviceNameField?: string;
  reviewUrl?: string;
  minimumSatisfactionToAskReview?: number;
}

export interface ReactivationConfig {
  inactiveDaysThreshold?: number;
  offerField?: string;
  reengagementMessage?: string;
}

export interface UpsellConfig {
  currentProductField?: string;
  upsellProductField?: string;
  discountField?: string;
}

/**
 * Discriminated-style union of every per-campaign-type config interface.
 * Useful when you want to talk about "exactly one of these shapes" in
 * isolation (e.g. validation helpers or registry-driven UIs).
 */
export type CampaignTypeConfig =
  | AppointmentReminderConfig
  | LeadFollowupConfig
  | ReviewRequestConfig
  | ReactivationConfig
  | UpsellConfig;

/**
 * Flattened intersection of every per-campaign-type config interface.
 * All keys are optional, so this is safe to merge into the schedule
 * config without forcing any one type's fields. Adding a new type-
 * specific field (in one of the source interfaces above) automatically
 * propagates here and into `CampaignConfig`, so a typo like
 * `appointmentDateFiled` becomes a compile error instead of silently
 * vanishing into a `Record<string, unknown>` escape hatch.
 */
export type CampaignTypeConfigFields =
  & AppointmentReminderConfig
  & LeadFollowupConfig
  & ReviewRequestConfig
  & ReactivationConfig
  & UpsellConfig;

export interface Campaign {
  id: string;
  tenantId: string;
  agentId: string;
  name: string;
  type: string;
  status: CampaignStatus;
  config: CampaignConfig;
  scheduledAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignContact {
  id: string;
  tenantId: string;
  campaignId: string;
  phoneNumber: string;
  name: string | null;
  status: ContactStatus;
  outcome: ContactOutcome | null;
  attemptCount: number;
  lastAttemptedAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignMetrics {
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
  /**
   * How many times the scheduler reverted a contact to "pending" because
   * it was outside that contact's local call window. Counts skip events,
   * not unique contacts — the same contact can be skipped on every poll
   * until it falls back inside its window.
   */
  quietHoursSkips: number;
}

export interface TypeSpecificMetrics {
  campaignType: CampaignType;
  dispositions: Record<string, number>;
  primaryRate: number;
  primaryRateLabel: string;
}

export interface CreateCampaignParams {
  tenantId: string;
  agentId: string;
  name: string;
  type?: string;
  config?: CampaignConfig;
  scheduledAt?: Date;
}

export interface UpdateCampaignParams {
  name?: string;
  status?: CampaignStatus;
  config?: CampaignConfig;
  scheduledAt?: Date;
}
