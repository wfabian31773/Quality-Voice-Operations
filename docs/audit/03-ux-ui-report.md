# 03 — UX / UI Report

Findings against modern 2025 SaaS conventions: clarity, accessibility, hierarchy, consistency across the three consoles, dark mode parity, mobile.

---

## Cross-cutting friction

### U-01 — Three consoles, three different palettes, one shared brand
- Tenant: Deep Harbor + Signal Teal (per `replit.md`).
- Admin: purple sidebar with `purple-600/30` accents.
- Ops: emerald sidebar with `emerald-600/30` accents.

The three consoles are visually loud and there is no shared "brand strip" that confirms the user is still inside QVO. New platform admins regularly miss that the purple console is the same product because the sidebar reads "Platform Admin" and the brand mark shrinks to a single character. Recommend a thin top brand bar on every console with the QVO wordmark + portal switcher always visible.

### U-02 — Dark mode parity gaps
- Tenant portal: solid (Tailwind `dark:` classes throughout).
- Admin and Ops layouts: hardcoded `bg-purple-900/20` and `bg-emerald-900/20` look broken in light mode (the sidebars are always dark).
- Public marketing site: many hardcoded white backgrounds; covered by tasks #218–#219.
- Demo page specifically: covered by #218.

Recommend a single design token sweep — replace `bg-white text-gray-900` with `bg-canvas text-canvas-foreground` semantic tokens, then theme via `:root[data-theme="light"]` and `:root[data-theme="dark"]`.

### U-03 — Empty states are inconsistent across mini-systems (also B-15)
- Tickets, Scheduling, SMS Inbox, Dispatch each have their own empty-state pattern. New tenants land on these pages with confusion.
- Recommend a shared `<EmptyState illustration title body cta />` component and one design (line-art SVG) per resource.

### U-04 — Long pages with no in-page nav (TOC) — Settings, Connectors, Marketplace detail, Compliance
- Each is 700–1600 LOC of stacked sections. Users scroll forever.
- Recommend a sticky right-hand TOC on pages > 4 sections.

### U-05 — No global breadcrumbs
- Detail pages (`/calls/:id`, `/tickets/:id`, `/admin/analytics/tenants/:tenantId`) have no breadcrumb. Operators cannot navigate back without browser back.
- Recommend a `<Breadcrumbs />` component derived from the route map.

### U-06 — Sidebar in TenantLayout is busy after the recent re-org
- Top nav: Dashboard, Agents, Conversations, Campaigns, Analytics.
- Two collapsible groups: Operations (SMS Inbox, Scheduling, Tickets, Dispatch) and Configure (Workflows, Integrations, Knowledge, Marketplace).
- One footer: Settings.
- Total clickable items when both groups expand: 12 + Settings + portal switch + theme + logout = 16.
- 16 clickable items in the sidebar is at the edge. Consider moving "Knowledge" into "Agents" (knowledge belongs to an agent) and merging "Workflows" with "Agents" once the visual builder ships everywhere.

### U-07 — Admin sidebar has 8 items with no grouping (Tenants, Analytics, Marketplace, Billing, Security, Evolution, Funnel, Intelligence)
- Existing PROPOSED task #208 covers admin sidebar trim/merge. Group suggestion for the new backlog: **Governance** (Security, Funnel) and **Intelligence** (Evolution, Intelligence) so the top level becomes Tenants, Analytics, Marketplace, Billing, Governance, Intelligence (6).

### U-08 — Ops sidebar has 6 items but two duplicate ("Reliability" and "Diagnostics" both surface error counters)
- Recommend merging "Diagnostics" into a tab inside "Reliability".

### U-09 — Visual hierarchy on data-dense tables (Calls, Tickets, Dispatch)
- All-caps headers, 13px body, no row banding, no sticky headers. After 30 rows, the user loses context.
- Recommend: row-banding `even:bg-gray-50 dark:even:bg-gray-800/40`, `sticky top-0` headers, and right-aligned numeric columns.

### U-10 — Loading skeletons are inconsistent — some pages show a spinner, some show animated shimmer, some show nothing
- Recommend a shared `<Skeleton />` family.

---

## Accessibility (a11y)

### A-01 — Sidebar buttons are not keyboard navigable in the right order
- The collapsible groups (Operations, Configure) trap focus when collapsed; pressing Tab moves into the collapsed children's invisible focus targets.
- Fix: `aria-expanded`, `aria-controls`, and `tabIndex={-1}` on the hidden children.

### A-02 — Icon-only buttons lack `aria-label`
- The notification bell, theme toggle, mobile-menu opener, and Help FAB all rely on a Lucide icon.
- Fix: `aria-label` on every icon-only `<button>`.

### A-03 — Color contrast on disabled buttons in light mode
- `text-gray-400 on bg-gray-100` is 2.2:1 — fails WCAG AA.
- Fix: bump to `text-gray-500`.

### A-04 — Modals trap focus inconsistently
- Some modals (NewAgent, NewTicket) properly trap; others (Confirm-delete) allow Tab to escape into the page.
- Fix: standardise on a single `<Modal>` primitive (e.g. Radix Dialog).

### A-05 — Visual builder (`AgentBuilder`) has no keyboard mode
- All node manipulation requires drag-and-drop with a mouse.
- Recommend: arrow-key node movement and a "command bar" to add nodes by name.

### A-06 — Form labels missing on several search inputs
- "Search calls", "Search tickets", "Search agents" use `placeholder` only with no `<label>` or `aria-label`.
- Fix: visually-hidden label.

### A-07 — Color-only conveyance
- Ticket priority, call sentiment, and connector sync status use color-only indicators (red dot / green dot).
- Recommend: add a text label or icon that does not depend on color.

### A-08 — `KeyboardShortcuts` modal is opened by `?` but has no closing keystroke other than `Esc` (good) — but pressing `?` again does not toggle.

---

## Per-page friction

### P-Dashboard
- "Today's calls" comparison divides by zero (D-01).
- Live calls SSE pane silently disconnects after the proxy idles; no reconnect indicator.
- "Recent calls" table shows only 5 rows with no "view all" link to `/calls`.

### P-Agents
- The "draft / published" pill is the same color as "active". Confusing.
- Bulk-publish is missing.

### P-Calls
- Saved-views UI works, but the "pin" icon's tooltip text reads "pin to top" without explaining the digest email side-effect.

### P-Campaigns
- Campaign type chooser ("type-metrics" tab) requires a refresh after changing tabs.

### P-Connectors
- OAuth callback fragment is not surfaced — when an OAuth fails, the user is redirected to a generic error page with no detail.
- "Test connection" button only exists for ticketing; should exist for all adapters.

### P-KnowledgeBase
- Document upload progress bar disappears mid-upload on slow connections.
- Article editor lacks autosave.

### P-Analytics
- All charts use the same teal — visually monotonous.
- No date-range presets ("last 7 days", "last 30 days") at the top.

### P-Marketplace
- No filter for "free vs paid", "industry", or "popularity".
- Detail page: "install" CTA doesn't differentiate between "install free" and "purchase + install".

### P-Settings
- Five sub-tabs but no left-hand nav within the page; users scroll up to switch.

### P-PhoneNumbers
- "Provision" copy implies one-click purchase — see B-22.

### P-Users
- Invite flow does not show pending invites in the same list as active users.
- No bulk-invite via CSV.

### P-Billing
- Plan-tier comparison is below the fold; first paint shows a lone "manage subscription" button.

### P-Quality
- Calls without a quality score show a long blank table.
- No CSV export.

### P-Compliance
- Page is 875 LOC; hard to find SOC 2 vs GDPR vs RBAC sections.

### P-Tickets / TicketDetail
- TicketDetail has 866 LOC of expanded panels with no collapse/expand. Mobile view is overwhelming.

### P-Dispatch
- "Job board" calendar drag-drop is mouse-only.
- "Create job" button is in two places (header + empty state) — mismatched widths.

### P-Scheduling
- Calendar week view does not show time-zone abbreviation.
- Day-view header overlaps appointment cards on narrow screens.

### P-SmsInbox
- Thread list does not virtualize; > 200 threads = sluggish scroll.
- "Reply" composer lacks template insertion.

### P-AgentBuilder
- Node search (B-33) is case-sensitive.
- The "publish" CTA does not show the diff vs the previous version.

### P-AdminAnalytics
- "Top tenants by MRR" includes trial tenants (D-18).
- No CSV export.

### P-PlatformAdmin
- Tenant detail does not surface their primary contact / signup attribution.

### P-Operations / CallDebug / IntegrationDiagnostics
- Three pages with overlapping data (alerts, errors, integration outbox). Need a unified "incidents" layer.

### P-Demo
- Dark mode broken (#218).
- The "speaking" indicator does not match the audio playback in some browsers.

### P-Public marketing
- Dark mode broken (#219).
- BookDemo form not wired (#206).

---

## Mobile

### M-01 — Sidebar collapses on `lg:` breakpoint (1024px). Between 1024 and 1280 px the sidebar consumes 25% of the viewport.
- Recommend a "compact" sidebar (icon-only) between 1024 and 1280.

### M-02 — Long tables overflow horizontally on mobile with no horizontal-scroll affordance.
- Add a fade-on-scroll edge.

### M-03 — `AgentBuilder` is unusable on mobile.
- Show a "this builder is desktop-only" overlay.
