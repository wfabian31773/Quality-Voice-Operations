# Console Redesign Plan

> Live tracker for the in-app console rebuild. Three guarded surfaces — Tenant Portal, Platform Admin, Operations — each currently has overlay bugs, hardcoded colors, gradient soup, and inconsistent token usage. This file is the single source of truth for the audit, the issues, the tier ordering, and the rebuild decisions. Update inline as work progresses.

**Started:** 2026-05-24
**Owner:** Wayne (product), Claude (implementation)
**Marketing surface status:** Landing + VerticalLanding rebuilt with shared `components/marketing/*`. Other 23 public pages pending bespoke hero generation. Marketing work paused while consoles get attention.

---

## 1. Scope

Three protected consoles, each with its own layout + guard:

| Console | Layout | Guard | Routes | Audience |
|---|---|---|---|---|
| **Tenant Portal** | `TenantLayout` | `ProtectedRoute` (+ `RoleGuard`) | ~30 | Partner-facing — the people who run the clinic / firm / shop |
| **Platform Admin** | `AdminLayout` | `ProtectedRoute` + `PlatformAdminGuard` | ~10 | QVO platform staff — managing tenants |
| **Operations** | `OpsLayout` | `ProtectedRoute` + `OpsGuard` | ~7 | QVO internal operators — watching calls, debugging, reliability |

Plus authless surfaces (Login, ForgotPassword, AcceptInvite, VerifyEmail, NotFound, Maintenance, ServerError) and layout-less protected pages (Onboarding, AgentBuilder).

---

## 2. Route → page inventory

### 2.1 Tenant Portal (`TenantLayout`)

| Route | Page file | Audit | Tier | Notes |
|---|---|---|---|---|
| /dashboard | Dashboard.tsx | ⏳ | — | The page every tenant lands on. P0. |
| /agents | Agents.tsx | ⏳ | — | |
| /workflows | Workflows.tsx | ⏳ | — | Manager+ gated |
| /calls | Calls.tsx | ⏳ | — | High-traffic. Operator's daily tool. P0. |
| /campaigns | Campaigns.tsx | ⏳ | — | |
| /connectors | Connectors.tsx | ⏳ | — | |
| /knowledge-base | KnowledgeBase.tsx | ⏳ | — | |
| /analytics | Analytics.tsx | ⏳ | — | |
| /marketplace, /marketplace/* | Marketplace.tsx, UpdateCenter.tsx, PostInstallSetup.tsx | ⏳ | — | Multi-route page |
| /settings, /settings/:tab | Settings.tsx | ⏳ | — | 6 tabs (general/notifications/roles/security/api-keys/privacy) |
| /phone-numbers | PhoneNumbers.tsx | ⏳ | — | |
| /trusted-callers | TrustedCallers.tsx | ⏳ | — | Operator+ gated |
| /users | Users.tsx | ⏳ | — | |
| /billing | Billing.tsx | ⏳ | — | High-stakes. P0. |
| /quality | Quality.tsx | ⏳ | — | |
| /audit-log | AuditLog.tsx | ⏳ | — | Manager+ gated |
| /compliance | Compliance.tsx | ⏳ | — | Manager+ gated |
| /widget | Widget.tsx | ⏳ | — | |
| /developer | DeveloperPortal.tsx | ⏳ | — | |
| /sms-inbox | SmsInbox.tsx | ⏳ | — | |
| /scheduling | Scheduling.tsx | ⏳ | — | |
| /tickets, /tickets/* | Tickets.tsx, TicketDetail.tsx, TicketReporting.tsx, TicketAdmin.tsx | ⏳ | — | 4-route family |
| /dispatch | Dispatch.tsx | ⏳ | — | |
| /autopilot | Autopilot.tsx | ⏳ | — | Manager+ gated |
| /changelog | Changelog.tsx | ⏳ | — | |

### 2.2 Platform Admin (`AdminLayout`)

| Route | Page file | Audit | Tier | Notes |
|---|---|---|---|---|
| /admin/dashboard | PlatformAdmin.tsx | ⏳ | — | Landing page for admins |
| /admin/analytics | AdminAnalytics.tsx | ⏳ | — | |
| /admin/analytics/tenants/:tenantId | AdminTenantAnalytics.tsx | ⏳ | — | Drilldown |
| /admin/analytics/tenants/:tenantId/calls | AdminTenantCalls.tsx | ⏳ | — | Drilldown |
| /admin/analytics/tenants/:tenantId/campaigns/:campaignId | AdminTenantCampaign.tsx | ⏳ | — | Deep drilldown |
| /admin/analytics/tenants/:tenantId/connectors | AdminTenantConnectors.tsx | ⏳ | — | Drilldown |
| /admin/marketplace | AdminMarketplace.tsx | ⏳ | — | |
| /admin/sales-inbox | AdminSalesInbox.tsx | ⏳ | — | |
| /admin/billing | Billing.tsx (shared) | ⏳ | — | Same component as tenant /billing |
| /admin/security | admin/PlatformCompliance.tsx | ⏳ | — | |
| /admin/governance | Governance.tsx | ⏳ | — | Tabs: evolution / funnel / intelligence |
| /admin/ingest-backfill | admin/IngestBackfill.tsx | ⏳ | — | |

### 2.3 Operations (`OpsLayout`)

| Route | Page file | Audit | Tier | Notes |
|---|---|---|---|---|
| /ops/monitor | Operations.tsx | ⏳ | — | Live call monitor |
| /ops/call-debug | CallDebug.tsx | ⏳ | — | Per-call diagnostic |
| /ops/integration-diagnostics | IntegrationDiagnostics.tsx | ⏳ | — | |
| /ops/cost | CostOptimization.tsx | ⏳ | — | |
| /ops/reliability | ToolHealth.tsx | ⏳ | — | |
| /ops/backfill-calls | admin/BackfillCalls.tsx | ⏳ | — | |
| /ops/digital-twin | DigitalTwin.tsx | ⏳ | — | |

### 2.4 Authless + special

| Route | Page file | Audit | Notes |
|---|---|---|---|
| /login | Login.tsx | ⏳ | First impression for returning users |
| /signin | SigninRedirect | n/a | Just normalizes to /login |
| /forgot-password | ForgotPassword.tsx | ⏳ | |
| /accept-invite | AcceptInvite.tsx | ⏳ | |
| /auth/verify-email | public/VerifyEmail.tsx | ⏳ | |
| /track/:token | public/BookingTracker.tsx | ⏳ | Public booking page |
| /onboarding | Onboarding.tsx | ⏳ | New-tenant first-run wizard |
| /agents/:id/builder | AgentBuilder.tsx | ⏳ | Full-screen builder, layout-less |

**Status legend:** ⏳ pending audit · 🔎 audit complete · 🛠️ rebuild in progress · ✅ done

---

## 3. Cross-cutting issues (FOUND by audit)

> Full reports: [audit-architecture.md](CONSOLE_REDESIGN/audit-architecture.md) · [audit-tenant.md](CONSOLE_REDESIGN/audit-tenant.md) · [audit-admin.md](CONSOLE_REDESIGN/audit-admin.md) · [audit-ops.md](CONSOLE_REDESIGN/audit-ops.md)

### 3.1 Overlay / z-index chaos — **the smoking gun for "errors with overlays"**

- **Triple FAB stacking on every tenant page.** `PlatformAssistant` (z-50, 56px), `HelpDrawer` (z-40, 48px), `HelpWidget` (z-40, 48px) all pinned to `bottom-6 right-6`. Visible right now on every authed tenant page. Fix at `TenantLayout.tsx:364–374`.
- **16+ components share z-50.** Mobile menu modals (all 3 layouts), HelpDrawer, PlatformAssistant, NotificationsCenter, PortalSwitcher, page-level drawers (Calls/TrustedCallers/AdminTenantCalls), hand-rolled dialogs in AgentBuilder + PlatformAdmin — all at z-50 with no deterministic stacking order.
- **z-90 collision** between Modal default (`Modal.tsx:130`) and Connectors drawer (`Connectors.tsx:2928`). DOM-order roulette.
- **z-100 collision** between CommandPalette (z-100) and DocBlocks Lightbox (z-100). Open ⌘K while lightbox open → unpredictable.
- **DigitalTwin dropdown at z-10** loses to every modal/FAB on the page (`DigitalTwin.tsx:676`).
- **Two openable z-[90] overlays in Connectors** trap the user — requires page reload to escape (`Connectors.tsx:1045`, `2924`).
- **Modal.tsx has no `createPortal`**. Zero hits across the codebase for `createPortal`. Every Modal renders in component subtree → stacking depends on consumer.
- **Modal cleanup is not stack-aware.** Two nested modals → inner one's cleanup restores focus to stale element (`Modal.tsx:62–72`).

### 3.2 Layout shell duplication

`TenantLayout`, `AdminLayout`, `OpsLayout` are ~450–500 lines of near-byte-identical code. Same `NavGroup` schema, same role-pill, same theme toggle button, same audit-log shortcut, same mobile-menu Modal wrapper, same `<aside>` + footer scaffold. `roleI18nKey` is verbatim duplicated 28 lines.

### 3.3 SSE / real-time data has no reconnect or stale disclosure

`Operations.tsx` (the live-ops nerve center) and `useCallSSE` have **no exponential backoff, no stale-data timeout, no "last updated at" timestamp, and `useCallSSE` has zero error handling.** Between server hiccup and reconnect, `activeCalls` holds the last snapshot as if it were live. The header badge flickers but the data lies.

### 3.4 Silent `catch {}` epidemic

- Dispatch.tsx swallows 7 API errors silently in 7 useCallback fetchers (the highest-stakes page in the product)
- ToolHealth.tsx silently swallows health-tab fetch errors → blank page with no banner or retry
- Operations.tsx: 5 silent catches
- DigitalTwin.tsx: 16 catch blocks

### 3.5 Token violations — two distinct shapes

- **Tenant Portal:** 1,589 rainbow Tailwind named-color hits across 23/30 files. Dispatch (266), Connectors (232), Marketplace (140), Autopilot (134). The design tokens in `_theme.css` exist; pages bypass them.
- **Platform Admin:** 21 hardcoded hex (mostly Recharts chart fills using `#a855f7` / `#3b82f6` / `#8b5cf6` — three different non-brand purples/blues across two analytics pages). 0 rainbow Tailwind classes (good!).
- **Operations:** 20 hardcoded hex all in CostOptimization.tsx Recharts layer; `#18181b` near-black tooltip invisible in light mode. 0 rainbow Tailwind (good!).
- **The pattern:** marketing-style violations (rainbow Tailwind classes) live in Tenant Portal; chart-library violations (raw hex in Recharts) live in Admin + Ops.

### 3.6 No portal root, no toast library

Zero `createPortal`. Zero `Toaster|sonner|react-hot-toast` in source. Any "toast" the app shows today is hand-rolled per page.

### 3.7 PlatformAdmin.tsx is a 10,037-line monolith

13 separate tab views, ~30 embedded component functions, 5 `limit=200` unbounded fetches inside tab panels that share one scroll surface, 8 unrelated `refetchInterval: 60_000` polls that all fire even when the tab is backgrounded. **Most likely cause of the admin-side overlay/scroll performance issues.**

### 3.8 Status-color taxonomy duplication

- **11 distinct status-color mapping functions** in Operations console alone
- **4 separate STATUS_CONFIG definitions** for tickets/dispatch (Tickets, TicketDetail, Dispatch, Autopilot)
- TicketDetail and Tickets have **already diverged** — `closed` status only in one
- 8 identical Active/Inactive pills copy-pasted in TicketAdmin.tsx

### 3.9 Theme / mobile gaps

- **No `prefers-color-scheme` on first paint.** New user always gets light mode regardless of OS. `marketing/PageHero` honors it but is decoupled from `useTheme` store.
- **OpsLayout missing LanguageSwitcher** (drift from TenantLayout + AdminLayout).
- **PlatformAssistant panel is `w-96` (384px)** — exceeds 360px viewports by 24px and right-clips.

---

## 4. Tier ordering (rebuild priority)

### P0 — STRUCTURAL FOUNDATION (do FIRST — unlocks everything else)

These are the architectural fixes that retire entire classes of bug. Building pages on top of the current foundation just bakes in more inconsistency.

1. **Z-index design token scale.** Define named layers in `tailwind.config` (`z-sticky-header: 10`, `z-popover: 20`, `z-dropdown: 30`, `z-drawer: 40`, `z-modal: 50`, `z-toast: 60`, `z-paywall: 70`, `z-palette: 80`, `z-tour: 90`, `z-celebration: 100`). Replace 25+ ad-hoc `z-50`/`z-[90]`/`z-[100]` literals. Lint-ban arbitrary `z-[...]`.
2. **Modal.tsx → `createPortal` + stack-aware focus restoration.** Render Modal children into `#overlay-root` mounted at `<body>`. Add a stack counter so only outermost Modal restores body scroll. Refactor the 4 hand-rolled dialogs in `AgentBuilder.tsx` + `PlatformAdmin.tsx` onto `<Modal>`.
3. **Kill the triple-FAB pile in TenantLayout.** Pick ONE help affordance (HelpWidget is newest). Drop PlatformAssistant + HelpDrawer from default mount, or stack them in a single anchored `<FloatingActionStack>` with a known order.
4. **Extract `<ConsoleShell>`** from TenantLayout/AdminLayout/OpsLayout. Single component takes `{ navGroups, headerSlot, badge, scopeBanner }`. Eliminates ~450 duplicated lines, every "shared chrome" bug becomes a one-line fix.
5. **Shared `<StatusBadge>` + `statusTone()` util.** Replaces 11+ inline status-color mappings across ops, 4 ticket STATUS_CONFIGs across tenant.
6. **`prefers-color-scheme` honored on first paint** in `lib/theme.ts:9`.

### P0 — USER-VISIBLE BUGS (do alongside foundation)

These are production-affecting bugs the audit caught.

1. **SmsInbox dropdowns clipped by `overflow-hidden`.** Users currently CANNOT change priority/status/assign from the toolbar (`SmsInbox.tsx:798–834`).
2. **Connectors dual-z-[90] overlay trap.** Two openable overlays cover each other — requires page reload to escape (`Connectors.tsx:1045`, `2924–2928`).
3. **Dispatch.tsx swallows 7 API errors silently** on the highest-stakes page (`Dispatch.tsx:497, 504, 511, 518, 525, 532, 539`).
4. **Operations.tsx SSE has no reconnect / stale disclosure.** Live-ops monitor lies during reconnect (`Operations.tsx:117–118`, `useCallSSE:129–205`).
5. **DigitalTwin z-10 dropdown clipped** by z-50 FAB / z-[90] modals (`DigitalTwin.tsx:676`).
6. **ToolHealth silent catch on health tab** + no auto-refresh except webhook tab (`ToolHealth.tsx:200–201`).

### P1 — HIGH-TRAFFIC PAGES (rebuild after foundation lands)

1. **Dashboard.tsx (675 lines)** — every tenant lands here.
2. **Calls.tsx (1,271)** — operator's daily tool; 21 lucide imports, z-50 detail pane below default Modal z-[90].
3. **Billing.tsx (3,056)** — dual-mounted admin/tenant with 10+ scattered `isAdmin` branches; split or add single top-level branch.
4. **PlatformAdmin.tsx (10,037)** — split the 13 tabs into actual child routes under `/admin`. Single highest-leverage refactor in the codebase.
5. **Settings.tsx (2,248)** — 6 tabs; near-clean already, but big.

### P1 — WORST OFFENDERS BY VIOLATION DENSITY

1. **Dispatch.tsx (5,414 lines, 266 rainbow hits)** — also hosts 7 silent catches.
2. **Connectors.tsx (3,809, 232 rainbow)** — also hosts the overlay trap.
3. **Autopilot.tsx (961, 134 rainbow)** — highest rainbow-to-LOC ratio (0.14/line).
4. **AdminAnalytics.tsx + AdminTenantAnalytics.tsx** — share a `chartTokens.ts` (named CSS-variable-backed chart colors).
5. **AdminSalesInbox.tsx (2,093)** — extract 2 settings modals, fix polling mismatch.
6. **PlatformCompliance.tsx (1,732)** — extract 8 internal tab components before this becomes another PlatformAdmin god-file.

### P2 — POLISH PASS (token cleanup on remaining pages)

Sweep through all remaining pages replacing rainbow Tailwind classes with semantic tokens. Best done as a single PR after the StatusBadge / shared chart token / ConsoleShell extractions land.

---

## 5. Shared components to extract

Ranked by impact × low-risk:

| # | Component | Replaces | Files affected |
|---|---|---|---|
| 1 | **Z-index scale (tailwind.config)** | 25+ ad-hoc literals | All files using z-N |
| 2 | **`<Modal>` portaling + stack-aware cleanup** | Subtree-rendered modals everywhere | `Modal.tsx`, 27 callers |
| 3 | **`<ConsoleShell>`** | TenantLayout / AdminLayout / OpsLayout shells | 3 layout files, ~450 LOC removed |
| 4 | **`<FloatingActionStack>`** | Triple FAB pile in TenantLayout | TenantLayout + 3 widgets |
| 5 | **`<StatusBadge>` + `statusTone()`** | 11 status-color helpers in ops + 4 ticket STATUS_CONFIGs in tenant | ~15 files |
| 6 | **`chartTokens.ts`** | Hardcoded hex chart fills | AdminAnalytics, AdminTenantAnalytics, CostOptimization |
| 7 | **`useReconnectingSSE` hook + `<LiveDataStaleness>` indicator** | Inline EventSource handling | Operations, CallDebug |
| 8 | **`<SlidePanel>`** | 3 right-side drawer patterns at different z-indexes | Calls, TrustedCallers, Connectors, AdminTenantCalls |
| 9 | **`<DropdownMenu>`** | 3 CSS hover dropdowns in SmsInbox + others | SmsInbox, Campaigns |
| 10 | **`useAdminDashboardPolling()`** | 8 uncoordinated 60s polls in PlatformAdmin | PlatformAdmin tabs |
| 11 | **`<AdminTableHead>`** | 5 identical table-header class strings in PlatformAdmin | PlatformAdmin |
| 12 | **`roleI18nKey` → `lib/roleLabel.ts`** | Duplicated 28 lines in AdminLayout + OpsLayout | 2 files |
| 13 | **`<AccessDenied>`** | RoleGuard and OpsGuard each define their own | 2 guard files |
| 14 | **Toast library (sonner)** | Hand-rolled per-page notification UIs | New foundation |

---

## 6. Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-24 | Pause marketing rebuild after Landing + VerticalLanding to attack consoles | User flagged console issues as more urgent |
| 2026-05-24 | **Initial audit attempt with `Explore` subagent was wrong tool** | Explore reads excerpts, misses content past read window. Two of four agents hedged / one hallucinated. Re-fired with `code-reviewer` + `architect` agents that have Read + Grep + Glob + Bash |
| 2026-05-24 | Audit via parallel subagents (3 code-reviewer + 1 architect) | Console surface is 60+ files / ~50K LOC; serial reading would take hours. Each agent gets disjoint files. |
| 2026-05-24 | **P0 starts with STRUCTURAL FOUNDATION, not pages** | Z-index scale + Modal portaling + ConsoleShell are the leverage points. Rebuilding pages on the current foundation just bakes in more inconsistency. |

---

## 7. Open questions

- [x] **What are the "overlay" issues?** Answered: triple FAB pile in TenantLayout (visible on every page), 16+ components sharing z-50 with no deterministic ordering, Modal not using portal, DigitalTwin z-10 dropdown clipped by FAB, dual z-[90] trap in Connectors.
- [ ] **Do we apply the dual-mode visual identity to consoles?** Operators likely want dark by default (long shifts). Clinic staff (tenant portal) likely want light by default (matches the V1 clinical aesthetic). Recommend: respect `prefers-color-scheme` on first paint + persist user preference per surface (tenant/admin/ops could have separate defaults).
- [ ] **Settings tab structure** — 6 tabs (general/notifications/roles/security/api-keys/privacy). Audit found Settings.tsx near-clean. Defer this decision until P0 lands; if any tab is single-screen-worth, collapse.
- [ ] **Marketplace multi-route** — 5 routes (`/marketplace`, `/marketplace/installed`, `/marketplace/purchases`, `/marketplace/:id`, `/marketplace/updates`) all hit `Marketplace.tsx` (2,332 lines). Likely should be 4 separate pages sharing a `useMarketplace()` hook. Decide during P1.
- [ ] **Should PlatformAdmin tabs become routes?** Audit recommends YES — 13 tabs are functionally separate pages sharing a URL. Confirm before doing the split.
- [ ] **Toast strategy** — pick a library (sonner is current best-of-breed, ~3KB, headless, dark-mode aware). Or hand-roll one on top of the new portal root.

---

## 8. Audit reports (full text)

The four full audit reports live in [`docs/CONSOLE_REDESIGN/`](CONSOLE_REDESIGN/):

- [audit-tenant.md](CONSOLE_REDESIGN/audit-tenant.md) — 30 pages, 1,589 rainbow hits, 3 HIGH bugs
- [audit-admin.md](CONSOLE_REDESIGN/audit-admin.md) — 12 pages, 20,708 LOC, 3 HIGH bugs (PlatformAdmin god-file is the structural root)
- [audit-ops.md](CONSOLE_REDESIGN/audit-ops.md) — 7 pages, 11 status palettes, 3 HIGH bugs (SSE silence + z-10 overlay confirmed)
- [audit-architecture.md](CONSOLE_REDESIGN/audit-architecture.md) — z-index inventory, layout shell duplication, the 3 most urgent cross-cutting fixes

---

## 9. Foundation status — ALL 4 P0 FIXES SHIPPED (2026-05-24)

| # | Fix | Commit | Result |
|---|---|---|---|
| P0/1 | Named z-index scale | `7718207` | 10 layers in `_theme.css`; safelist in tw-app/public/shell.css; 49 literals across 25 files migrated. Fixes DigitalTwin clip, Connectors drawer above modal, PublicLayout nav z-50 collision, WebsiteSalesWidget z-999999 outlier. |
| P0/2 | Modal portal + stack-aware | `16c9fbc` | `Modal.tsx` now portals into `#overlay-root`; body-scroll lock ref-counted; focus restore stale-element-aware. 4 hand-rolled dialogs folded onto `<Modal>` (PlatformAdmin screenshot preview, AgentBuilder shortcuts/commandbar/save-template). |
| P0/3 | Triple-FAB pile | `71548d7` | TenantLayout FABs stack vertically: PlatformAssistant `bottom-6`, HelpWidget `bottom-24`, HelpDrawer `bottom-44`. No functionality removed. |
| P0/4 | `ConsoleShell` extraction | `aa4d706` | New `components/console/ConsoleShell.tsx` + `lib/roleLabel.ts`. AdminLayout 287→121; OpsLayout 231→58. Fixes the LanguageSwitcher drift the audit caught (Ops now gets it by default). |

**TenantLayout intentionally not refactored onto ConsoleShell** — Tenant has a different chrome (search header instead of role pill, sidebar theme toggle, multiple floating widgets, provisioning/onboarding routing) that doesn't fit ConsoleShell's API without ballooning the prop list. Tenant cleanup is a separate scoped follow-up.

## 10. What's next

### Immediate options after user review

**P0 USER-VISIBLE BUGS** (6 remaining, each 1–2h):
- SmsInbox dropdowns clipped by `overflow-hidden` (production bug — users can't change priority/status/assign from toolbar)
- Connectors dual-z overlay trap (mitigated by P0/1 but two modals still openable)
- Dispatch silent `catch {}` × 7 on highest-stakes page
- Operations SSE no reconnect / no stale disclosure (live-ops monitor lies during server hiccups)
- DigitalTwin model selector clip — **already fixed by P0/1**
- ToolHealth silent fetch error swallows on health tab

**P1 PAGE REBUILDS** (largest impact first):
- Split `PlatformAdmin.tsx` 10K-line god file into 13 route-level files
- Rebuild `Dashboard.tsx` (every tenant lands here)
- Rebuild `Billing.tsx` (split admin/tenant `isAdmin` branches or share `useBillingData()` hook)
- Rebuild `Calls.tsx` (operator's daily tool, 21 lucide imports)
- Rebuild `Settings.tsx` 6 tabs (near-clean already, but big)

**P1 RAINBOW CLEANUP** (worst offenders):
- `Dispatch.tsx` (5,414 lines, 266 rainbow Tailwind hits)
- `Connectors.tsx` (3,809 lines, 232 rainbow)
- `Autopilot.tsx` (961 lines, 134 rainbow — highest per-LOC density)

**MARKETING SURFACE** (23 pages remaining, paused for Higgsfield bespoke heroes — user is generating manually via Higgsfield web app)
