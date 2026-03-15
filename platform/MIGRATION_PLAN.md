# Voice AI Operations Hub — Migration Plan

## Overview

This document maps every reusable primitive from the existing single-tenant codebase into
its new home in the multi-tenant SaaS platform. It also records the transformation rules
applied at each extraction point and lists the vertical agent templates that are seeded
from existing business logic.

---

## 1. Platform Layer Map

```
platform/
├── core/                          # Stateless platform primitives
│   ├── resilience/                ← resilienceUtils.ts
│   ├── logger/                    ← structuredLogger.ts
│   ├── env/                       ← environment.ts + env.ts
│   ├── phi/                       ← phiSanitizer.ts
│   └── types/                     # Shared platform-wide types
├── runtime/                       # Per-call stateful management
│   ├── lifecycle/                 ← callLifecycleCoordinator.ts (multi-tenant)
│   ├── session/                   # Call session store (tenant-scoped)
│   └── cost/                      ← callCostService.ts patterns
├── workflow/                      # Conversational workflow orchestration
│   ├── engine/                    ← workflowEngine.ts
│   ├── types/                     ← workflowTypes.ts
│   └── definitions/               # Base slot/intent definitions
├── tools/
│   └── registry/                  # Agent tool registry (replaces static agent tools)
├── integrations/
│   ├── outbox/                    ← ticketOutboxService.ts (tenant-scoped)
│   └── webhooks/                  # Webhook inbox + retry worker
├── telephony/
│   └── twilio/                    # Twilio client + phone management
├── messaging/                     # SMS / notification layer
├── tenant/
│   ├── registry/                  ← agents.ts AgentRegistry pattern (tenant-scoped)
│   └── config/                    # Per-tenant feature flags and overrides
├── rbac/                          # Role-based access control
├── billing/
│   ├── budget/                    ← budgetGuardService.ts (per-tenant)
│   └── ledger/                    # Per-tenant billing ledger
├── analytics/                     # Call quality, cost, SLO reporting
├── demo/                          # Sandbox tenant + seeded demo data
├── agent-templates/
│   ├── answering-service/         ← answeringServiceAgent.ts vertical
│   └── medical-after-hours/       ← afterHoursAgent.ts vertical
└── infra/
    ├── locks/                     ← distributedLock.ts
    ├── rate-limit/                ← rateLimiter.ts
    └── memory/                    ← callerMemoryService.ts
```

---

## 2. Pattern-by-Pattern Migration Map

### 2.1 `resilienceUtils.ts` → `platform/core/resilience/`

| Source symbol | New location | Transformation |
|---|---|---|
| `withRetry<T>()` | `core/resilience/retry.ts` | No change; generic, zero-dependency |
| `CircuitBreaker` class | `core/resilience/circuitBreaker.ts` | Extracted to own file; singleton registry moved to `circuitBreakerRegistry.ts` |
| `withResiliency<T>()` | `core/resilience/index.ts` | Re-exported composition helper |
| `withTimeout<T>()` | `core/resilience/timeout.ts` | Standalone utility |
| `resilientFetch()` | `core/resilience/resilientFetch.ts` | No change; uses registry internally |
| `OPENAI_RETRY_CONFIG` | `core/resilience/presets.ts` | Named presets file; new presets added per integration |
| `TWILIO_RETRY_CONFIG` | `core/resilience/presets.ts` | Same |
| `TICKETING_RETRY_CONFIG` | `core/resilience/presets.ts` | Same |

**Multi-tenant delta:** None required — the resilience layer is stateless and inherently tenant-agnostic.

---

### 2.2 `structuredLogger.ts` → `platform/core/logger/`

| Source symbol | New location | Transformation |
|---|---|---|
| `StructuredLogger` class | `core/logger/StructuredLogger.ts` | Add `tenantId` as a first-class context field |
| `createLogger(component)` | `core/logger/index.ts` | Add optional `{ tenantId }` param |
| Semantic methods (`callStarted`, etc.) | `core/logger/StructuredLogger.ts` | Preserved verbatim |
| Named singletons (`callLogger` etc.) | `core/logger/index.ts` | Kept as platform defaults; tenants get scoped loggers |

**Multi-tenant delta:** Every log entry gains a `tenantId` context field. Tenant-scoped loggers are created at the call-handling boundary.

---

### 2.3 `environment.ts` + `env.ts` → `platform/core/env/`

| Source symbol | New location | Transformation |
|---|---|---|
| `validateEnv(keys)` | `core/env/validate.ts` | Generalized; `requiredKeys` typed as `string[]` with env-specific severity |
| `getEnvironmentConfig()` | `core/env/config.ts` | Split into platform-wide config vs per-tenant overrides |
| `validateProductionConfig()` | `core/env/validate.ts` | Preserved; called at platform startup |
| Secret checklist pattern | `core/env/secretChecklist.ts` | Parameterized; tenant secrets validated at tenant-onboarding time |

**Multi-tenant delta:** Platform secrets (Twilio master account, DB) validated at startup. Tenant-specific secrets (sub-account SIDs, ticketing API keys) validated at tenant activation time.

---

### 2.4 `phiSanitizer.ts` → `platform/core/phi/`

| Source symbol | New location | Transformation |
|---|---|---|
| `redactPHI(text)` | `core/phi/redact.ts` | No change; pure function |
| `redactGraderResult(result)` | `core/phi/redact.ts` | No change |
| `redactMetadata(metadata)` | `core/phi/redact.ts` | No change |
| `redactGraderResults(results)` | `core/phi/redact.ts` | No change |

**Multi-tenant delta:** None — PHI redaction is always applied globally before logs are persisted. Tenants cannot disable it.

---

### 2.5 `callLifecycleCoordinator.ts` → `platform/runtime/lifecycle/`

| Source symbol | New location | Transformation |
|---|---|---|
| `CallRecord` interface | `runtime/lifecycle/types.ts` | Add `tenantId: string` field |
| `CallState` type | `runtime/lifecycle/types.ts` | No change |
| `CallLifecycleCoordinator` class | `runtime/lifecycle/CallLifecycleCoordinator.ts` | Converted from singleton to per-tenant instance; coordinator registry in `LifecycleCoordinatorRegistry.ts` |
| `getMaxDurationMs(agentSlug)` | `runtime/lifecycle/agentPolicy.ts` | Tenant-overridable; default table preserved |
| Buffered termination logic | `runtime/lifecycle/CallLifecycleCoordinator.ts` | Preserved verbatim |
| Stale-call detector | `runtime/lifecycle/CallLifecycleCoordinator.ts` | Preserved; runs per-tenant coordinator |
| DB reconciler | `runtime/lifecycle/CallLifecycleCoordinator.ts` | Tenant-scoped DB queries |

**Multi-tenant delta:** One coordinator instance per tenant, managed by `LifecycleCoordinatorRegistry`. All DB queries filter by `tenant_id`.

---

### 2.6 `agents.ts` (pattern) → `platform/tenant/registry/`

| Source pattern | New location | Transformation |
|---|---|---|
| `AgentConfig` interface | `tenant/registry/types.ts` | Add `tenantId`, remove hardcoded phone numbers |
| `AgentRegistry` class | `tenant/registry/AgentRegistry.ts` | Converted from global singleton to per-tenant instance |
| `AgentFactory` type | `tenant/registry/types.ts` | No change |
| Phone-number-to-agent routing | `telephony/twilio/numberRouter.ts` | Extracted to telephony layer; queries tenant registry |
| `register()` / `enable()` / `disable()` | `tenant/registry/AgentRegistry.ts` | Preserved; called at tenant-onboarding + admin API |

**Multi-tenant delta:** A `TenantRegistryManager` holds one `AgentRegistry` per tenant ID. Agents are looked up by `(tenantId, agentId)`. Dynamic registration via admin API replaces the static constructor bootstrap.

---

### 2.7 `rateLimiter.ts` → `platform/infra/rate-limit/`

| Source symbol | New location | Transformation |
|---|---|---|
| `createRateLimiter(config)` | `infra/rate-limit/createRateLimiter.ts` | Key generator extended with `tenantId` scoping |
| `apiRateLimiter` | `infra/rate-limit/presets.ts` | Platform-wide preset |
| `authRateLimiter` | `infra/rate-limit/presets.ts` | Platform-wide preset |
| `webhookRateLimiter` | `infra/rate-limit/presets.ts` | Platform-wide preset |
| Sliding-window store + cleanup | `infra/rate-limit/createRateLimiter.ts` | Preserved |

**Multi-tenant delta:** Key generator defaults to `tenantId:ip` so limits are enforced per-tenant, not globally.

---

### 2.8 `ticketOutboxService.ts` → `platform/integrations/outbox/`

| Source symbol | New location | Transformation |
|---|---|---|
| `TicketOutboxService` class | `integrations/outbox/OutboxService.ts` | Schema rows gain `tenant_id`; all queries filter by tenant |
| `writeToOutbox()` | `integrations/outbox/OutboxService.ts` | Idempotency key namespaced: `tenant:<id>:call:<sid>` |
| `attemptSend()` | `integrations/outbox/OutboxService.ts` | Integration target resolved from tenant config (not hardcoded) |
| `processRetries()` | `integrations/outbox/OutboxService.ts` | Preserved; worker processes all tenants |
| `startWorker()` / `stopWorker()` | `integrations/outbox/OutboxWorker.ts` | Extracted to separate worker file |
| Dead-letter + retry backoff | `integrations/outbox/OutboxService.ts` | Preserved verbatim |

**Multi-tenant delta:** Every outbox row has `tenant_id`. The send step resolves the target API (ticketing, CRM, etc.) from `tenant.config.integrations` rather than a hardcoded client.

---

### 2.9 `distributedLock.ts` → `platform/infra/locks/`

| Source symbol | New location | Transformation |
|---|---|---|
| `DistributedLockService` class | `infra/locks/DistributedLockService.ts` | Lock names namespaced: `tenant:<id>:<lockName>` |
| `acquireLock()` | `infra/locks/DistributedLockService.ts` | No logic change |
| `refreshLock()` | `infra/locks/DistributedLockService.ts` | No logic change |
| `releaseLock()` | `infra/locks/DistributedLockService.ts` | No logic change |
| `cleanupExpiredLocks()` | `infra/locks/DistributedLockService.ts` | No logic change |
| `LockResult` / `DistributedLockOptions` | `infra/locks/types.ts` | Extracted |
| `INSTANCE_ID` | `infra/locks/DistributedLockService.ts` | Preserved |

**Multi-tenant delta:** Lock names are automatically prefixed with `tenant:<id>:` so tenants cannot accidentally contend on each other's locks.

---

### 2.10 `callerMemoryService.ts` → `platform/infra/memory/`

| Source symbol | New location | Transformation |
|---|---|---|
| `CallerMemoryService` class | `infra/memory/CallerMemoryService.ts` | Singleton → per-tenant factory; DB queries scoped by tenant |
| `CallerMemory` / `CallerHistoryEntry` | `infra/memory/types.ts` | Add `tenantId` field |
| `getCallerMemory(phone, max)` | `infra/memory/CallerMemoryService.ts` | Scoped to tenant's call_logs |
| Phone normalization | `infra/memory/CallerMemoryService.ts` | Extracted to `normalizePhone()` utility in `core/types/` |

**Multi-tenant delta:** Memory lookups query only rows belonging to the caller's tenant, preventing cross-tenant data leakage.

---

### 2.11 `budgetGuardService.ts` → `platform/billing/budget/`

| Source symbol | New location | Transformation |
|---|---|---|
| `BudgetGuardService` class | `billing/budget/BudgetGuardService.ts` | Singleton → per-tenant instance; budget stored in tenant config table |
| `getStatus()` | `billing/budget/BudgetGuardService.ts` | Queries tenant-scoped spend |
| `canMakeOutboundCall()` | `billing/budget/BudgetGuardService.ts` | Preserved; "never block inbound" rule retained as platform policy |
| `setDailyBudget(cents)` | `billing/budget/BudgetGuardService.ts` | Called from admin API scoped to tenant |
| `BudgetStatus` interface | `billing/budget/types.ts` | Extracted |

**Multi-tenant delta:** Each tenant has its own daily budget. A `BudgetGuardRegistry` holds one instance per tenant.

---

### 2.12 `workflowEngine.ts` → `platform/workflow/engine/`

| Source symbol | New location | Transformation |
|---|---|---|
| `WorkflowEngine` class | `workflow/engine/WorkflowEngine.ts` | No structural change; intent/slot definitions externalized |
| `classifyIntent(utterance)` | `workflow/engine/WorkflowEngine.ts` | Preserved |
| `ClassificationResult` | `workflow/types/index.ts` | Extracted |
| `WorkflowDirective` | `workflow/types/index.ts` | Extracted |
| `WorkflowTransition` | `workflow/types/index.ts` | Extracted |
| `INTENT_KEYWORDS` | `workflow/definitions/intentKeywords.ts` | Externalized; agent templates extend base set |
| `ESCALATION_KEYWORDS` | `workflow/definitions/escalationKeywords.ts` | Externalized; tenants can extend |
| `SLOT_DEFINITIONS` | `workflow/definitions/slotDefinitions.ts` | Externalized |

**Multi-tenant delta:** Agent templates supply their own keyword/slot definition files, imported at registration time. The engine itself is stateless and shared.

---

### 2.13 Server Startup Pattern → `platform/core/` + each server entry point

| Source pattern | New location | Notes |
|---|---|---|
| Global uncaught exception handlers | `core/env/processHandlers.ts` | Applied at every server entry point |
| Secret validation checklist | `core/env/secretChecklist.ts` | Platform secrets at boot; tenant secrets at activation |
| Database warmup before traffic | Applied in server `main()` functions | Pattern preserved, not a shared module |
| Sequential lazy-import worker startup | Applied in server `main()` functions | Pattern preserved |
| Graceful shutdown (`SIGINT`/`SIGTERM`) | `core/env/processHandlers.ts` | Shared shutdown coordinator |
| `/health` + `/healthz` endpoints | `core/http/healthRoutes.ts` | Shared Express router |
| Build version tracking | Server `main()` | Pattern preserved |

---

## 3. Vertical Agent Templates

### 3.1 Answering Service Ticketing Agent (`agent-templates/answering-service/`)

Extracted from `src/agents/answeringServiceAgent.ts` and `src/config/answeringServiceTicketing.ts`.

| Component | New file | Notes |
|---|---|---|
| System prompt builder | `prompts/systemPrompt.ts` | Practice name / knowledge injected via tenant config |
| Tool: `createServiceTicket` | `tools/createServiceTicketTool.ts` | Uses platform `OutboxService`, not hardcoded client |
| Tool: `documentTicket` | `tools/documentTicketTool.ts` | Tenant-scoped |
| Department/request-type config | `config/ticketingConfig.ts` | Tenant-overridable; defaults preserved from original |
| Priority / department detection | `config/detectionHelpers.ts` | Pure functions; no tenant dependency |
| Agent factory | `index.ts` | Returns `AgentConfig`; registered via `TenantRegistryManager` |

### 3.2 Medical After-Hours Triage Agent (`agent-templates/medical-after-hours/`)

Extracted from `src/agents/afterHoursAgent.ts` and `src/config/afterHoursTicketing.ts`.

| Component | New file | Notes |
|---|---|---|
| System prompt builder | `prompts/systemPrompt.ts` | Greeting, guardrails, next-business-day context injected dynamically |
| Medical safety guardrails | `config/guardrails.ts` | Extracted from `src/guardrails/medicalSafety.ts`; platform-managed |
| Triage outcome mappings | `config/triageOutcomes.ts` | Tenant-overridable |
| Tool: `triageAndEscalate` | `tools/triageEscalateTool.ts` | Uses platform telephony transfer |
| Tool: `createAfterHoursTicket` | `tools/createAfterHoursTicketTool.ts` | Uses platform `OutboxService` |
| Agent factory | `index.ts` | Returns `AgentConfig` |

---

## 4. What Is NOT Carried Forward

| Old artifact | Reason dropped |
|---|---|
| `src/config/azulVisionKnowledge.ts` | Single-tenant knowledge base; becomes tenant-supplied content |
| `src/config/phreesiaConfig.ts` | Vendor-specific; becomes an integration plugin |
| Hardcoded Twilio phone numbers in `agents.ts` | Moved to per-tenant phone number table |
| Single global `agentRegistry` singleton | Replaced by `TenantRegistryManager` |
| `src/voiceAgentRoutes.ts` routing assumptions | Replaced by tenant-aware routing layer |
| `dailyOpenaiReconciliation.ts` as a global service | Becomes a per-tenant scheduled job |
| `systemAlertService` (hardcoded SMS targets) | Replaced by tenant-configurable alerting |

---

## 5. Dependency Order for Implementation

```
Phase 1 — Core Primitives (no dependencies)
  core/resilience, core/logger, core/env, core/phi

Phase 2 — Infrastructure (depends on Phase 1)
  infra/locks, infra/rate-limit, infra/memory

Phase 3 — Runtime & Workflow (depends on Phase 1-2)
  runtime/lifecycle, workflow/engine

Phase 4 — Integrations & Telephony (depends on Phase 1-3)
  integrations/outbox, telephony/twilio

Phase 5 — Tenant & RBAC (depends on Phase 1-4)
  tenant/registry, tenant/config, rbac

Phase 6 — Billing & Analytics (depends on Phase 5)
  billing/budget, billing/ledger, analytics

Phase 7 — Agent Templates (depends on Phase 1-6)
  agent-templates/answering-service
  agent-templates/medical-after-hours

Phase 8 — Demo Environment (depends on Phase 7)
  demo
```
