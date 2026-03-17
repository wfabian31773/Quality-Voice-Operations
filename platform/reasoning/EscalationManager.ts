import { createLogger } from '../core/logger';
import type {
  EscalationTrigger,
  EscalationOutput,
  EscalationEvent,
  ReasoningContext,
  ConfidenceScore,
} from './types';

const logger = createLogger('ESCALATION_MANAGER');

const EMERGENCY_KEYWORDS: string[] = [
  'chest pain', 'heart attack', "can't breathe", 'difficulty breathing',
  'stroke', 'unconscious', 'not responding', 'severe bleeding',
  'suicidal', 'overdose', 'anaphylaxis', 'allergic reaction',
  'call 911', 'dying', 'seizure', 'choking',
  'gas leak', 'fire', 'carbon monoxide', 'flood',
  'break in', 'intruder', 'active shooter',
];

const BILLING_DISPUTE_KEYWORDS: string[] = [
  'overcharged', 'wrong bill', 'dispute', 'unauthorized charge',
  'fraudulent', 'cancel my account', 'refund', 'billing error',
  'double charged', 'never authorized',
];

const HUMAN_REQUEST_KEYWORDS: string[] = [
  'speak to someone', 'talk to a person', 'human', 'operator',
  'representative', 'receptionist', 'front desk', 'real person',
  'manager', 'supervisor', 'live agent',
];

interface EscalationConfig {
  maxConfusionTurns: number;
  maxLowConfidenceRetries: number;
  emergencyKeywords: string[];
  billingDisputeKeywords: string[];
  humanRequestKeywords: string[];
}

const DEFAULT_CONFIG: EscalationConfig = {
  maxConfusionTurns: 3,
  maxLowConfidenceRetries: 4,
  emergencyKeywords: EMERGENCY_KEYWORDS,
  billingDisputeKeywords: BILLING_DISPUTE_KEYWORDS,
  humanRequestKeywords: HUMAN_REQUEST_KEYWORDS,
};

export class EscalationManager {
  private readonly config: EscalationConfig;
  private confusionCount = 0;
  private lowConfidenceRetries = 0;
  private escalationHistory: EscalationEvent[] = [];

  constructor(config: Partial<EscalationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  evaluate(context: ReasoningContext, confidence: ConfidenceScore): EscalationEvent | null {
    const utterance = context.currentUtterance.toLowerCase();

    const emergencyCheck = this.checkEmergencyKeywords(utterance, context);
    if (emergencyCheck) return this.recordEscalation(emergencyCheck);

    const humanCheck = this.checkHumanRequest(utterance, context);
    if (humanCheck) return this.recordEscalation(humanCheck);

    const billingCheck = this.checkBillingDispute(utterance, context);
    if (billingCheck) return this.recordEscalation(billingCheck);

    const confusionCheck = this.checkRepeatedConfusion(context, confidence);
    if (confusionCheck) return this.recordEscalation(confusionCheck);

    const retryCheck = this.checkLowConfidenceRetries(confidence);
    if (retryCheck) return this.recordEscalation(retryCheck);

    return null;
  }

  recordConfusion(): void {
    this.confusionCount++;
  }

  recordLowConfidence(): void {
    this.lowConfidenceRetries++;
  }

  resetCounters(): void {
    this.confusionCount = 0;
    this.lowConfidenceRetries = 0;
  }

  getEscalationHistory(): EscalationEvent[] {
    return [...this.escalationHistory];
  }

  private checkEmergencyKeywords(utterance: string, context: ReasoningContext): EscalationEvent | null {
    for (const keyword of this.config.emergencyKeywords) {
      if (utterance.includes(keyword.toLowerCase())) {
        return {
          trigger: 'emergency_keyword',
          output: 'warm_transfer',
          reason: `Emergency keyword detected: "${keyword}"`,
          metadata: {
            keyword,
            callSessionId: context.callSessionId,
            callerNumber: context.callerNumber,
          },
          timestamp: new Date(),
        };
      }
    }
    return null;
  }

  private checkHumanRequest(utterance: string, context: ReasoningContext): EscalationEvent | null {
    for (const keyword of this.config.humanRequestKeywords) {
      if (utterance.includes(keyword.toLowerCase())) {
        return {
          trigger: 'explicit_human_request',
          output: 'warm_transfer',
          reason: `Caller explicitly requested human assistance: "${keyword}"`,
          metadata: {
            keyword,
            callSessionId: context.callSessionId,
          },
          timestamp: new Date(),
        };
      }
    }
    return null;
  }

  private checkBillingDispute(utterance: string, context: ReasoningContext): EscalationEvent | null {
    for (const keyword of this.config.billingDisputeKeywords) {
      if (utterance.includes(keyword.toLowerCase())) {
        return {
          trigger: 'billing_dispute',
          output: 'urgent_ticket',
          reason: `Billing dispute keyword detected: "${keyword}"`,
          metadata: {
            keyword,
            callSessionId: context.callSessionId,
          },
          timestamp: new Date(),
        };
      }
    }
    return null;
  }

  private checkRepeatedConfusion(context: ReasoningContext, confidence: ConfidenceScore): EscalationEvent | null {
    if (confidence.overall === 'low') {
      this.confusionCount++;
    }

    if (this.confusionCount >= this.config.maxConfusionTurns) {
      return {
        trigger: 'repeated_confusion',
        output: 'callback',
        reason: `Repeated confusion detected after ${this.confusionCount} turns with low confidence`,
        metadata: {
          confusionCount: this.confusionCount,
          callSessionId: context.callSessionId,
          lastConfidence: confidence.numericScore,
        },
        timestamp: new Date(),
      };
    }
    return null;
  }

  private checkLowConfidenceRetries(confidence: ConfidenceScore): EscalationEvent | null {
    if (confidence.overall === 'low') {
      this.lowConfidenceRetries++;
    }

    if (this.lowConfidenceRetries >= this.config.maxLowConfidenceRetries) {
      return {
        trigger: 'low_confidence_retries',
        output: 'sms_followup',
        reason: `Low confidence persisted for ${this.lowConfidenceRetries} consecutive turns`,
        metadata: {
          retryCount: this.lowConfidenceRetries,
          lastScore: confidence.numericScore,
        },
        timestamp: new Date(),
      };
    }
    return null;
  }

  private recordEscalation(event: EscalationEvent): EscalationEvent {
    this.escalationHistory.push(event);
    logger.warn('Escalation triggered', {
      trigger: event.trigger,
      output: event.output,
      reason: event.reason,
    });
    return event;
  }
}
