# Test Coverage — Baseline & Improvement Plan

_Last measured: 2026-05-31 on branch `claude/test-coverage-analysis-eMu3w`._

This is the first real coverage measurement for the repo. Use it as the
baseline to **ratchet** against — coverage for a touched area should not go
down, and the priority modules below should go up.

## How to reproduce

```bash
npm run test:coverage     # vitest run --coverage  (backend / node suite)
node scripts/coverage-gaps.mjs   # zero-coverage file list, by module
```

- Provider: `@vitest/coverage-v8` (pinned to the same version as `vitest`).
- Scope: `platform/**`, `server/**`, `shared/**`, `scripts/**` (the packages
  the node-environment suite exercises). See `vitest.config.ts` →
  `test.coverage`.
- The React frontend (`client-app/src`) is **not** in this number — it has its
  own vitest project with a jsdom setup. Measure it with
  `npm --prefix client-app run test -- --coverage`.
- HTML report: `coverage/index.html` (gitignored). Machine summary:
  `coverage/coverage-summary.json`.

### Caveats on this baseline

The measurement was taken in a sandbox without a Postgres database, a built
client bundle, or some third-party secrets, so **56 environment-dependent
tests fail here** and a handful of code paths they would exercise are
undercounted. The headline number is therefore a *floor*. A run in CI (with the
DB + build available) will be a few points higher. The relative picture between
modules is accurate.

## Headline (backend)

| Metric      | Coverage | Covered / Total |
| ----------- | -------- | --------------- |
| Lines       | **40.7%** | 17771 / 43626 |
| Statements  | 40.1%    | 18768 / 46825 |
| Functions   | 35.1%    | 2023 / 5768 |
| Branches    | 37.9%    | 11690 / 30867 |

510 source files instrumented; **99 have zero coverage** (never imported by any
test).

## Per-module line coverage (worst first)

| Module | Line % | Files | Files at 0% | Lines |
| ------ | -----: | ----: | ----------: | ----: |
| platform/workforce | 0.3 | 7 | 6 | 578 |
| platform/simulation | 0.8 | 1 | 0 | 380 |
| platform/digital-twin | 1.3 | 5 | 0 | 551 |
| platform/evolution | 2.3 | 5 | 0 | 488 |
| platform/autopilot | 2.4 | 9 | 1 | 858 |
| platform/workflow | 3.8 | 7 | 4 | 78 |
| platform/runtime | 4.5 | 4 | 2 | 223 |
| **platform/reasoning** | **6.5** | 21 | 1 | 895 |
| platform/gin | 6.7 | 8 | 1 | 415 |
| platform/tools | 10.6 | 16 | 9 | 720 |
| platform/core | 11.2 | 23 | 13 | 498 |
| server/replit_integrations | 11.9 | 4 | 2 | 185 |
| platform/analytics | 21.4 | 18 | 1 | 1430 |
| scripts | 24.0 | 22 | 15 | 2025 |
| platform/sms | 25.8 | 2 | 0 | 372 |
| platform/marketplace | 29.5 | 7 | 0 | 740 |
| platform/tenant | 31.3 | 5 | 4 | 112 |
| **server/voice-gateway** | **31.3** | 21 | 8 | 2184 |
| platform/agent-templates | 34.0 | 60 | 6 | 594 |
| server/admin-api | 40.1 | 77 | 1 | 16531 |
| platform/knowledge | 42.7 | 6 | 0 | 443 |
| platform/infra | 48.8 | 10 | 6 | 295 |
| platform/campaigns | 54.9 | 13 | 2 | 813 |
| platform/email | 62.1 | 8 | 1 | 673 |
| platform/billing | 66.1 | 45 | 6 | 3113 |
| platform/help | 69.0 | 12 | 0 | 604 |
| platform/integrations | 70.5 | 46 | 4 | 5094 |
| platform/telephony | 75.6 | 8 | 2 | 840 |
| platform/notifications | 83.7 | 5 | 0 | 270 |
| platform/audit | 83.8 | 2 | 0 | 105 |
| shared | 86.6 | 13 | 0 | 277 |
| platform/dispatch | 92.5 | 2 | 0 | 93 |

(Modules with <10 lines omitted: `platform/index.ts`, `platform/demo`,
`platform/rbac`, `platform/messaging`, `platform/widget`, `platform/db`,
`platform/website-agent`, `platform/activation`, `platform/assistant`.)

## Progress

- **✅ `platform/reasoning`: 6.5% → 97.0% lines** (171 tests). The entire engine
  is now covered — pure-logic units (SafetyGate, ConfidenceScorer, SlotTracker,
  FallbackManager, EscalationManager, WorkflowPlanner, ReasoningTrace) at
  92–100%, all nine industry packs, and the orchestration layer (DecisionEngine
  94%, ReasoningEngine 98%, MemoryManager 100%).
- **🟡 `server/voice-gateway`: clean tier + HTTP routes covered** (113 tests).
  Six services / middleware at 100% (demoToolHandler, escalation,
  preTransferGreeting, sessionManager, twilioAdapter) and twilioReplayCache
  83.5%. HTTP routes now at **51%**: `health` and `adminMetrics` 100%,
  `adminConnectors` 96%, `twilio` webhooks 11% → **67%** (supertest with the
  signature middleware + ~14 platform deps mocked). The remaining gap is the
  realtime WebSocket tier — `routes/stream.ts` (30%, has a regression test)
  and `openaiSession.ts`.
- **🟡 `platform/core`: 11% → 39.6%** (45 tests). `resilience/` (circuit
  breaker, retry, timeout, registry, withResiliency, presets) 0% → 85.5%;
  `phi/redact` and `env/` config+validation covered. Remaining gap is the
  IO-heavy `observability/` submodule.
- **🟢 `platform/tools`: 10.6% → 79.0%** (105 tests). RetryOrchestrator,
  ConversationFallbackService, createCampaignContact, updateCrmRecord and
  registerCoreTools at 100%; ToolExecutionService, ToolHealthService,
  recordCallOutcome and retrieve_knowledge 96-99%; ToolRegistry 88%,
  OperatorNotificationPipeline 80%, lookup_customer 73%. Only the DDL-only
  `ensureReliabilityTables` and the template-stub handlers remain uncovered.

## Priority order for closing gaps

Ranked by risk × size × how low the current number is:

1. ~~**`platform/reasoning`**~~ ✅ Done — now 97.0%.
2. **`server/voice-gateway`** 🟡 partial — clean tier + HTTP routes done
   (`twilio` 67%, health/admin routes ~100%); the realtime WebSocket files
   (`openaiSession.ts`, `routes/stream.ts`) remain.
3. ~~**`platform/core` resilience + env + phi**~~ ✅ Done — core now 39.6%
   (remaining: `observability/` submodule).
4. ~~**`platform/tools` (10.6%).**~~ ✅ Done — now 79.0% (only the DDL-only
   `ensureReliabilityTables` and template-stub handlers remain).
5. **`server/admin-api` (40%, but ~10k uncovered lines).** Largest absolute
   gap. Prioritize the untested routes flagged in the analysis (`publicApi`,
   `workflows`, `autopilot`, `marketplace`, `phoneNumbers`).
6. **Near-zero engines** — `workforce`, `digital-twin`, `evolution`,
   `simulation`, `autopilot`: decide which are load-bearing vs. experimental
   before investing; test the load-bearing ones.

## Suggested guardrail (once priority work lands)

Add a per-run threshold to `vitest.config.ts` `coverage.thresholds` set just
below the then-current numbers (a ratchet), rather than a single aspirational
global target. Bump it as modules improve.
