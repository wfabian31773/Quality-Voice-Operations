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
  /**
   * Ignored, and must stay 'starter': every plan includes every template
   * (docs/shop/tools-spec.md, "Plans and entitlements"). Kept so existing
   * manifests still match the schema.
   */
  minPlan: 'starter';
  tags: string[];
  configSchema: Record<string, unknown>;
  iconUrl?: string;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
}
