/**
 * QVO Design System — token mirror (locked to the brand bible 2026-05-25)
 *
 * Source of truth for raw token values. The CSS bridge in
 * `client-app/src/styles/_theme.css` is the runtime source; it aliases
 * every Tailwind token to a `--qvo-*` primitive defined in
 * `client-app/src/brand/qvo-global.css` (the canonical QVO brand kit).
 * This file mirrors the SAME resolved values in TypeScript for:
 *   1. Typed access in JS (charts, canvas, programmatic theming)
 *   2. Storybook / documentation generation
 *   3. Static analysis and design-token tests
 *
 * IF YOU CHANGE A VALUE HERE, ALSO UPDATE the brand kit / `_theme.css`.
 * `scripts/check-design-tokens-sync.mjs` resolves the CSS var() chains
 * and fails CI if the two drift. See `docs/design-system.md`.
 */

export const designSystemVersion = "1.0.0";

/* ----------------------------------------------------------------- */
/* PALETTE — resolved from the QVO brand kit (light)                  */
/* ----------------------------------------------------------------- */

export const palette = {
  // Brand (primary = Deep Harbor)
  primary: "#123047",
  primaryHover: "#0E263A",
  primaryLight: "#EAF0F4",
  onPrimary: "#FFFFFF",

  // Accent (Signal Teal)
  accent: "#2E8C83",
  accentHover: "#246E67",
  accentLight: "#E7F2F0",
  onAccent: "#FFFFFF",

  // Semantic feedback (reserved for system state — never decoration)
  success: "#4C9B6B",
  successLight: "rgba(76, 155, 107, 0.14)",
  warning: "#C98A2E",
  warningLight: "rgba(201, 138, 46, 0.16)",
  danger: "#B34D4D",
  dangerHover: "#962F2F",
  dangerLight: "rgba(179, 77, 77, 0.14)",
  info: "#1B544F",
  infoLight: "#DCEAF0",

  // Surfaces
  surface: "#FFFFFF",
  surfaceSecondary: "#F3F7F7",
  surfaceHover: "#EAEFEF",
  surfaceMuted: "#EAEFEF",
  surfaceInverse: "#123047",
  onInverse: "#FFFFFF",

  // Text
  textPrimary: "#123047",
  textSecondary: "#5B6770",
  textMuted: "#8A949D",

  // Borders
  border: "#CDD7DB",
  borderStrong: "#A7B3B8",

  // Sidebar / chrome
  sidebarBg: "#123047",
  sidebarText: "#97AAB9",
  sidebarActive: "#2E8C83",
  sidebarHover: "#0E263A",
  onSidebar: "#FFFFFF",

  // Modal / dialog scrim
  overlay: "rgba(18, 48, 71, 0.55)",
} as const;

export const paletteDark = {
  primary: "#123047",
  primaryHover: "#0E263A",
  primaryLight: "#EAF0F4",
  onPrimary: "#FFFFFF",

  accent: "#2E8C83",
  accentHover: "#246E67",
  accentLight: "#E7F2F0",
  onAccent: "#FFFFFF",

  success: "#4C9B6B",
  successLight: "rgba(76, 155, 107, 0.14)",
  warning: "#C98A2E",
  warningLight: "rgba(201, 138, 46, 0.16)",
  danger: "#B34D4D",
  dangerHover: "#962F2F",
  dangerLight: "rgba(179, 77, 77, 0.14)",
  info: "#1B544F",
  infoLight: "#DCEAF0",

  surface: "#0A1D2C",
  surfaceSecondary: "#07151F",
  surfaceHover: "#050E16",
  surfaceMuted: "#050E16",
  surfaceInverse: "#123047",
  onInverse: "#123047",

  textPrimary: "#FFFFFF",
  textSecondary: "#94A3AC",
  textMuted: "#6B7880",

  border: "#1F3A4F",
  borderStrong: "#385A72",

  sidebarBg: "#050E16",
  sidebarText: "#97AAB9",
  sidebarActive: "#3E9890",
  sidebarHover: "#0A1D2C",
  onSidebar: "#FFFFFF",

  overlay: "rgba(0, 0, 0, 0.7)",
} as const;

/* ----------------------------------------------------------------- */
/* TYPOGRAPHY — Sora (display) · Manrope (body) · JetBrains Mono      */
/* ----------------------------------------------------------------- */

export const fontFamilies = {
  display: "'Sora', system-ui, -apple-system, sans-serif",
  body: "'Manrope', system-ui, -apple-system, sans-serif",
  sans: "'Manrope', system-ui, -apple-system, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

/** Type scale — pixel sizes paired with line-height + tracking. */
export const typeScale = {
  display: {
    fontSize: 48,
    lineHeight: 1.02,
    letterSpacing: "-0.02em",
    fontWeight: 600,
    fontFamily: fontFamilies.display,
  },
  headline: {
    fontSize: 32,
    lineHeight: 1.1,
    letterSpacing: "-0.02em",
    fontWeight: 600,
    fontFamily: fontFamilies.display,
  },
  title: {
    fontSize: 22,
    lineHeight: 1.1,
    letterSpacing: "-0.02em",
    fontWeight: 600,
    fontFamily: fontFamilies.display,
  },
  body: {
    fontSize: 16,
    lineHeight: 1.55,
    letterSpacing: "0",
    fontWeight: 400,
    fontFamily: fontFamilies.body,
  },
  bodySm: {
    fontSize: 14,
    lineHeight: 1.5,
    letterSpacing: "0",
    fontWeight: 400,
    fontFamily: fontFamilies.body,
  },
  label: {
    fontSize: 12,
    lineHeight: 1.3,
    letterSpacing: "0.04em",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    fontFamily: fontFamilies.body,
  },
  mono: {
    fontSize: 12,
    lineHeight: 1.4,
    letterSpacing: "0.04em",
    fontWeight: 400,
    fontFamily: fontFamilies.mono,
    fontVariantNumeric: "tabular-nums" as const,
  },
} as const;

/* ----------------------------------------------------------------- */
/* SPACING (8px scale per brand)                                      */
/* ----------------------------------------------------------------- */

export const spacing = {
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "24px",
  6: "32px",
  7: "48px",
  8: "64px",
} as const;

/* ----------------------------------------------------------------- */
/* RADIUS (brand-aligned)                                             */
/* ----------------------------------------------------------------- */

export const radius = {
  sm: "4px",
  md: "8px",
  lg: "14px",
  xl: "18px",
  pill: "9999px",
} as const;

/* ----------------------------------------------------------------- */
/* ELEVATION (soft, harbor-tinted — per brand kit)                   */
/* ----------------------------------------------------------------- */

export const elevation = {
  e1: "0 1px 2px rgba(18, 48, 71, 0.06), 0 0 0 1px rgba(18, 48, 71, 0.04)",
  e2: "0 4px 14px rgba(18, 48, 71, 0.08), 0 0 0 1px rgba(18, 48, 71, 0.04)",
  e3: "0 16px 48px rgba(18, 48, 71, 0.12)",
  glow: "0 0 0 3px rgba(46, 140, 131, 0.5)",
} as const;

/* ----------------------------------------------------------------- */
/* MOTION (per brand kit)                                             */
/* ----------------------------------------------------------------- */

export const motion = {
  durations: {
    fast: 120,
    base: 220,
    slow: 420,
  },
  easings: {
    standard: "cubic-bezier(0.22, 1, 0.36, 1)",
    emphasized: "cubic-bezier(0.65, 0, 0.35, 1)",
  },
} as const;

/* ----------------------------------------------------------------- */
/* A11Y                                                               */
/* ----------------------------------------------------------------- */

export const a11y = {
  // Focus ring is Signal Teal across the brand (see --focus-ring-color).
  focusRingColor: palette.accent,
  focusRingOffset: "2px",
  focusRingWidth: "2px",
  /** Minimum interactive target size — required for taps/clicks. */
  touchTargetMin: "44px",
  /** Body text must hit at least this contrast ratio (WCAG AA). */
  minContrastBody: 4.5,
  /** Large text (≥18px / 14px bold) may relax to this ratio. */
  minContrastLarge: 3.0,
} as const;

/* ----------------------------------------------------------------- */
/* CHART PALETTE                                                      */
/* ----------------------------------------------------------------- */

/**
 * Ordered, distinguishable categorical sequence for charts, drawn ONLY
 * from the brand's harbor + teal tonal ramps. Status colors
 * (success / warning / critical) are intentionally excluded — the brand
 * reserves them for system state, never decoration. Loop back if you
 * exceed 6 series.
 */
export const chartPalette = [
  palette.accent, // teal-500  — primary series
  palette.primary, // harbor-500 — deep navy
  "#58A89F", // teal-300
  "#677F92", // harbor-300
  "#1B544F", // teal-700
  "#97AAB9", // harbor-200
] as const;

/* ----------------------------------------------------------------- */
/* DEFAULT EXPORT — easy destructuring                                */
/* ----------------------------------------------------------------- */

export const tokens = {
  version: designSystemVersion,
  palette,
  paletteDark,
  fontFamilies,
  typeScale,
  spacing,
  radius,
  elevation,
  motion,
  a11y,
  chartPalette,
} as const;

export type Tokens = typeof tokens;
export default tokens;
