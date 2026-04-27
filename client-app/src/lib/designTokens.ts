/**
 * QVO Design System — Refined Harbor (locked 2026-04-27)
 *
 * Source of truth for raw token values. The CSS @theme block in
 * `client-app/src/index.css` is the runtime source; this file mirrors
 * the same values in TypeScript for:
 *   1. Typed access in JS (charts, canvas, programmatic theming)
 *   2. Storybook / documentation generation
 *   3. Static analysis and design-token tests
 *
 * IF YOU CHANGE A VALUE HERE, ALSO UPDATE index.css. The two MUST stay
 * in sync. See `docs/design-system.md` for the rules.
 */

export const designSystemVersion = "1.0.0-refined-harbor";

/* ----------------------------------------------------------------- */
/* PALETTE                                                            */
/* ----------------------------------------------------------------- */

export const palette = {
  // Brand
  primary: "#1F8E83",
  primaryHover: "#177268",
  primaryLight: "#D8EDEB",
  onPrimary: "#FFFFFF",

  accent: "#E2A24A",
  accentHover: "#C88937",
  accentLight: "#F7E6CB",
  onAccent: "#0E2738",

  // Semantic feedback
  success: "#2F8F58",
  successLight: "#DDF0E5",
  warning: "#C98A2E",
  warningLight: "#F6E7CB",
  danger: "#B34D4D",
  dangerHover: "#962F2F",
  dangerLight: "#F4D8D8",
  info: "#3A7BBF",
  infoLight: "#D7E5F2",

  // Surfaces
  surface: "#FFFFFF",
  surfaceSecondary: "#F4F7F8",
  surfaceHover: "#EEF3F4",
  surfaceMuted: "#EEF3F4",
  surfaceInverse: "#0E2738",
  onInverse: "#E8EFF2",

  // Text
  textPrimary: "#0E2738",
  textSecondary: "#506575",
  textMuted: "#8FA5B4",

  // Borders
  border: "#D9E2E6",
  borderStrong: "#B8C5CC",

  // Sidebar / chrome
  sidebarBg: "#0E2738",
  sidebarText: "#C5D2DA",
  sidebarActive: "#1F8E83",
  sidebarHover: "#143A52",

  // Brand pigments (kept for backwards compat)
  harbor: "#0E2738",
  harborLight: "#143A52",
  teal: "#1F8E83",
  tealLight: "#D8EDEB",
  mist: "#F4F7F8",
  warmAmber: "#E2A24A",
  controlledRed: "#B34D4D",
  calmGreen: "#2F8F58",
  frostBlue: "#DCEAF0",
  mineralSand: "#E8E1D8",
} as const;

export const paletteDark = {
  primary: "#3DB3A6",
  primaryHover: "#4FC9BB",
  primaryLight: "#143A52",
  onPrimary: "#0E2738",

  accent: "#EDB872",
  accentHover: "#F4C98F",
  accentLight: "#2A2014",
  onAccent: "#0E2738",

  success: "#4FB97A",
  successLight: "#1A2E22",
  warning: "#E0A654",
  warningLight: "#2A2114",
  danger: "#D17070",
  dangerHover: "#E08585",
  dangerLight: "#2A1818",
  info: "#6FA5DD",
  infoLight: "#14202C",

  surface: "#11293A",
  surfaceSecondary: "#0A1C28",
  surfaceHover: "#143A52",
  surfaceMuted: "#143A52",
  surfaceInverse: "#E8EFF2",
  onInverse: "#0E2738",

  textPrimary: "#E8EFF2",
  textSecondary: "#8FA5B4",
  textMuted: "#607585",

  border: "#1E3A4D",
  borderStrong: "#2C5168",

  sidebarBg: "#07151E",
  sidebarText: "#8FA5B4",
  sidebarActive: "#3DB3A6",
  sidebarHover: "#11293A",
} as const;

/* ----------------------------------------------------------------- */
/* TYPOGRAPHY                                                         */
/* ----------------------------------------------------------------- */

export const fontFamilies = {
  display: "'Sora', ui-sans-serif, system-ui, sans-serif",
  body: "'Inter', ui-sans-serif, system-ui, sans-serif",
  sans: "'Inter', ui-sans-serif, system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

/** Type scale — pixel sizes paired with line-height + tracking. */
export const typeScale = {
  display: {
    fontSize: 44,
    lineHeight: 1.05,
    letterSpacing: "-0.02em",
    fontWeight: 700,
    fontFamily: fontFamilies.display,
  },
  headline: {
    fontSize: 32,
    lineHeight: 1.15,
    letterSpacing: "-0.015em",
    fontWeight: 600,
    fontFamily: fontFamilies.display,
  },
  title: {
    fontSize: 20,
    lineHeight: 1.3,
    letterSpacing: "-0.01em",
    fontWeight: 600,
    fontFamily: fontFamilies.display,
  },
  body: {
    fontSize: 15,
    lineHeight: 1.55,
    letterSpacing: "0",
    fontWeight: 400,
    fontFamily: fontFamilies.body,
  },
  bodySm: {
    fontSize: 13,
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
    fontSize: 13,
    lineHeight: 1.4,
    letterSpacing: "0",
    fontWeight: 400,
    fontFamily: fontFamilies.mono,
    fontVariantNumeric: "tabular-nums" as const,
  },
} as const;

/* ----------------------------------------------------------------- */
/* SPACING (4px grid)                                                 */
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
/* RADIUS (premium, generous)                                         */
/* ----------------------------------------------------------------- */

export const radius = {
  sm: "6px",
  md: "10px",
  lg: "14px",
  xl: "20px",
  pill: "9999px",
} as const;

/* ----------------------------------------------------------------- */
/* ELEVATION (soft, harbor-tinted)                                    */
/* ----------------------------------------------------------------- */

export const elevation = {
  e1: "0 1px 2px rgba(14, 39, 56, 0.05)",
  e2: "0 8px 24px rgba(14, 39, 56, 0.06), 0 2px 6px rgba(14, 39, 56, 0.04)",
  e3: "0 24px 48px rgba(14, 39, 56, 0.10), 0 6px 14px rgba(14, 39, 56, 0.06)",
  glow: "0 0 0 4px rgba(31, 142, 131, 0.18)",
} as const;

/* ----------------------------------------------------------------- */
/* MOTION                                                             */
/* ----------------------------------------------------------------- */

export const motion = {
  durations: {
    fast: 120,
    base: 200,
    slow: 320,
  },
  easings: {
    standard: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    emphasized: "cubic-bezier(0.16, 1, 0.3, 1)",
  },
} as const;

/* ----------------------------------------------------------------- */
/* A11Y                                                               */
/* ----------------------------------------------------------------- */

export const a11y = {
  focusRingColor: palette.primary,
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
 * Ordered, distinguishable, color-blind-checked sequence for charts.
 * Index 0 = primary series. Loop back if you exceed 6 series.
 */
export const chartPalette = [
  palette.primary, // teal — primary series
  palette.accent, // warm amber
  palette.info, // calm blue
  palette.success, // green
  palette.warning, // ochre
  palette.harborLight, // deep navy tint
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
