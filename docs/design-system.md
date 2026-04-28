# QVO Design System — Refined Harbor

**Version:** 1.0.0 — locked 2026-04-27
**Source of truth:** `client-app/src/index.css` (`@theme` block) + `client-app/src/lib/designTokens.ts` (typed mirror)
**Direction picked from:** `/internal/design-directions` (3-variant comparison)

> Refined Harbor is the QVO visual language: a deepening of the existing Deep Harbor + Signal Teal brand into a layered, premium feel — soft glass surfaces over a deep navy chrome, generous radii, warm-neutral support tones. It reads as enterprise without feeling sterile, and stays calm where it counts (data tables, long forms).

---

## 1. Use this document as a checklist

When polishing any page, button, modal, or chart, every item below MUST hold. If something can't, file a follow-up — don't deviate locally.

```
[ ] All colors come from `--color-*` CSS vars (no hex literals in JSX)
[ ] All radii come from `--radius-*` (sm 6, md 10, lg 14, xl 20, pill)
[ ] All shadows come from `--elevation-*` (e1 / e2 / e3 / glow)
[ ] All spacing on the 4px grid (`--spacing-*`)
[ ] Display + headline use `--font-display` (Sora); body uses `--font-body` (Inter)
[ ] Numerals in tables / metrics use `font-variant-numeric: tabular-nums`
[ ] Every interactive element has a visible `:focus-visible` ring (auto via global rule)
[ ] Body text contrast ≥ 4.5:1 against its surface; large text ≥ 3.0:1
[ ] No color-only meaning — pair every status color with text or icon
[ ] Touch targets ≥ 44×44 px on mobile
[ ] Animations respect `@media (prefers-reduced-motion: reduce)`
[ ] Dark-mode pair verified (toggle theme — nothing should look "broken")
```

---

## 2. Tokens at a glance

### Brand
| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-primary` | `#1F8E83` | `#3DB3A6` | Primary CTA, links, focus ring, active sidebar item, primary chart series |
| `--color-primary-hover` | `#177268` | `#4FC9BB` | Hover state of primary |
| `--color-primary-light` | `#D8EDEB` | `#143A52` | Selected backgrounds, subtle primary tints |
| `--color-on-primary` | `#FFFFFF` | `#0E2738` | Text/icon on top of `--color-primary` |
| `--color-accent` | `#E2A24A` | `#EDB872` | Highlights, "new" badges, secondary marketing accents — sparingly |
| `--color-on-accent` | `#0E2738` | `#0E2738` | Text/icon on top of accent |

### Semantic feedback
| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-success` | `#2F8F58` | `#4FB97A` | Confirmation, healthy status, "live" pill |
| `--color-warning` | `#C98A2E` | `#E0A654` | Caution, throttling, expiring |
| `--color-danger` | `#B34D4D` | `#D17070` | Errors, destructive actions, urgent priority |
| `--color-info` | `#3A7BBF` | `#6FA5DD` | Informational tags (Assigned, Scheduled), neutral charts |

> Each `*` color also has a paired `*-light` token for tinted backgrounds (badges, banners, highlight rows).

### Surfaces & text
| Token | Light | Dark |
|---|---|---|
| `--color-surface` | `#FFFFFF` | `#11293A` |
| `--color-surface-secondary` (page bg) | `#F4F7F8` | `#0A1C28` |
| `--color-surface-hover` | `#EEF3F4` | `#143A52` |
| `--color-surface-inverse` (dark chrome) | `#0E2738` | `#E8EFF2` |
| `--color-on-inverse` | `#E8EFF2` | `#0E2738` |
| `--color-border` | `#D9E2E6` | `#1E3A4D` |
| `--color-border-strong` | `#B8C5CC` | `#2C5168` |
| `--color-text-primary` | `#0E2738` | `#E8EFF2` |
| `--color-text-secondary` | `#506575` | `#8FA5B4` |
| `--color-text-muted` | `#8FA5B4` | `#607585` |

### Chrome (sidebars / consoles)
Tenant, Admin, and Ops consoles all use the same dark sidebar — the visual difference between them comes from the page heading + breadcrumb, not the chrome color. (See audit U-01.)

| Token | Light | Dark |
|---|---|---|
| `--color-sidebar-bg` | `#0E2738` | `#07151E` |
| `--color-sidebar-text` | `#C5D2DA` | `#8FA5B4` |
| `--color-sidebar-active` | `#1F8E83` | `#3DB3A6` |
| `--color-sidebar-hover` | `#143A52` | `#11293A` |

### Type scale
| Role | Family | Size · LH · LS · Weight |
|---|---|---|
| Display | Sora | 44 · 1.05 · -0.02em · 700 |
| Headline | Sora | 32 · 1.15 · -0.015em · 600 |
| Title | Sora | 20 · 1.30 · -0.01em · 600 |
| Body | Inter | 15 · 1.55 · 0 · 400 |
| Body sm | Inter | 13 · 1.50 · 0 · 400 |
| Label | Inter | 12 · 1.30 · 0.04em · 600 uppercase |
| Mono / numerals | JetBrains Mono | 13 · 1.40 · 0 · 400 tabular-nums |

> Never use Sora below 16px — it's a display face. Use Inter for everything that scrolls.

### Radius, spacing, elevation, motion
| Group | Tokens |
|---|---|
| Radius | `--radius-sm` 6 · `--radius-md` 10 · `--radius-lg` 14 · `--radius-xl` 20 · `--radius-pill` 9999 |
| Spacing (4px grid) | `--spacing-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 24 · `-6` 32 · `-7` 48 · `-8` 64 |
| Elevation | `--elevation-1` (subtle border lift), `-2` (cards/popovers), `-3` (modals/dropdowns), `--elevation-glow` (focus halo) |
| Motion | `--motion-fast` 120ms (hover) · `--motion-base` 200ms (transitions) · `--motion-slow` 320ms (modals/sheets) |
| Easing | `--easing-standard` for everything · `--easing-emphasized` for hero/marketing |

### Charts
Use `chartPalette` from `designTokens.ts` in series order. Six steps before looping; primary series always uses `palette.primary` (teal).

---

## 3. Component patterns (what "Refined Harbor" looks like in practice)

### Buttons
- **Primary** — solid `--color-primary` fill, `--color-on-primary` text, `--radius-md`, `--elevation-1` (or `--elevation-glow` on focus). On dark navy backgrounds, add a soft outer glow `box-shadow: 0 4px 16px rgba(31,142,131,.25)`.
- **Secondary** — transparent fill, `1px solid --color-border`, `--color-text-primary` text. Hover bumps to `--color-surface-hover` background.
- **Ghost / tertiary** — text-only, `--color-primary` color, no background until hover (`--color-primary-light`).
- **Destructive** — `--color-danger` fill, white text. Always paired with a confirmation dialog.

### Cards & surfaces
- Default card: `--color-surface`, `1px solid --color-border`, `--radius-lg`, `--elevation-1`.
- Bento card (marketing/dashboard hero tile): same as default, plus `--elevation-2` and a subtle `linear-gradient` tint from `--color-primary-light` to `--color-surface` for accent tiles.
- Glass chrome (marketing nav, top bar over imagery): `rgba(255,255,255,.06)` background + `backdrop-filter: blur(12px)` + `1px solid rgba(255,255,255,.10)`. **Never** use glass for long lists — performance cost is real; restrict to chrome only.

### Sidebars
Always `--color-sidebar-bg`, with the active item using `--color-sidebar-active` background + `--color-on-primary` text. Hover bumps to `--color-sidebar-hover`. Group headings are `text-xs uppercase tracking-wider` in `--color-sidebar-text` at 60% opacity.

### Data tables (Calls / Tickets / Dispatch)
- Tabular numerals via `font-variant-numeric: tabular-nums`.
- Row banding: `even:bg-surface-hover`.
- Sticky `<thead>` with `--color-surface` background and bottom border `--color-border`.
- Right-align numeric columns; left-align everything else.
- Status pills use `*-light` background + matching dark color text; **always** include a text label, never color alone.

### Forms
- Input height ≥ 40px (touch target with padding hits 44px).
- Border `--color-border`, focus ring auto-applied by global rule.
- Helper text in `--color-text-secondary`; errors in `--color-danger` with an icon prefix.

### Empty states (audit U-03 — shared component target)
Single line-art SVG, `--font-display` headline at title size, `--color-text-secondary` body, primary CTA button. See `<EmptyState />` once it lands (downstream task).

### Modals / sheets
- Backdrop: `rgba(14, 39, 56, 0.40)` + `backdrop-filter: blur(4px)`.
- Surface: `--color-surface`, `--radius-xl`, `--elevation-3`.
- Animation: `--motion-slow` with `--easing-emphasized`.
- Close affordance is always top-right; ESC closes; focus trapped (audit A-04).

---

## 4. Accessibility floor (non-negotiable)

| Rule | How |
|---|---|
| Body contrast ≥ 4.5:1 | Verified for every `--color-text-*` × `--color-surface*` pair |
| Large text ≥ 3.0:1 | Display/headline on light surfaces verified |
| Focus visible | Global `:focus-visible` outline using `--focus-ring-color` (auto) |
| Touch target ≥ 44×44 | `--touch-target-min` token; pad small icons to hit it |
| No color-only meaning | Pair every status with a label or icon (audit A-07) |
| Reduced motion | Wrap any animation in `@media (prefers-reduced-motion: reduce)` |
| Form labels | Visually-hidden labels on every search/input (audit A-06) |
| Icon-only buttons | `aria-label` required (audit A-02) |

---

## 5. Migration rules for downstream polish tasks

When sweeping the in-app or marketing surfaces:

1. **Replace hardcoded hex with tokens.** `bg-white` → `bg-surface`, `text-gray-900` → `text-text-primary`, `bg-purple-900/20` → `bg-sidebar-hover`, etc. (See audit U-02.)
2. **Replace shadow utilities with elevation tokens.** `shadow-sm` → `style={{ boxShadow: 'var(--elevation-1)' }}` (or a Tailwind plugin alias if added later).
3. **Replace ad-hoc radii with tokens.** Sweep `rounded-md`, `rounded-lg`, `rounded-xl` to a single mapped scale.
4. **Add the `<EmptyState />` shared component** and migrate Tickets / Scheduling / SMS Inbox / Dispatch (audit U-03).
5. **Fix the sidebar contrast issues in Admin and Ops** by adopting `--color-sidebar-*` instead of hardcoded purple/emerald tints (audit U-02, U-07).
6. **Add the global breadcrumb component** (audit U-05) — visual style: 12px label, `--color-text-secondary`, separator dot, current crumb in `--color-text-primary`.
7. **Apply table conventions** (banding, sticky headers, tabular numerals, right-align numeric) to Calls, Tickets, Dispatch (audit U-09).
8. **Standardize loading skeletons** on a single `<Skeleton />` family (audit U-10).

### Marketing chrome exception: `harbor` → `sidebar-bg` (not `surface-inverse`)

Legacy marketing surfaces used `bg-harbor` (and `from-/via-/to-/border-harbor`, plus `bg-harbor-light`) for the always-dark navy chrome (header, hero, gradient overlays). Those _surface_ utilities migrate to **`bg-sidebar-bg` / `bg-sidebar-hover`**, not `bg-surface-inverse`.

Why: `--color-surface-inverse` flips light↔dark by design (`#0E2738` → `#E8EFF2`), so a marketing hero swapped to `bg-surface-inverse` would render light-on-light in dark mode. `--color-sidebar-bg` keeps the deep navy in both themes (`#0E2738` → `#07151E`) — the exact values the legacy `--color-harbor` token had — so the visual intent is preserved.

Text utilities still follow the standard map: `text-harbor` → `text-text-primary` (text inverts for readability, which is what we actually want).

## 6. How to use the tokens in code

### CSS / Tailwind v4
```tsx
<div className="bg-surface text-text-primary border border-border rounded-lg shadow-[var(--elevation-1)]">
  <h2 className="font-display text-xl tracking-tight">Hello</h2>
  <p className="text-sm text-text-secondary">Body copy</p>
</div>
```

### TypeScript (charts, canvas, programmatic)
```tsx
import { tokens, chartPalette, palette } from '@/lib/designTokens';

const data = [{ value: 184, fill: chartPalette[0] }, ...];
const cardShadow = tokens.elevation.e2;
```

> Both surfaces resolve to the same values. The CSS file is the runtime; the TS file is the typed mirror.

### Keep the two in sync

A small script verifies that every locked token in `designTokens.ts` matches the corresponding `--color-*` / `--radius-*` value in `index.css`. Run it whenever you touch either file (and ideally in CI):

```bash
npm run check:design-tokens
```

It exits non-zero with a clear diff if any pair has drifted.

### Catch dark-mode regressions on the public marketing site

A second check launches a real headless browser, visits each top-level public route in both light and dark mode, and walks every visible text node to compute its contrast against the effective opaque background. It catches the most common dark-mode regressions — hardcoded `bg-white` cards, `text-harbor` on a `bg-harbor-light` surface, and similar near-invisible pairings — that the static token check cannot see.

```bash
# Requires the Platform Dev workflow running on :5000 and
# `npx playwright install chromium` already done.
npm run check:public-dark-mode
```

It exits non-zero and prints up to 10 worst-offender elements per failing route, with their tag, classes, computed text colour, computed background colour and contrast ratio. Tunable via `DARKMODE_MIN_CONTRAST` (default `1.6`) and `DARKMODE_MAX_FAILURES` (default `0`).

### Run both checks together (CI entrypoint)

`scripts/ci-design-checks.sh` is the single entrypoint that runs both checks back-to-back. It reuses an already-running vite dev server on `:5000` if there is one (so it doesn't fight a developer's open `Platform Dev` workflow) and otherwise boots an ephemeral one for the duration of the run. It also installs the Playwright Chromium binary on demand if it is not already cached.

```bash
npm run check:design
# or, in environments without a browser available:
SKIP_DARK_MODE_CHECK=1 npm run check:design
```

This script is wired into `scripts/post-merge.sh` so both checks run automatically after every task merge.

---

## 7. Where to see the comparison

The full 3-direction comparison that informed this lock-in lives at:

- **Live:** `/internal/design-directions` (no auth required)
- **Source:** `client-app/src/pages/DesignDirections.tsx`
- **Mockup canvas:** `artifacts/mockup-sandbox/src/components/mockups/QvoDesignDirections.tsx`

Keep them around as a reference; they document the "why not" alongside the "why".

---

## 8. Change log

| Date | Change | Author |
|---|---|---|
| 2026-04-27 | Locked Refined Harbor as the system. Tokens written to `index.css` and `designTokens.ts`. | Task #739 |
