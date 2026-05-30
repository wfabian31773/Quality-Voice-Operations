/**
 * Public surface for the cost-reconciliation module.
 *
 * Commit 3 will add `BillingReconciliationScheduler` (the cron timer);
 * everything else is re-exported here.
 */
export * from './types';
export {
  computeReconciliation,
  determineBillingStatus,
  determineAlertReason,
  estimateStripeFeeCents,
  alertSeverity,
  HEALTHY_FLOOR_PERCENT,
  UNBILLED_COST_CEILING_CENTS,
  DEMO_TENANT_ID,
  type TenantBillingContext,
  type StripeInvoiceLite,
  type ConversationCostsAggregate,
  type ReconciliationAdapters,
  type ComputeReconciliationParams,
} from './ReconciliationService';
export {
  sendReconciliationAlert,
  sendOpsAlert,
  shouldSendAlert,
  type AlertDecision,
  type DispatchResult,
  type OpsAlertParams,
} from './AlertDispatcher';
