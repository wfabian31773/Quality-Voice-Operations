/**
 * Demo Environment
 *
 * The demo module provisions a sandboxed tenant with:
 * - Pre-seeded call logs and analytics
 * - Both agent templates registered (answering-service, medical-after-hours)
 * - A read-only demo user account
 * - Budget set to $10/day maximum
 * - Outbound calls disabled
 *
 * Demo tenant ID: 'demo'
 *
 * To bootstrap: call `setupDemoTenant()` during platform initialization
 * if ENABLE_DEMO_ENV=true in environment.
 */

export const DEMO_TENANT_ID = 'demo';
export const DEMO_TENANT_NAME = 'Demo Practice';
