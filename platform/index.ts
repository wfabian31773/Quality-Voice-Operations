/**
 * Voice AI Operations Hub — Platform Module Index
 *
 * Import from this file to consume platform primitives:
 *   import { withRetry, createLogger, OutboxService } from '@platform';
 *
 * Layer map:
 *   core/           — Stateless platform primitives (no DB, no tenant)
 *   infra/          — Infrastructure utilities (locks, rate limiting, caller memory)
 *   runtime/        — Per-call stateful management
 *   workflow/       — Conversational workflow orchestration
 *   tools/          — Agent tool registry
 *   integrations/   — Durable outbox + webhook layer
 *   telephony/      — Twilio routing and phone management
 *   messaging/      — SMS / notification layer
 *   tenant/         — Per-tenant agent registry and config
 *   rbac/           — Role-based access control
 *   billing/        — Budget guard and cost ledger
 *   analytics/      — Call quality and cost reporting types
 *   demo/           — Sandboxed demo environment
 *   agent-templates/ — Vertical agent templates (answering-service, medical-after-hours)
 */

export * from './core/resilience';
export * from './core/logger';
export * from './core/env';
export * from './core/phi';
export * from './core/types';

export * from './infra/locks';
export * from './infra/rate-limit';
export * from './infra/memory';

export * from './runtime/lifecycle';

export * from './workflow';

export * from './tools/registry';

export * from './integrations/outbox';

export * from './telephony/twilio';

export * from './messaging';

export * from './tenant/registry';
export * from './tenant/config';

export * from './rbac';

export * from './billing/budget';
export * from './billing/ledger';

export * from './analytics';
