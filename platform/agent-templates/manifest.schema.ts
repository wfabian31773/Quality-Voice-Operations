import type { PlanTier } from '../billing/stripe/plans';

export interface TemplateManifest {
  slug: string;
  displayName: string;
  description: string;
  shortDescription: string;
  version: string;
  agentType: 'inbound' | 'outbound';
  category: string[];
  supportedChannels: string[];
  requiredTools: string[];
  optionalTools: string[];
  defaultVoice: string;
  defaultLanguage: string;
  minPlan: PlanTier;
  tags: string[];
  configSchema: Record<string, unknown>;
  iconUrl?: string;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
}
