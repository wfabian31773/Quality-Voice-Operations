/* =================================================================
 * QVO design directions — FROZEN SNAPSHOT (2026-04-27)
 *
 * Refined Harbor (id: "harbor") was picked and is now the locked
 * design system. The locked tokens live in:
 *   - client-app/src/index.css  (runtime CSS vars)
 *   - client-app/src/lib/designTokens.ts  (typed mirror)
 *
 * The DIRECTIONS table here is intentionally NOT regenerated from
 * those files — it's a historical record so the team can revisit
 * the comparison. If you need to update Refined Harbor going forward,
 * edit index.css + designTokens.ts (NOT this file). The two rejected
 * directions (signal, crisp) are kept frozen for the same reason.
 * ================================================================= */

import type { CSSProperties, ReactNode } from "react";

export type DirectionId = "harbor" | "signal" | "crisp";

export interface DirectionTokens {
  id: DirectionId;
  name: string;
  category: string;
  tagline: string;
  rationale: string;
  bestFor: string[];
  tradeoffs: string[];

  fontDisplay: string;
  fontBody: string;
  fontPairingName: string;

  palette: {
    bg: string;
    surface: string;
    surfaceMuted: string;
    surfaceInverse: string;
    border: string;
    text: string;
    textMuted: string;
    textInverse: string;
    primary: string;
    primaryHover: string;
    primaryOn: string;
    accent: string;
    success: string;
    warning: string;
    error: string;
    info: string;
  };

  paletteDark: {
    bg: string;
    surface: string;
    border: string;
    text: string;
    textMuted: string;
    primary: string;
  };

  type: {
    display: string;
    headline: string;
    title: string;
    body: string;
    label: string;
  };

  radius: {
    sm: string;
    md: string;
    lg: string;
    xl: string;
    pill: string;
  };

  spacing: { 1: string; 2: string; 3: string; 4: string; 5: string };

  elevation: {
    e1: string;
    e2: string;
    e3: string;
  };

  motion: {
    fast: string;
    base: string;
    slow: string;
    easing: string;
  };
}

export const DIRECTIONS: DirectionTokens[] = [
  {
    id: "harbor",
    name: "Refined Harbor",
    category: "Premium glass + bento — evolved brand",
    tagline:
      "Deepens the existing Deep Harbor / Signal Teal identity with soft glass, generous radii, and warm-neutral support.",
    rationale:
      "Keeps QVO's brand equity (Harbor + Teal) but trades the current flat slate-gray UI for a layered, premium feel — soft glass surfaces over a deep navy chrome, generous rounding, and warm neutral support tones that read as enterprise without feeling sterile. Deliberately romantic where it counts (marketing, dashboards) and quiet where it shouldn't be (data tables stay flat and dense).",
    bestFor: [
      "Marketing site & demo",
      "Tenant dashboard hero",
      "Onboarding & empty states",
    ],
    tradeoffs: [
      "Glass surfaces need more care in dark mode (tested pairs ship)",
      "Backdrop-blur cost on long lists — restricted to chrome only",
    ],
    fontDisplay: "Sora, ui-sans-serif, system-ui, sans-serif",
    fontBody: "Inter, ui-sans-serif, system-ui, sans-serif",
    fontPairingName: "Sora · Inter",
    palette: {
      bg: "#F4F7F8",
      surface: "#FFFFFF",
      surfaceMuted: "#EEF3F4",
      surfaceInverse: "#0E2738",
      border: "#D9E2E6",
      text: "#0E2738",
      textMuted: "#506575",
      textInverse: "#F4F7F8",
      primary: "#1F8E83",
      primaryHover: "#177268",
      primaryOn: "#FFFFFF",
      accent: "#E2A24A",
      success: "#2F8F58",
      warning: "#C98A2E",
      error: "#B34D4D",
      info: "#3A7BBF",
    },
    paletteDark: {
      bg: "#0A1C28",
      surface: "#11293A",
      border: "#1E3A4D",
      text: "#E8EFF2",
      textMuted: "#8FA5B4",
      primary: "#3DB3A6",
    },
    type: {
      display: "44px / 1.05 / -0.02em — Sora 700",
      headline: "32px / 1.15 / -0.015em — Sora 600",
      title: "20px / 1.3 / -0.01em — Sora 600",
      body: "15px / 1.55 — Inter 400",
      label: "12px / 1.3 / 0.04em — Inter 600 uppercase",
    },
    radius: {
      sm: "6px",
      md: "10px",
      lg: "14px",
      xl: "20px",
      pill: "999px",
    },
    spacing: { 1: "4px", 2: "8px", 3: "12px", 4: "16px", 5: "24px" },
    elevation: {
      e1: "0 1px 2px rgba(14,39,56,.05)",
      e2: "0 8px 24px rgba(14,39,56,.06), 0 2px 6px rgba(14,39,56,.04)",
      e3: "0 24px 48px rgba(14,39,56,.10), 0 6px 14px rgba(14,39,56,.06)",
    },
    motion: {
      fast: "120ms",
      base: "200ms",
      slow: "320ms",
      easing: "cubic-bezier(.2,.8,.2,1)",
    },
  },
  {
    id: "signal",
    name: "Signal Density",
    category: "Minimalism + data-first — high information density",
    tagline:
      "Tight spacing, hairline borders, micro-shadows, and tabular numerals so dense surfaces feel calm instead of cramped.",
    rationale:
      "Optimizes for the operator who lives in Calls, Dispatch, and Tickets. Removes decoration from data surfaces, replaces shadows with thin 1px borders, and standardizes on tabular monospace numerals so columns line up. Keeps Signal Teal as a pure accent (links, primary actions, focus rings) — everything else becomes a precise neutral. The marketing site borrows the same restraint, leaning on bold typography and generous whitespace instead of color.",
    bestFor: [
      "Calls / Dispatch / Tickets",
      "Admin & Ops consoles",
      "Long forms, settings, governance",
    ],
    tradeoffs: [
      "Marketing hero needs strong typography to avoid feeling underdressed",
      "Hairline borders require careful AA contrast in dark mode",
    ],
    fontDisplay: "'Inter Display', Inter, ui-sans-serif, sans-serif",
    fontBody: "Inter, ui-sans-serif, sans-serif",
    fontPairingName: "Inter Display · Inter · JetBrains Mono",
    palette: {
      bg: "#FAFAF9",
      surface: "#FFFFFF",
      surfaceMuted: "#F4F4F2",
      surfaceInverse: "#0B0B0C",
      border: "#E4E4E1",
      text: "#0B0B0C",
      textMuted: "#5C5C5A",
      textInverse: "#FAFAF9",
      primary: "#117A6F",
      primaryHover: "#0C5E55",
      primaryOn: "#FFFFFF",
      accent: "#117A6F",
      success: "#2C7B4D",
      warning: "#A6770F",
      error: "#A23A3A",
      info: "#235D9B",
    },
    paletteDark: {
      bg: "#0B0B0C",
      surface: "#141416",
      border: "#26262A",
      text: "#F2F2F0",
      textMuted: "#A0A09C",
      primary: "#3DB3A6",
    },
    type: {
      display: "40px / 1.0 / -0.025em — Inter Display 700",
      headline: "26px / 1.2 / -0.015em — Inter Display 600",
      title: "16px / 1.35 — Inter 600",
      body: "13px / 1.5 — Inter 400",
      label: "11px / 1.2 / 0.06em — Inter 600 uppercase",
    },
    radius: {
      sm: "3px",
      md: "5px",
      lg: "8px",
      xl: "12px",
      pill: "999px",
    },
    spacing: { 1: "2px", 2: "6px", 3: "10px", 4: "14px", 5: "20px" },
    elevation: {
      e1: "0 0 0 1px rgba(11,11,12,.06)",
      e2: "0 0 0 1px rgba(11,11,12,.08), 0 1px 2px rgba(11,11,12,.05)",
      e3: "0 0 0 1px rgba(11,11,12,.10), 0 8px 20px rgba(11,11,12,.08)",
    },
    motion: {
      fast: "80ms",
      base: "140ms",
      slow: "240ms",
      easing: "cubic-bezier(.4,0,.2,1)",
    },
  },
  {
    id: "crisp",
    name: "Crisp Modern",
    category: "Modern enterprise neutrals — balanced default",
    tagline:
      "Clean white surfaces, mid-radius cards, decisive Signal Teal accents — the safe, modern enterprise default.",
    rationale:
      "The middle path: clean white surfaces, mid-radius cards, decisive shadow steps, and Signal Teal as the unambiguous primary. Reads as a credible enterprise SaaS to a CIO and as a friendly product to an end user. Honors the existing brand without leaning glassy or austere — and works well across marketing, dashboards, and data tables without bespoke per-surface treatment.",
    bestFor: [
      "All three consoles consistently",
      "Marketing & docs site",
      "Component library reuse across apps",
    ],
    tradeoffs: [
      "Less distinctive — risks 'generic SaaS' if accent isn't used boldly",
      "Mid-radius cards need consistent shadow discipline to feel intentional",
    ],
    fontDisplay: "'Plus Jakarta Sans', ui-sans-serif, sans-serif",
    fontBody: "Inter, ui-sans-serif, sans-serif",
    fontPairingName: "Plus Jakarta Sans · Inter",
    palette: {
      bg: "#F6F8FA",
      surface: "#FFFFFF",
      surfaceMuted: "#EEF2F6",
      surfaceInverse: "#0F1A24",
      border: "#E1E6EC",
      text: "#0F1A24",
      textMuted: "#5B6776",
      textInverse: "#F6F8FA",
      primary: "#2E8C83",
      primaryHover: "#236E67",
      primaryOn: "#FFFFFF",
      accent: "#2E8C83",
      success: "#16A34A",
      warning: "#D97706",
      error: "#DC2626",
      info: "#2563EB",
    },
    paletteDark: {
      bg: "#0F1A24",
      surface: "#1A2632",
      border: "#2A3845",
      text: "#F1F5F9",
      textMuted: "#94A3B8",
      primary: "#3DB3A6",
    },
    type: {
      display: "42px / 1.08 / -0.02em — Plus Jakarta 700",
      headline: "28px / 1.2 / -0.012em — Plus Jakarta 600",
      title: "18px / 1.35 — Inter 600",
      body: "14px / 1.55 — Inter 400",
      label: "12px / 1.3 / 0.03em — Inter 600 uppercase",
    },
    radius: {
      sm: "4px",
      md: "8px",
      lg: "12px",
      xl: "16px",
      pill: "999px",
    },
    spacing: { 1: "4px", 2: "8px", 3: "12px", 4: "16px", 5: "24px" },
    elevation: {
      e1: "0 1px 2px rgba(15,26,36,.04)",
      e2: "0 4px 12px rgba(15,26,36,.06), 0 1px 3px rgba(15,26,36,.04)",
      e3: "0 16px 32px rgba(15,26,36,.10), 0 4px 8px rgba(15,26,36,.06)",
    },
    motion: {
      fast: "100ms",
      base: "180ms",
      slow: "280ms",
      easing: "cubic-bezier(.16,1,.3,1)",
    },
  },
];

export function directionVars(d: DirectionTokens): CSSProperties {
  return {
    "--bg": d.palette.bg,
    "--surface": d.palette.surface,
    "--surface-muted": d.palette.surfaceMuted,
    "--surface-inverse": d.palette.surfaceInverse,
    "--border": d.palette.border,
    "--text": d.palette.text,
    "--text-muted": d.palette.textMuted,
    "--text-inverse": d.palette.textInverse,
    "--primary": d.palette.primary,
    "--primary-hover": d.palette.primaryHover,
    "--primary-on": d.palette.primaryOn,
    "--accent": d.palette.accent,
    "--success": d.palette.success,
    "--warning": d.palette.warning,
    "--error": d.palette.error,
    "--info": d.palette.info,
    "--r-sm": d.radius.sm,
    "--r-md": d.radius.md,
    "--r-lg": d.radius.lg,
    "--r-xl": d.radius.xl,
    "--e1": d.elevation.e1,
    "--e2": d.elevation.e2,
    "--e3": d.elevation.e3,
    "--font-display": d.fontDisplay,
    "--font-body": d.fontBody,
    fontFamily: d.fontBody,
    color: d.palette.text,
  } as CSSProperties;
}

export function PaletteSwatch({
  label,
  hex,
  textOn,
}: {
  label: string;
  hex: string;
  textOn?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="h-12 w-full rounded-md flex items-end p-1.5 text-[9px] font-mono"
        style={{
          background: hex,
          color: textOn || "#0a0a0a",
          border: "1px solid rgba(0,0,0,.06)",
        }}
      >
        {hex}
      </div>
      <span
        className="text-[10px] font-medium uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </span>
    </div>
  );
}

export function SectionLabel({
  children,
  d,
}: {
  children: ReactNode;
  d: DirectionTokens;
}) {
  return (
    <div
      className="text-[10px] font-semibold uppercase tracking-[0.08em] mb-2"
      style={{ color: d.palette.textMuted }}
    >
      {children}
    </div>
  );
}
