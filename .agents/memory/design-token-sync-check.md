---
name: Design-token sync check
description: How the QVO design-token sync gate works and why fixing it can unmask other failures.
---

# Design-token sync check (`scripts/check-design-tokens-sync.mjs`)

The TS token mirror (`client-app/src/lib/designTokens.ts`) must stay in sync with the
CSS tokens Tailwind ships. But the bridge (`_theme.css`) aliases every `--color-*` /
`--radius-*` to a `--qvo-*` primitive defined in the canonical brand kit
(`client-app/src/brand/qvo-global.css`), and dark mode flips by redefining those
primitives under `[data-theme="dark"]`.

**Rule:** a raw string compare of the two files is meaningless. The check must
RESOLVE the `var()` chains through the real cascade before comparing:
- light: `@theme` value → resolve via brand kit `:root`
- dark: `.dark` chrome override wins; else `@theme` value resolved via brand kit
  `[data-theme="dark"]`, falling back to `:root`.
Non-`var()` values (rgba/color-mix/hex) compare literally — so `*-light` tints stored
as `rgba(r,g,b,a)` in TS will NOT match `color-mix(...)` in CSS; those fields are
intentionally left out of the check, only concrete palette hexes + radii are asserted.

**Why dark primary stays harbor:** `--qvo-brand`/`--qvo-harbor` are not overridden in
`[data-theme="dark"]`, so `color-primary` resolves to `#123047` in both modes.

**Block extraction gotcha:** parse blocks with a brace-aware scan, and STRIP CSS
comments first — the file header literally contains `@theme {}` in prose, which a
naive `@theme\s*\{` match will grab (returning an empty body). A `\n}`-terminated
regex accidentally dodged this; the brace-aware scanner does not, hence comment strip.

## Gate ordering trap
`scripts/ci-design-checks.sh` runs under `set -euo pipefail` with the token check
FIRST, then browser gates (`check:public-dark-mode` contrast audit, `check:public-hero-visual`,
etc). So while the token gate fails, the post-merge never reaches the contrast audit.
**Fixing the token gate can unmask pre-existing downstream contrast failures.** Known
false positive: the contrast probe samples the page background behind hero background
images, so the homepage `/` hero reports white-on-mist (~1.08) even though it renders
fine — that is exactly why a separate `check:public-hero-visual` gate exists.
