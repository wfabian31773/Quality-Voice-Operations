# Operations Console Audit — 7 pages

> Agent: `everything-claude-code:code-reviewer` · 2026-05-24
> Full original report; see [CONSOLE_REDESIGN_PLAN.md](../CONSOLE_REDESIGN_PLAN.md) for synthesis + tier ordering.

## 1. Grep Totals

| Pattern | Count |
|---|---|
| Hardcoded hex colors | 20 — all in `CostOptimization.tsx` (chart layer) |
| Tailwind named rainbow classes | **0** — all semantic tokens (`bg-danger`, `text-success`, etc.) |
| `bg-/text-/border-` class usages (total) | 896 |
| `EventSource` | 4 (both in Operations.tsx) |
| `onerror` reconnect logic | 1 — only `setConnected(false)`, no retry |
| `setInterval` polling | 5 across 3 files |
| `z-index` hotspots | 1 in DigitalTwin.tsx (z-10 dropdown), z-50 in OpsLayout mobile modal |
| `fixed inset-0` overlays | 6 overflow-y-auto scroll boxes in Operations.tsx |
| `console.log` debug statements | 0 |
| **Distinct status-color helper functions** | **11** across 7 files |

## 2. Per-Page Red Flags

| Page | LOC | Hex | Status palettes | SSE | Reconnect | Z-index |
|---|---|---|---|---|---|---|
| `Operations.tsx` | 994 | 0 | 2 (`severityColor`, `stateBadgeMeta`) | Yes (2 streams) | `onerror` only — no retry | None |
| `CallDebug.tsx` | 1040 | 0 | 2 (`sentimentBand`, `traceColor`) | No (historical) | N/A | None |
| `IntegrationDiagnostics.tsx` | 894 | 0 | 2 (`StatusBadge`, inline dot) | No (30s poll) | N/A | None |
| `CostOptimization.tsx` | 714 | **20** | 1 (tier colors) | No (on-demand) | N/A | None |
| `ToolHealth.tsx` | 846 | 0 | 3 (`priorityColor`, `statusColor`, `successRateColor`) | No (15s poll, webhook tab only) | N/A | None |
| `admin/BackfillCalls.tsx` | 855 | 0 | 1 (`SubmitBadge`) | No | N/A | None |
| `DigitalTwin.tsx` | 1288 | 0 | 2 (riskLevel + run.status inline) | No (1s sim polling) | N/A | **z-10 dropdown** |

## 3. Top 5 User-Visible Problems

**Problem 1 — SSE disconnects silently; operators see stale active-call data** [HIGH]

`/client-app/src/pages/Operations.tsx` lines 117–118:
```ts
es.onopen = () => setConnected(true);
es.onerror = () => setConnected(false);
```

`onerror` fires and flips header badge to "Connecting…" but `EventSource` immediately tries to reconnect on its own internal timer. **Between error and next `onopen`, `activeCalls` state is never cleared** — holds the last snapshot as if it were live. No staleness timestamp, no "Last updated X seconds ago" label, no backoff cap. **An operator watching the screen after a server hiccup sees a frozen call list that still looks live.** The per-call SSE (`useCallSSE`, 129–205) has no `onerror` at all — fails silently without even toggling a flag.

**Problem 2 — DigitalTwin dropdown z-10 covered by z-50 FAB and z-[90] modals** [HIGH]

`/client-app/src/pages/DigitalTwin.tsx` line 676

`ModelSelectorDropdown` renders a custom popover at z-10. PlatformAssistant FAB sits at z-50. Modal default uses z-[90]. OpsLayout mobile nav uses z-50. **Most likely source of user-reported "overlay issues."**

**Problem 3 — ToolHealth health-tab errors silently swallowed; no error UI** [HIGH]

`/client-app/src/pages/ToolHealth.tsx` lines 200–201:
```ts
} catch {
  // silently handle fetch errors
}
```

Outer `catch` swallows all health tab errors. Inner tabs (escalations, webhookSecurity) set error state, but health tab does not. If `/tool-health/metrics` fails, `healthData` stays `null` and page renders nothing. **No banner, no retry button.**

**Problem 4 — DigitalTwin useEffect at line 204–206 suppresses required deps**

`loadModels` closes over `selectedModel` (own dep array at line 173). Boot effect intentionally runs once, but `loadModels` is `useCallback([selectedModel])`. ESLint exhaustive-deps would flag this. **Real consequence:** if user selects a model before initial load completes, `loadModels` may run with stale `selectedModel` reference and not auto-select, leaving dropdown empty. Lines 208–213 (`loadRuns`/`loadForecasts`) suppress lint similarly.

**Problem 5 — CostOptimization 20 hardcoded hex values; dark-mode contrast not guaranteed**

`/client-app/src/pages/CostOptimization.tsx` lines 105–109, 261–264, 441–453

Colors like `#27272a` (Recharts grid), `#71717a` (axis ticks), `#18181b` (tooltip background) are hard-wired Zinc palette values. **In light mode `#18181b` near-black tooltip background becomes invisible.** Design system has CSS variable tokens (`--color-surface`, `--color-border`) that would auto-switch; Recharts bypasses them.

## 4. Status-Color Taxonomy

**11 distinct status-to-color mapping functions/objects** across the 7 files. None shared via common import.

| File | Functions | Status vocab |
|---|---|---|
| `Operations.tsx` | `severityColor`, `stateBadgeMeta` | `critical/error/warning`; `CALL_CONNECTED/FAILED/ESCALATED` |
| `CallDebug.tsx` | `sentimentBand`, `traceColor` | sentiment thresholds; `transcript/event/tool/trace` |
| `IntegrationDiagnostics.tsx` | `StatusBadge`, inline dot | `delivered/sent/pending/processing/failed/dead_letter` |
| `CostOptimization.tsx` | `TIER_COLORS` | `economy/standard/premium` → hex |
| `ToolHealth.tsx` | `priorityColor`, `statusColor`, `successRateColor` | `critical/high/medium`; `pending/in_progress/completed/dismissed`; numeric thresholds |
| `BackfillCalls.tsx` | `SubmitBadge` | `ok/skipped/error` |
| `DigitalTwin.tsx` | Inline ternary ×2 | `low/medium/high`; `completed/running/failed` |

**Positive:** Every file uses design-system semantic token names (`bg-danger-light text-danger` etc.) so token layer is consistent. **Redundancy:** 11 separate inline re-implementations of essentially the same three-tier traffic-light logic. No shared `<StatusBadge status="..." />` or `statusToTone()` utility.

## 5. Patterns Repeated 3+ Times

1. **Three-tier traffic-light color mapping** (`danger/warning/success/info`) — local function in every single file. A shared `statusTone(s: string): BadgeTone` + existing `<Badge>` would replace all 11.
2. **`max-h-* overflow-y-auto` scroll containers** — 6 times in Operations.tsx (lines 347, 465, 506, 582, 681) with different max-h values. No `<ScrollPane>` abstraction.
3. **`bg-surface border border-border rounded-xl overflow-hidden`** card shell — verbatim at ToolHealth:332, 469, 596; CallDebug:625, 939. Need `<Card>` primitive.
4. **Silent `catch {}`** — 5 in Operations.tsx, 2 in ToolHealth.tsx. Across an ops console showing real-time health data, every silent failure is a "why is this blank?" incident.
5. **`setInterval(() => forceTick(n => n + 1), 1000)`** clock tick — identical in CostOptimization:197 and DigitalTwin:153. Need `useClockTick()` hook.

## 6. Recommended P0 Pages to Rebuild First

1. **Operations.tsx (994 lines)** — rebuild SSE hooks first, then restructure layout. Live-ops nerve center with no reconnect backoff, no stale-data timeout, no "last received" timestamp, `useCallSSE` zero error handling. Highest operational cost on silent failures.
2. **DigitalTwin.tsx (1288 lines, largest)** — overlay bug + stale closure chain. z-10 dropdown loses to z-50 FAB. Two useEffect with suppressed deps. 1-second sim polling. 16 catch blocks. Split out `CreateModelModal`, `ModelSelectorDropdown`, `SimulationProgressPanel`, `ModelOverview`.
3. **ToolHealth.tsx (846 lines)** — silent health-tab errors + webhook-only polling gap. Health/escalations tabs never auto-refresh — operator on health tab for 20min sees 20min-stale data with no indication. Add `refetchInterval` via React Query, surface outer error to banner.

## Severity Summary

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 3 |
| MEDIUM | 5 |
| LOW | 3 |

**HIGH issues:** (1) SSE no reconnect/stale-disclosure on live-ops monitor; (2) DigitalTwin z-10 dropdown clipped by z-50 FAB / z-[90] modals — **confirmed source of reported overlay bugs**; (3) ToolHealth silent fetch error swallows.

**Verdict: WARNING** — SSE stale-data and overlay z-index conflict are the two most likely causes of user-reported "errors with overlays and all kinds of issues."
