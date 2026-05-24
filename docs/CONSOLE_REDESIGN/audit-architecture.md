# Architecture Audit — Shared Layouts & Cross-Cutting Concerns

> Agent: `everything-claude-code:architect` · 2026-05-24
> Full original report; see [CONSOLE_REDESIGN_PLAN.md](../CONSOLE_REDESIGN_PLAN.md) for synthesis + tier ordering.

## 1. Layout shell duplication

All three authenticated layouts (`TenantLayout.tsx`, `AdminLayout.tsx`, `OpsLayout.tsx`) are near-clones of the same skeleton:

| Shared section | TenantLayout | AdminLayout | OpsLayout |
|---|---|---|---|
| Mobile menu media-query auto-close | 73–79 | 121–127 | 76–82 |
| `roleI18nKey` function | (n/a) | 73–83 | 56–66 |
| `handleLogout` | 190–193 | 129–132 | 84–87 |
| Sidebar shell (header, nav, footer) | 195–298 | 139–193 | 94–146 |
| `<aside>` + `<Modal>` mobile wrapper | 302–316 | 197–211 | 151–165 |
| Header bar (menu btn + branding + actions) | 319–350 | 214–263 | 168–216 |
| `<main>` + footer | 356–362 | 278–282 | 222–226 |

`AdminLayout` and `OpsLayout` are nearly byte-identical: same `NavGroup` schema, same role-pill, same theme toggle button, same audit-log shortcut, same `GlobalScopeBanner`. Only meaningful diff is the nav list and accent color (`bg-accent/30` vs `bg-success/30`). The `roleI18nKey` function is duplicated verbatim (28 lines).

**Estimated duplication: ~450–500 lines** that could collapse into a `<ConsoleShell>` primitive.

## 2. Full z-index inventory

| z | File:line | Component | Role |
|---|---|---|---|
| 999999 | `WebsiteSalesWidget.tsx:345,629` | WebsiteSalesWidget panel & FAB | Marketing chat (public) |
| 120 | `Celebration.tsx:79` | Celebration | Confetti overlay |
| 110 | `ProductTour.tsx:124` | ProductTour | Tour scrim/coachmarks |
| 100 | `CommandPalette.tsx:111` | CommandPalette | ⌘K palette |
| 100 | `DocBlocks.tsx:577` | Lightbox | Image zoom |
| **90** | `Modal.tsx:130` (default) | Modal | Generic dialog default |
| **90** | `Connectors.tsx:2928` | Connector drawer | Connector edit drawer |
| 60 | `TrialBanner.tsx:54` | Trial paywall modal | Hard paywall |
| 60 | `CookieConsent.tsx:80` | Cookie banner | Bottom-left |
| **50** | `TenantLayout:310` mobile menu | Sidebar drawer | |
| **50** | `AdminLayout:205` mobile menu | Sidebar drawer | |
| **50** | `OpsLayout:159` mobile menu | Sidebar drawer | |
| **50** | `PublicLayout:145,200` | Sticky header + dropdowns | |
| **50** | `HelpDrawer:82` | Help drawer (sheet) | |
| **50** | `PlatformAssistant:126,134` | Floating bot FAB + panel | |
| **50** | `Calls.tsx:381`, `AdminTenantCalls:176`, `TrustedCallers:1311` | Side drawers | |
| **50** | `AgentBuilder.tsx:1478,1667,3714` | Modal/sheet/dialog (hand-rolled) | |
| **50** | `PlatformAdmin.tsx:2077` | Hand-rolled dialog | |
| **50** | `NotificationsCenter.tsx:153` | Notifications dropdown | |
| **50** | `PortalSwitcher.tsx:99` | Portal switcher popover | |
| 50 | `TooltipWalkthrough.tsx:102` | Walkthrough tooltip | |
| 40 | `HelpDrawer.tsx:73` | Help FAB | |
| 40 | `HelpWidget.tsx:143,151` | Help FAB + panel | |
| 40 | `TenantScopePicker.tsx:125` | Scope picker popover | |
| 30 | `DocBlocks.tsx:589,602,613,617` | Lightbox controls | |
| 30 | `AgentBuilder.tsx:3083,3122`, `TemplateHoverPreview.tsx:35`, `public/Docs.tsx:66` | Hover previews / dropdowns | |
| 20 | `Tickets.tsx:422`, `TicketDetail.tsx:485,732`, `internal/PrimitivesShowcase:71`, `AgentBuilder.tsx:2938` | Local dropdowns / sticky | |
| 10 | (many) | Sticky headers, hover-cards, sticky table headers | |
| -10 | `marketing/BottomCTA:43,45`, `marketing/PageHero:88,108,115,122` | Hero backdrop layers | |

**Collisions worth flagging:**
- **z-50 is the universal "fixed thing" bucket.** 16+ different UI elements share it. Stacking is purely DOM-order luck.
- **z-90 collision:** Modal's default is z-90, but `Connectors.tsx:2928` overrides container to z-90 explicitly. Both share z-90 → DOM-order roulette.
- **z-100 collision:** CommandPalette and DocBlocks Lightbox both sit at z-100. Open ⌘K while a lightbox is open → unpredictable.
- **z-999999 (WebsiteSalesWidget):** runs only on public surfaces, but if it ever leaks into an authed route it eats every dialog.

## 3. Modal / Drawer / Sheet stacking strategy

**There is ONE shared Modal** at `client-app/src/components/Modal.tsx` — used by 27 files. Good primitive (focus trap, Escape close, body-scroll lock, backdrop click). **But it does not use `createPortal`** (grep for `createPortal` returns zero hits across the codebase). It renders in the component subtree where it's invoked, so stacking depends entirely on the consumer's `containerClassName` z-index.

**Three coexisting patterns:**
1. **Shared `<Modal>` primitive** — used by `HelpDrawer`, `CommandPalette`, `TrialBanner`, `DocBlocks` lightbox, the three layout mobile menus, plus `Calls`, `TrustedCallers`, `AdminTenantCalls`, `Connectors`. Container z varies 50 / 60 / 90 / 100.
2. **Hand-rolled dialogs** with `fixed inset-0 z-50` and inline `role="dialog"` — `AgentBuilder.tsx:1478`, `1667`, `3714`; `PlatformAdmin.tsx:2077`. These do not get the Modal focus-trap, scroll-lock, or Escape handling.
3. **Non-modal floating panels** — `PlatformAssistant` (z-50), `HelpWidget` (z-40), `NotificationsCenter` (z-50), `WebsiteSalesWidget` (z-999999), `Celebration` (z-120), `ProductTour` (z-110). None share a portal.

There is **no portal root**, no `<DialogProvider>`, no toast library mounted (grep for `Toaster|sonner|react-hot-toast` returns no matches in source).

## 4. Specific overlay bugs from static reading

1. **Triple FAB stacking in TenantLayout (bottom-right collision).** TenantLayout mounts `PlatformAssistant` (z-50, `bottom-6 right-6`, 56px), `HelpDrawer` (z-40, `bottom-6 right-6`, 48px), and `HelpWidget` (z-40, `bottom-5 right-5`, 48px) — all three pinned to the same corner. Files: `TenantLayout.tsx:364–374`, `PlatformAssistant.tsx:126`, `HelpDrawer.tsx:73`, `HelpWidget.tsx:143`. **On every tenant page the user sees overlapping FABs.** Reproduction: load `/dashboard`, look at bottom-right.

2. **Mobile sidebar Modal vs PlatformAssistant FAB.** All three layouts open the mobile menu via `<Modal>` at z-50, but `PlatformAssistant`'s open panel is also z-50. Tap the sparkle FAB while menu is open → both panels at z-50, DOM-order decides which is clickable.

3. **CommandPalette over Modal contents.** Press ⌘K (z-100) while any page-level drawer (`Calls.tsx:381`, z-50) or Connectors drawer (z-90) is open. Modal cleanup in `Modal.tsx:62–72` is not stack-aware → stale focus restoration.

4. **TrialBanner paywall is z-60, PlatformAssistant FAB is z-50.** When paywall is up, FAB sits behind it (correct), but `Celebration` (z-120) and `ProductTour` (z-110) would render over the paywall — a tour auto-launch on dashboard load can fire on top of a trial paywall.

5. **Sticky drawer headers share z-10 with table sticky headers.** `Calls.tsx:384`, `AdminTenantCalls.tsx:179`, `TrustedCallers.tsx:1314` use sticky `top-0 z-10` inside drawers, but `ui/AdminTable.tsx:33` also uses sticky `thead z-10`. Two sticky bars will collide.

6. **Hover-card escape on SmsInbox / Campaigns.** `SmsInbox.tsx:802/818/834` and `Campaigns.tsx:407` use `hidden group-hover:block` at z-10. Will be covered by any sticky page header.

7. **Three hand-rolled dialogs in `AgentBuilder.tsx`** (lines 1478, 1667, 3714) each at z-50 with no focus trap.

## 5. Theme/dark-mode consistency

Theme store (`client-app/src/lib/theme.ts`) is centralized: toggles `document.documentElement.classList.toggle('dark', next)` and persists to localStorage.

**Drift points:**
- **OpsLayout has no `LanguageSwitcher`** in the sidebar footer (`OpsLayout.tsx:136–146`), whereas `TenantLayout` (281) and `AdminLayout` (183) do.
- **No `prefers-color-scheme` honored on first paint** — `theme.ts:9` only reads localStorage. New user gets light mode regardless of OS. `marketing/PageHero.tsx:88` uses `prefers-color-scheme: dark` to swap images, but that's decoupled from `useTheme`. Result: a user on dark OS sees light shell with dark hero images.
- **400+ `dark:` utility usages** across 30+ files — Tailwind dark variant works consistently in all three layouts.

## 6. Mobile responsive gaps

- **OpsLayout / AdminLayout missing `lg:hidden` close button** for already-open menu.
- **TrialBanner inside scroll container** — on mobile when banner is large and header is sticky, banner doesn't stick and scrolls away.
- **PlatformAssistant panel `w-96` (384px)** at `bottom-6 right-6`, no responsive shrink. On 360px viewport the panel exceeds the screen width by 24px and right-clips.

## 7. Recommended shared-component extractions

1. **`<ConsoleShell>`** for the three authed layouts. Risk low. Payoff ~450 lines removed.
2. **Z-index design token file** — named scale (`z-sticky-header: 10`, `z-popover: 20`, ..., `z-modal: 50`, `z-toast: 60`, `z-paywall: 70`, `z-palette: 80`, `z-tour: 90`, `z-celebration: 100`).
3. **`<Portal>` root + `<Modal>` portaling.** Render Modal children into `#overlay-root`. Stack counter so only outermost Modal restores body scroll. Fixes bug #3 above.
4. **`<FloatingActionStack>`** to collapse the three FABs. Fixes bug #1 immediately.
5. **`roleI18nKey()` to `lib/roleLabel.ts`** — currently duplicated AdminLayout:73 + OpsLayout:56.
6. **`AccessDenied`** — currently RoleGuard + OpsGuard each define their own.

## 8. The 3 most urgent cross-cutting fixes

1. **Resolve the three-FAB pile in TenantLayout.** Files: `TenantLayout.tsx:364–374`, `PlatformAssistant.tsx:126`, `HelpDrawer.tsx:73`, `HelpWidget.tsx:143`. Pick ONE help affordance, drop duplicates, or stack in single anchored container. Most visible "errors with overlays" symptom — user sees it on every page.

2. **Introduce portal + z-index scale.** Files: `Modal.tsx` (add `createPortal`), new `tailwind.config.{ts,js}` z-index scale. Refactor hand-rolled dialogs in `AgentBuilder.tsx`, `PlatformAdmin.tsx` onto `<Modal>`. Replace every `z-50`/`z-[90]`/`z-[100]` literal. Retires an entire class of bug.

3. **Extract `<ConsoleShell>` from the three layouts.** Files: `TenantLayout.tsx:195–362`, `AdminLayout.tsx:139–282`, `OpsLayout.tsx:94–226` → new `components/console/ConsoleShell.tsx`. Single component that takes `{ navGroups, headerSlot, badge, scopeBanner }` as props. Every "shared chrome" bug becomes a one-line fix.
