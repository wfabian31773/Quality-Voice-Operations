export type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled';
export type ContactStatus = 'pending' | 'dialing' | 'connected' | 'completed' | 'failed' | 'skipped' | 'no_answer' | 'voicemail' | 'opted_out';
export type ContactOutcome = 'human_answered' | 'voicemail_left' | 'no_answer' | 'completed' | 'failed';

export interface CampaignScheduleConfig {
  timezone: string;
  callWindowStart: string;
  callWindowEnd: string;
  daysOfWeek: number[];
  maxConcurrentCalls: number;
  retryDelayMinutes: number;
  maxAttempts: number;
}

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

export interface CreateCampaignParams {
  tenantId: string;
  agentId: string;
  name: string;
  type?: string;
  config?: Partial<CampaignScheduleConfig>;
  scheduledAt?: Date;
}

export interface UpdateCampaignParams {
  name?: string;
  status?: CampaignStatus;
  config?: Partial<CampaignScheduleConfig>;
  scheduledAt?: Date;
}
