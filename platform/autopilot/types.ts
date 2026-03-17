export interface AutopilotInsight {
  id: string;
  tenantId: string;
  runId: string | null;
  category: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string;
  detectedSignal: string;
  dataEvidence: Record<string, unknown>;
  industryPack: string | null;
  confidenceScore: number;
  status: string;
  resolvedAt: string | null;
  metadata: Record<string, unknown>;
  analysisPeriodStart: string | null;
  analysisPeriodEnd: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutopilotRecommendation {
  id: string;
  tenantId: string;
  insightId: string | null;
  runId: string | null;
  title: string;
  situationSummary: string;
  recommendedAction: string;
  expectedOutcome: string;
  reasoning: string;
  confidenceScore: number;
  riskTier: 'low' | 'medium' | 'high';
  actionType: string;
  actionPayload: Record<string, unknown>;
  estimatedRevenueImpactCents: number | null;
  estimatedCostSavingsCents: number | null;
  status: 'pending' | 'approved' | 'rejected' | 'dismissed' | 'executed' | 'expired';
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  dismissedBy: string | null;
  dismissedAt: string | null;
  expiresAt: string | null;
  industryPack: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AutopilotAction {
  id: string;
  tenantId: string;
  recommendationId: string | null;
  actionType: string;
  actionPayload: Record<string, unknown>;
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'rolled_back';
  executedAt: string | null;
  completedAt: string | null;
  result: Record<string, unknown>;
  errorMessage: string | null;
  rollbackPayload: Record<string, unknown> | null;
  rolledBack: boolean;
  rolledBackAt: string | null;
  rolledBackBy: string | null;
  executedBy: string | null;
  autoExecuted: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AutopilotPolicy {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  riskTier: 'low' | 'medium' | 'high';
  actionType: string;
  requiresApproval: boolean;
  approvalRole: string;
  autoExecute: boolean;
  enabled: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AutopilotApproval {
  id: string;
  tenantId: string;
  recommendationId: string;
  action: 'approved' | 'rejected' | 'dismissed';
  userId: string;
  userRole: string | null;
  reason: string | null;
  createdAt: string;
}

export interface AutopilotImpactReport {
  id: string;
  tenantId: string;
  actionId: string | null;
  recommendationId: string | null;
  reportType: string;
  metricsBefore: Record<string, unknown>;
  metricsAfter: Record<string, unknown>;
  measuredRevenueImpactCents: number | null;
  measuredCostSavingsCents: number | null;
  improvementPercentage: number | null;
  assessment: string | null;
  measurementPeriodStart: string | null;
  measurementPeriodEnd: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AutopilotRun {
  id: string;
  tenantId: string;
  runType: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  insightsDetected: number;
  recommendationsGenerated: number;
  actionsAutoExecuted: number;
  errors: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AutopilotNotification {
  id: string;
  tenantId: string;
  recommendationId: string | null;
  insightId: string | null;
  channel: 'in_app' | 'email' | 'sms';
  severity: string;
  title: string;
  body: string;
  read: boolean;
  readAt: string | null;
  delivered: boolean;
  deliveredAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface IndustryAutopilotPack {
  vertical: string;
  displayName: string;
  detectionRules: IndustryDetectionRule[];
}

export interface IndustryDetectionRule {
  id: string;
  vertical: string;
  name: string;
  description: string;
  category: string;
  severity: 'info' | 'warning' | 'critical';
  riskTier: 'low' | 'medium' | 'high';
  evaluate: (signals: OperationalSignals) => DetectionResult | null;
}

export interface OperationalSignals {
  tenantId: string;
  industry: string | null;
  callVolume: { total: number; missed: number; completed: number; failed: number; escalated: number };
  bookingMetrics: { total: number; converted: number; cancelled: number; noShow: number };
  sentimentAvg: number;
  hourlyCallPattern: Array<{ hour: number; calls: number; missed: number }>;
  agentMetrics: Array<{ agentId: string; agentName: string; calls: number; avgDuration: number; escalated: number; failed: number }>;
  toolFailures: Array<{ tool: string; failures: number; total: number }>;
  campaignMetrics: Array<{ campaignId: string; name: string; contacted: number; converted: number; failed: number }>;
  afterHoursCalls: number;
  repeatCallers: number;
  avgWaitTime: number;
  previousPeriodCallVolume: number;
}

export interface DetectionResult {
  title: string;
  description: string;
  detectedSignal: string;
  dataEvidence: Record<string, unknown>;
  confidenceScore: number;
  recommendedAction: string;
  expectedOutcome: string;
  reasoning: string;
  actionType: string;
  actionPayload: Record<string, unknown>;
  estimatedRevenueImpactCents?: number;
  estimatedCostSavingsCents?: number;
}
