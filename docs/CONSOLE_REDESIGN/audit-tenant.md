# Tenant Portal Audit — 30 pages

> Agent: `everything-claude-code:code-reviewer` · 2026-05-24
> Full original report; see [CONSOLE_REDESIGN_PLAN.md](../CONSOLE_REDESIGN_PLAN.md) for synthesis + tier ordering.

## 1. Grep Totals

| Pattern | Total Occurrences | Files Affected |
|---|---|---|
| Hardcoded hex colors (`#rrggbb`) | **0** | 0 — hex is confined to `STATUS_HEX` const in Dispatch.tsx:2062 |
| Rainbow Tailwind named colors | **1,589** | 23 of 30 files |
| Gradient (`from-*-NNN`) | **0** | 0 — no multi-stop gradient soup |
| Inline `style={{` | **36** | 11 files |
| z-index hotspots | **13 uses across 7 files** | Dispatch, SmsInbox, TrustedCallers, TicketDetail, Connectors, Calls, Tickets |
| Fixed/sticky positioning | **6 occurrences** | Connectors, Calls, TrustedCallers (detail panes), SmsInbox (sticky toolbar) |
| Lucide icon imports | Heavy on Calls (21), KnowledgeBase (15), Quality (10) | 9 files importing directly |
| Inline `<svg` blocks | **2** | TicketReporting.tsx, Dispatch.tsx |

The **1,589 rainbow color tokens** are the dominant design-system violation. The design system defines `--color-primary`, `--color-success`, `--color-danger`, `--color-warning` in `_theme.css`, yet pages use raw Tailwind palette colors instead.

## 2. Per-Page Red Flags

| Page | LOC | Rainbow | Inline styles | z-index | Lucide icons | Notable |
|---|---|---|---|---|---|---|
| **Dispatch.tsx** | 5,414 | **266** | 8 | 0 | 4 | 7 silent `catch {}` swallowing all API errors; `STATUS_HEX` const with 10 hardcoded hex values; 20+ top-level function definitions; single file should be 5 files |
| **Connectors.tsx** | 3,809 | **232** | 0 | 1 (`z-[90]`) | — | Two independent `fixed inset-0 z-[90]` overlays that can stack simultaneously (ConnectModal + OutageAlertDetailPanel) |
| **Marketplace.tsx** | 2,332 | 140 | 2 | 0 | — | — |
| **Autopilot.tsx** | 961 | **134** | 0 | 0 | — | 4 separate helper functions each returning hardcoded rainbow badge strings (lines 97–125) |
| **TicketDetail.tsx** | 877 | 100 | 0 | 2 | — | Defines its own `STATUS_CONFIG` (line 100) duplicating the one in Tickets.tsx (line 54) with different TypeScript shape |
| **Compliance.tsx** | 893 | 90 | 1 | 0 | — | — |
| **TicketAdmin.tsx** | 721 | 77 | 0 | 0 | — | Same active/inactive badge string copy-pasted verbatim 8 times (lines 288–500) |
| **SmsInbox.tsx** | 1,794 | 77 | 0 | 3 (`z-10`) | — | 3 CSS `:hover`-driven dropdowns (lines 802, 818, 834) are descendants of `overflow-hidden` at line 766 — **dropdowns are clipped** |
| **DeveloperPortal.tsx** | 601 | 67 | 0 | 0 | — | — |
| **Agents.tsx** | 957 | 62 | 0 | 0 | 9 | — |
| **UpdateCenter.tsx** | 293 | 54 | 0 | 0 | 8 | — |
| **KnowledgeBase.tsx** | 995 | 54 | 0 | 0 | **15** | — |
| **Calls.tsx** | 1,271 | (low) | 0 | 2 (`z-50`, `z-10`) | **21** | 21 Lucide icon imports; detail pane at `z-50` is below default Modal `z-[90]` |
| **Scheduling.tsx** | 1,757 | (low) | **10** | 0 | — | All 10 inline styles are `style={{ backgroundColor: appointmentTypeColor }}` + hex alpha string concatenation (line 519) — fragile |
| **Campaigns.tsx** | 2,013 | 4 | 6 | 1 | — | Progress bar widths via `style` acceptable; uses design-system tokens correctly elsewhere |
| **Billing.tsx** | 3,056 | **0** | 1 | 0 | — | Cleanest page in the set — correctly uses design-system tokens throughout |
| **Settings.tsx** | 2,248 | 4 | 0 | 0 | — | Near-clean |
| **TrustedCallers.tsx** | 1,763 | (low) | 0 | 2 | — | Detail pane at `z-50` can conflict with any `z-[90]` modal from same layout |

## 3. Top 5 User-Visible Problems

**Problem 1 — SmsInbox dropdowns clipped by overflow-hidden** [HIGH, production bug]

`/client-app/src/pages/SmsInbox.tsx` lines 798–834

Priority, Status, Assign dropdowns use CSS group-hover to show an `absolute` menu. Their nearest scroll ancestor is a `div` with `overflow-hidden` at line 766. Browser clips the dropdown. **Users who hover the toolbar buttons see nothing appear.** Fix: state-driven menu with `position: fixed` or a portal, or move parent to `overflow-visible`.

**Problem 2 — Two z-[90] overlays simultaneously openable in Connectors** [HIGH, overlay trap]

`/client-app/src/pages/Connectors.tsx` lines 1045 and 2924–2928

`ConnectModal` (rendered in main `Connectors` at line 3801) uses Modal default `fixed inset-0 z-[90]`. `OutageAlertDetailPanel` (rendered at 2741 inside `OutageAlertHistory` sub-component at 3778) also uses `containerClassName="fixed inset-0 z-[90]"`. Sibling React subtrees with no mutual exclusion. **Backdrop of each covers the other's content → unescapable overlay trap.**

**Problem 3 — Dispatch.tsx swallows 7 API errors silently** [HIGH, hidden failures]

`/client-app/src/pages/Dispatch.tsx` lines 497, 504, 511, 518, 525, 532, 539

Seven `useCallback` data-fetching functions (`fetchCounts`, `fetchResources`, `fetchTerritories`, `fetchSkillTypes`, `fetchNotifTemplates`, `fetchAssignmentRules`, `fetchReporting`) all have empty `catch {}`. **Supervisor sees empty territory list or missing route counts with no error indicator.** Highest-stakes page in the product.

**Problem 4 — STATUS_CONFIG defined twice with mismatched shapes** [MED, data drift]

`/client-app/src/pages/Tickets.tsx:54` defines `{ label, color, icon }`. `/client-app/src/pages/TicketDetail.tsx:100` defines `{ label, color, bgColor }` — different field names, no shared source. **Already diverged:** Tickets.tsx:60 has a `closed` status entry; TicketDetail.tsx:100 does not.

**Problem 5 — Scheduling.tsx hex alpha manipulation via string concatenation** [MED, fragile color]

`/client-app/src/pages/Scheduling.tsx` lines 519 and 551:
```tsx
style={{ backgroundColor: (b.appointment_type_color || DEFAULT_TYPE_COLOR) + '20' }}
```
Appends `'20'` to a hex color to fake 12% opacity. If color stored as `rgb()` or `hsl()`, produces broken `rgb(255, 100, 50)20` that browsers ignore. Use `color-mix()` or pass opacity separately.

## 4. Patterns Repeated 3+ Times

**A. Status badge rainbow string — 4 separate definitions**
- `/pages/Tickets.tsx:54` — STATUS_CONFIG with `color`
- `/pages/TicketDetail.tsx:100` — STATUS_CONFIG with `color` + `bgColor`
- `/pages/Dispatch.tsx:248` — KANBAN_COLUMNS with `bg`
- `/pages/Autopilot.tsx:97–125` — 4 inline helper functions

Extract to: `src/lib/statusBadge.ts` exporting `getStatusBadgeClass(domain, status)`.

**B. Active/Inactive pill — 8 identical copies in TicketAdmin.tsx**
Lines 288, 319, 348, 377, 408, 437, 468, 500 — all `bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300`. Extract to `<ActivePill active={boolean} />`.

**C. Detail pane slide-in pattern — 3 identical modal containers, 3 different z-indexes**
- `Calls.tsx:381` — z-50
- `TrustedCallers.tsx:1311` — z-50
- `Connectors.tsx:2928` — z-[90]

Extract to `<SlidePanel open onClose>` with single z-index token.

**D. CSS group-hover dropdown menus — 3 uses in SmsInbox.tsx (all clipped)**
Lines 802, 818, 834. Replace with shared `<DropdownMenu>` using state + portal.

## 5. Recommended P0 Pages to Rebuild First

1. **Dispatch.tsx (5,414 lines)** — largest by 40%. 7 silent API errors on highest-stakes page. 10 hardcoded hex. Maintenance emergency + user-trust failure.
2. **SmsInbox.tsx (1,794)** — three clipped dropdowns = **production bug today**, users can't change priority/status/assign.
3. **Connectors.tsx (3,809)** — dual z-[90] overlay trap requires page reload to escape.
4. **TicketDetail.tsx + Tickets.tsx (combined)** — STATUS_CONFIG already diverged; refactor together.
5. **Autopilot.tsx (961)** — highest rainbow-to-LOC ratio (0.14/line); trust-sensitive surface.

## Severity Summary

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 3 |
| MEDIUM | 7 |
| LOW | 14 |

**Verdict: WARNING** — 3 HIGH issues should be resolved before external customers. SmsInbox dropdown bug and Connectors overlay trap are user-visible failures in current production code.
