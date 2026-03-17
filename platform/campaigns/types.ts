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

export type CampaignTypeConfig =
  | AppointmentReminderConfig
  | LeadFollowupConfig
  | ReviewRequestConfig
  | ReactivationConfig
  | UpsellConfig;

export interface Campaign {
  id: string;
  tenantId: string;
  agentId: string;
  name: string;
  type: string;
  status: CampaignStatus;
  config: Partial<CampaignScheduleConfig> & Record<string, unknown>;
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
  config?: Partial<CampaignScheduleConfig> & Record<string, unknown>;
  scheduledAt?: Date;
}

export interface UpdateCampaignParams {
  name?: string;
  status?: CampaignStatus;
  config?: Partial<CampaignScheduleConfig> & Record<string, unknown>;
  scheduledAt?: Date;
}
