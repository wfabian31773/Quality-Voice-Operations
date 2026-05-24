# Platform Admin Console Audit — 12 pages, 20,708 LOC

> Agent: `everything-claude-code:code-reviewer` · 2026-05-24
> Full original report; see [CONSOLE_REDESIGN_PLAN.md](../CONSOLE_REDESIGN_PLAN.md) for synthesis + tier ordering.

## 1. Grep Totals

| Pattern | Total hits |
|---|---|
| Hardcoded hex colors | **21** (PlatformAdmin 3, AdminAnalytics 6, AdminTenantAnalytics 7, Billing 5) |
| Rainbow Tailwind named colors | **0** — design-system semantic tokens used throughout (positive signal) |
| Gradient soup | **0** |
| Inline `style={{}}` | **7** (PlatformAdmin 5, Billing 1, AdminTenantAnalytics 1) — all progress-bar `width: %`, not color violations |
| `z-[N]` hotspots | **3** (PlatformAdmin:2077, AdminTenantCalls:176, :179) |
| Fixed/sticky positioning | **3** (same two files) |
| Lucide import blocks | **12** — AdminTenantCampaign has a split import (line 4 + line 8) |
| Modal/Drawer/Sheet/Dialog tags | **5** across 4 files |

## 2. Per-Page Red Flags Table

| Page | LOC | hex | inline styles | z-index | Modals | Notable |
|---|---|---|---|---|---|---|
| **PlatformAdmin.tsx** | **10,037** | 3 (comments) | 5 (progress) | 1 (z-50) | 0 | God file — 13 tabs, ~30 embedded component fns, 5 `limit=200` unbounded fetches share one scroll surface |
| **AdminAnalytics.tsx** | 489 | 6 | 0 | 0 | 0 | `#a855f7` (purple-500) hardcoded chart fill at line 244 — off-brand |
| **AdminTenantAnalytics.tsx** | 337 | 7 | 1 | 0 | 0 | `#3b82f6` / `#8b5cf6` chart fills (179-180); diverges from AdminAnalytics palette |
| **AdminTenantCalls.tsx** | 735 | 0 | 0 | 2 | 1 | z-50 + z-10 stacked inside slide-out drawer — inner sticky header may clip |
| **AdminTenantCampaign.tsx** | 249 | 0 | 0 | 0 | 0 | Split Lucide import (line 4 + line 8) — copy-paste signal |
| **AdminTenantConnectors.tsx** | 317 | 0 | 0 | 0 | 0 | Clean |
| **AdminMarketplace.tsx** | 809 | 0 | 0 | 0 | 2 | Two `Modal` declarations with divergent `panelClassName` (`bg-surface` vs `bg-surface-inverse`, `shadow-lg` vs `shadow-xl`, `max-h-80vh` vs `max-h-90vh`) |
| **AdminSalesInbox.tsx** | 2,093 | 0 | 0 | 0 | 2 | Two modals with **identical 100-char `panelClassName` strings** (exact duplicate); main query polls 30s, sibling queries poll 5min — mismatched stale windows |
| **Billing.tsx** | 3,056 | 5 (comments) | 1 (progress) | 0 | 0 | `isAdmin` divergence across **10+ conditional blocks**, no single source of truth |
| **PlatformCompliance.tsx** | 1,732 | 0 | 0 | 0 | 0 | 8 top-level function components in single file — approaching PlatformAdmin god-file pattern |
| **Governance.tsx** | 60 | 0 | 0 | 0 | 0 | Shell/stub only — acceptable |
| **IngestBackfill.tsx** | 794 | 0 | 0 | 0 | 0 | Clean |

## 3. PlatformAdmin.tsx Internal Structure (10,037 lines)

Single-module monolith. **13 tab views**, **~30 embedded component functions**. Approximate section map:

| Range | Name / Description |
|---|---|
| 1–100 | Imports, interfaces for `DocsFeedbackArticle`, `DocsFeedbackComment`, `DocsFeedbackReply` |
| 101–369 | Utility fns: `groupDocsFeedbackReplyChains`, `DocsFeedbackAutoRetryBadge`, `formatCents`, `useCountdownTick` |
| 370–547 | Small badge components: `StatusBadge`, `RetrySkippedBadge`, `PlanBadge`, `VersionStatusBadge`, `OwnerOnboardingBadge` |
| 548–668 | `TenantDetailPanel` |
| 669–1085 | Template mgmt: `CreateVersionForm`, `TemplateVersionManager` |
| 1086–1351 | `ConnectorHealthPanel` |
| 1352–1872 | `PushDeliveryHealthPanel` + helpers |
| 1873–2140 | `LiveBillingHealthScreenshotCard` — custom `fixed inset-0 z-50` overlay |
| 2141–2462 | `BillingConfigHealthPanel` — Stripe price config checker |
| 2463–3053 | `VerifiedCallerAlertHistory`, `VerifiedCallerHealthPanel` |
| 3054–3394 | `ConnectorExpiringSoonTable`, `ConnectorAttentionTable`, `ConnectorAttentionRow` |
| 3395–3630 | `StuckOutboxEventsPanel`, `StuckOutboxEventRowView` |
| 3631–3916 | `CrmRevalidationMetricsPanel` + token status helpers |
| 3917–4509 | `ConnectorTokenHealthPanel`, `CallEventsRetentionPanel` |
| 4510–4723 | `IntegrationsStatusPanel` |
| 4724–5831 | Analytics: `RecommendationTrendSparkline`, `AnnualOnlyTenantsPanel`, `RecommendationBreakdownPanel`, `DiscountBreakdownPanel` |
| 5832–6320 | `export default function PlatformAdmin()` — root component, tab shell, all `useQuery` hooks |
| 6321–7313 | `DocsFeedbackTab` (~993 lines alone) |
| 7314–7610 | `SupportInboxTab` |
| 7611–8864 | `SuppressedBadge`, `BouncedRecipientsPanel`, `UnsubscribedAddressesPanel`, `TicketThread` |
| 8865–9028 | `PlanChangeDirectionsPanel` + bar-color constants |
| 9029–9184 | `CostMonitoringTab` |
| 9185–9424 | `SortableHeader`, `BarChart`, `TemplateAnalyticsTab` |
| 9425–9755 | `MetricItem`, `MilestoneIcon`, `OnboardingFunnelCards`, `ActivationMetricsTab` |
| 9756–10037 | `PlanRecommendationEmailsTab` + tail |

**Verdict:** This is 13 separate pages manually stitched via `useState<PlatformAdminTab>` switch. Each major tab is large enough to be its own page file.

## 4. Top 5 User-Visible Problems

**1. [HIGH] Hardcoded off-brand chart colors — two files, different palettes**
- `AdminAnalytics.tsx:244` — `fill="#a855f7"` (purple-500)
- `AdminTenantAnalytics.tsx:179–180` — `fill="#3b82f6"`, `fill="#8b5cf6"` (blue-500, violet-500)

Same metric shows purple in one view, blue/violet in another. No relationship to design system primary teal (#1F8E83 / #2DD4BF).

**2. [HIGH] PlatformAdmin.tsx — five `limit=200` unbounded fetches with no pagination**
- Lines 6333, 7326, 7663, 8086, 9778
- All inside same `<PlatformAdmin>` component tree, fire when tabs mount
- At 200 rows each, a single page load touching all tabs can materialize 1,000 rows into DOM. **Most plausible cause of overlay/scroll performance issues.**

**3. [HIGH] AdminSalesInbox.tsx — duplicate modal panelClassName + polling mismatch**
- `:1455` and `:1739` — identical 100-char `panelClassName` copy-pasted verbatim across two modals
- Main leads query polls every 30s (`:331`); settings queries poll every 5min (`:302`). Lead can sit stale 5min while list refreshes.

**4. [HIGH] AdminMarketplace.tsx — two modals with divergent overlay styles**
- `:229` — `bg-surface border border-border rounded-xl shadow-lg max-h-[80vh]`
- `:608` — same surface tokens but `shadow-lg max-w-lg` (no height cap)

VersionsModal has `max-h-[80vh] flex flex-col` for internal scrolling; ReviewModal has no height cap, no scroll containment. Long review pushes modal off-screen. **Matches "overlays with issues" symptom.**

**5. [MEDIUM] AdminTenantCampaign.tsx — split Lucide import**
- `:4` — `import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react'`
- `:8` — `import { Megaphone } from 'lucide-react'`

Copy-paste artifact. Bundler de-dupes so no runtime cost; signals no consistent authorship.

## 5. Patterns Repeated 3+ Times

1. **`limit=200` unbounded fetch** — 5 times across PlatformAdmin.tsx in 5 different tab functions. Extract `usePaginatedAdminList(endpoint, limit)` hook with virtual scroll.
2. **Table header row class string** `"text-left text-xs uppercase text-text-muted border-b border-border"` — 5 times in PlatformAdmin.tsx (lines ~5074, 5335, 5415, 5479, 5728). Extract `<AdminTableHead>`.
3. **Modal `panelClassName` for full-screen settings modals** — identical at AdminSalesInbox:1455, :1739; variant at AdminMarketplace:229. Extract `<AdminSettingsModal>` with `size` prop.
4. **`refetchInterval: 60_000`** — 8 times in PlatformAdmin.tsx across unrelated panels with no coordination. Backgrounded tab → all 8 timers fire. Extract `useAdminDashboardPolling` that pauses on `document.hidden`.
5. **Back-navigation breadcrumb block** — `ArrowLeft` + `useNavigate(-1)` near-identical at AdminTenantCalls.tsx:457, AdminTenantAnalytics.tsx:106, AdminTenantCampaign.tsx:114. PageHeader already accepts breadcrumbs — three files reinvent.

## 6. Recommended P0 Pages to Rebuild First

1. **PlatformAdmin.tsx — split into 13 route-level files.** Single highest-leverage action in the codebase. Each tab already has its own local state, query keys, types — they ARE functionally separate pages sharing a URL. Convert tab switch to actual child routes under `/admin`.
2. **AdminAnalytics.tsx + AdminTenantAnalytics.tsx — share a chart token system.** Extract `chartTokens.ts` with named entries mapped to CSS variables. Two-hour fix that prevents permanent palette fragmentation.
3. **AdminSalesInbox.tsx — extract modals and unify polling.** Two modals into `components/admin/`. Resolve 30s vs 5min polling mismatch.
4. **Billing.tsx — audit and consolidate `isAdmin` branches.** 10+ conditional renders gated on `isAdmin`. Split into `BillingAdmin.tsx` and `BillingTenant.tsx` sharing `useBillingData()` hook, or add single `if (!isAdmin) return <TenantBillingView />` at the top.
5. **PlatformCompliance.tsx — extract tab components.** 8 internal tabs at 1,732 lines, following the PlatformAdmin god-file pattern. Cheap to split now.

## Severity Summary

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 3 |
| MEDIUM | 2 |
| LOW | 2 |

**Verdict: WARNING** — 10K-line god-file is the root structural problem; every other HIGH issue is a symptom of authorship happening inside one file without code-review friction.
