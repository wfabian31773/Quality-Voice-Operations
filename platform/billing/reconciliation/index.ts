/**
 * Public surface for the cost-reconciliation module.
 *
 * Commits 2 and 3 will add:
 *   * `ReconciliationService` — the pure compute-margin logic
 *   * `AlertDispatcher`       — the email-sending side
 * and re-export them through here. For commit 1 this file exists only
 * to fix the import path so the schema + types ship without a broken
 * re-export.
 */
export * from './types';
