export * from './types';
export {
  getCallAnalytics,
  getCampaignAnalytics,
  getAgentAnalytics,
  getCostAnalytics,
} from './AnalyticsService';
export type {
  CallAnalyticsResult,
  CampaignAnalyticsResult,
  AgentAnalyticsResult,
  CostAnalyticsResult,
} from './AnalyticsService';
export {
  QUALITY_SCORING_RUBRIC,
  scoreCall,
  getCallQualityScore,
  getQualityAnalytics,
  getLowestScoringCalls,
} from './QualityScorerService';
export type {
  QualityScore,
  QualityTrend,
  LowestScoringCall,
} from './QualityScorerService';
export {
  getRevenueAttribution,
} from './RevenueAttributionService';
export type {
  RevenueAttributionResult,
} from './RevenueAttributionService';
export {
  analyzeCallSentiment,
  getSentimentTrends,
  getAgentSentiments,
} from './SentimentAnalysisService';
export type {
  SentimentScore,
  SentimentTrend,
  AgentSentiment,
} from './SentimentAnalysisService';
export {
  classifyCallTopic,
  getTopicDistribution,
  getTopicTrends,
} from './TopicClusteringService';
export type {
  TopicClassification,
  TopicDistribution,
  TopicTrend,
} from './TopicClusteringService';
export {
  recordConversionStage,
  getConversionFunnel,
  getConversionTrends,
  FUNNEL_STAGES,
} from './ConversionFunnelService';
export type {
  FunnelStage,
  FunnelMetrics,
  FunnelTrend,
} from './ConversionFunnelService';
export {
  runInsightsAnalysis,
  getInsights,
  getInsightsSummary,
  updateInsightStatus,
  generateWeeklyReport,
  getWeeklyReports,
  detectAnomalies,
  getAlertHistory,
  acknowledgeAlert,
  measureInsightImpact,
} from './InsightsEngine';
export type {
  AiInsight,
  WeeklyReport,
  InsightsSummary,
  OperationsAlert,
} from './InsightsEngine';
export { startInsightsScheduler, stopInsightsScheduler } from './InsightsScheduler';
export {
  detectWeaknesses,
  generatePromptImprovement,
  simulateImprovement,
  analyzeCallAndGenerateSuggestions,
  getSuggestions,
  getSuggestionById,
  acceptSuggestion,
  dismissSuggestion,
  getImprovementVelocity,
  getCategoryBreakdown,
} from './SelfImprovementService';
export type {
  WeaknessCategory,
  SuggestionStatus,
  WeaknessDetection,
  PromptImprovementSuggestion,
  ImprovementMetrics,
  ImprovementVelocity,
} from './SelfImprovementService';
export {
  checkMilestones,
  generateCaseStudy,
  getCaseStudies,
  getPublicCaseStudy,
  getPublishedCaseStudies,
  updateCaseStudyStatus,
  DEFAULT_MILESTONES,
} from './CaseStudyService';
export type {
  CaseStudy,
  PublicCaseStudy,
  CaseStudyMetrics,
  MilestoneThreshold,
} from './CaseStudyService';
export {
  recordConversionEvent,
  getWebsiteFunnel,
  getConversionTrends as getWebsiteConversionTrends,
  WEBSITE_FUNNEL_STAGES,
} from './WebsiteConversionService';
export type {
  ConversionEvent,
  ConversionStage,
  WebsiteFunnelMetrics,
} from './WebsiteConversionService';
