import "../styles/tw-app.css";
import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import PrimitivesShowcase from "./internal/PrimitivesShowcase";
import {
  Phone,
  PhoneCall,
  PhoneIncoming,
  Bot,
  Calendar,
  TrendingUp,
  ArrowRight,
  Search,
  Sparkles,
  Truck,
  CheckCircle2,
  Wifi,
  Plus,
  Eye,
  AlertTriangle,
} from "lucide-react";

/* =================================================================
 * DESIGN DIRECTIONS — internal preview page (FROZEN SNAPSHOT)
 *
 * Renders 3 visual directions (Refined Harbor, Signal Density,
 * Crisp Modern) across 3 surfaces (Marketing Hero, Tenant Dashboard,
 * Dispatch board), plus the full token system for each.
 *
 * Status: Refined Harbor was picked on 2026-04-27 and locked into
 * `client-app/src/index.css` + `client-app/src/lib/designTokens.ts`.
 * This page is preserved as the historical comparison artifact —
 * the rejected directions intentionally do NOT track future token
 * changes. Do not edit token values here; if you need to update the
 * locked Refined Harbor system, do it in `index.css` + `designTokens.ts`
 * (and run `npm run check:design-tokens`).
 *
 * The route at `/internal/design-directions` is intentionally
 * unauthenticated (it's a static visual reference), but emits a
 * `noindex, nofollow` meta tag and renders a visible "Internal" badge
 * so it's not mistaken for a public marketing page.
 * ================================================================= */

type DirectionId = "harbor" | "signal" | "crisp";

interface DirectionTokens {
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
  elevation: { e1: string; e2: string; e3: string };
  motion: { fast: string; base: string; slow: string; easing: string };
}

const DIRECTIONS: DirectionTokens[] = [
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

const SURFACE_HEIGHT = 360;

function frame(d: DirectionTokens, padding = 16): CSSProperties {
  return {
    background: d.palette.bg,
    borderRadius: d.radius.lg,
    border: `1px solid ${d.palette.border}`,
    boxShadow: d.elevation.e1,
    padding,
    fontFamily: d.fontBody,
    color: d.palette.text,
    height: SURFACE_HEIGHT,
    overflow: "hidden",
    position: "relative",
  };
}

function card(d: DirectionTokens): CSSProperties {
  return {
    background: d.palette.surface,
    borderRadius: d.radius.md,
    border: `1px solid ${d.palette.border}`,
    boxShadow: d.elevation.e1,
  };
}

function PaletteSwatch({
  label,
  hex,
  textOn,
}: {
  label: string;
  hex: string;
  textOn?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          height: 48,
          width: "100%",
          borderRadius: 6,
          display: "flex",
          alignItems: "flex-end",
          padding: 6,
          fontSize: 9,
          fontFamily: "ui-monospace, SF Mono, monospace",
          background: hex,
          color: textOn || "#0a0a0a",
          border: "1px solid rgba(0,0,0,.06)",
        }}
      >
        {hex}
      </div>
      <span
        style={{
          fontSize: 10,
          fontWeight: 500,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--text-muted, #506575)",
        }}
      >
        {label}
      </span>
    </div>
  );
}

function SectionLabel({
  children,
  d,
}: {
  children: ReactNode;
  d: DirectionTokens;
}) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        marginBottom: 8,
        color: d.palette.textMuted,
      }}
    >
      {children}
    </div>
  );
}

/* ----------------- Surfaces ----------------- */

function MarketingHero({ d }: { d: DirectionTokens }) {
  if (d.id === "harbor") {
    return (
      <div
        style={{
          ...frame(d, 0),
          background: `linear-gradient(135deg, ${d.palette.surfaceInverse} 0%, #143A52 60%, ${d.palette.surfaceInverse} 100%)`,
          color: d.palette.textInverse,
        }}
      >
        <div
          style={{
            position: "absolute",
            top: -40,
            right: -40,
            width: 220,
            height: 220,
            background: d.palette.primary,
            opacity: 0.18,
            filter: "blur(60px)",
            borderRadius: "50%",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: -30,
            left: 80,
            width: 180,
            height: 180,
            background: d.palette.accent,
            opacity: 0.12,
            filter: "blur(50px)",
            borderRadius: "50%",
          }}
        />
        <div
          style={{
            position: "relative",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            padding: 20,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  background: d.palette.primary,
                  borderRadius: d.radius.sm,
                  width: 22,
                  height: 22,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Phone size={12} color="#fff" />
              </div>
              <span
                style={{
                  fontFamily: d.fontDisplay,
                  fontWeight: 700,
                  fontSize: 14,
                  letterSpacing: "-0.01em",
                }}
              >
                QVO
              </span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontSize: 10,
                opacity: 0.7,
              }}
            >
              <span>Product</span>
              <span>Pricing</span>
              <span>Demo</span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 9,
                fontWeight: 500,
                padding: "4px 8px",
                background: `${d.palette.primary}26`,
                color: "#7DD9CC",
                borderRadius: d.radius.pill,
                border: `1px solid ${d.palette.primary}40`,
                width: "fit-content",
              }}
            >
              <span
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: "50%",
                  background: d.palette.primary,
                }}
              />
              AI VOICE PLATFORM
            </div>
            <div
              style={{
                fontFamily: d.fontDisplay,
                fontSize: 28,
                fontWeight: 700,
                lineHeight: 1.05,
                letterSpacing: "-0.02em",
                maxWidth: 280,
              }}
            >
              AI voice agents that{" "}
              <span style={{ color: "#7DD9CC" }}>run your business</span>
            </div>
            <p
              style={{
                fontSize: 11,
                lineHeight: 1.55,
                opacity: 0.7,
                maxWidth: 260,
                margin: 0,
              }}
            >
              Deploy intelligent voice agents that answer calls, book
              appointments, and dispatch technicians — 24/7.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                style={{
                  background: d.palette.primary,
                  color: d.palette.primaryOn,
                  borderRadius: d.radius.md,
                  padding: "8px 14px",
                  fontSize: 11,
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  boxShadow: `0 4px 16px ${d.palette.primary}40`,
                  border: "none",
                }}
              >
                Try Live Demo <ArrowRight size={11} />
              </button>
              <button
                style={{
                  background: "rgba(255,255,255,.08)",
                  color: "#fff",
                  borderRadius: d.radius.md,
                  padding: "8px 14px",
                  fontSize: 11,
                  fontWeight: 500,
                  border: "1px solid rgba(255,255,255,.12)",
                  backdropFilter: "blur(8px)",
                }}
              >
                See how it works
              </button>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 8,
            }}
          >
            {[
              { v: "2.4M+", l: "Calls" },
              { v: "99.9%", l: "Uptime" },
              { v: "850+", l: "Agents" },
            ].map((s) => (
              <div
                key={s.l}
                style={{
                  background: "rgba(255,255,255,.04)",
                  border: "1px solid rgba(255,255,255,.08)",
                  borderRadius: d.radius.md,
                  padding: "6px 8px",
                  backdropFilter: "blur(12px)",
                }}
              >
                <div
                  style={{
                    fontFamily: d.fontDisplay,
                    fontWeight: 700,
                    fontSize: 14,
                  }}
                >
                  {s.v}
                </div>
                <div style={{ fontSize: 9, opacity: 0.5 }}>{s.l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (d.id === "signal") {
    return (
      <div
        style={{
          ...frame(d, 0),
          background: d.palette.surface,
          borderColor: d.palette.border,
        }}
      >
        <div
          style={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            padding: 20,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 24,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  width: 18,
                  height: 18,
                  background: d.palette.text,
                  borderRadius: d.radius.sm,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Phone size={10} color={d.palette.bg} />
              </div>
              <span
                style={{
                  fontFamily: d.fontDisplay,
                  fontWeight: 700,
                  fontSize: 13,
                  letterSpacing: "-0.02em",
                }}
              >
                QVO
              </span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                fontSize: 10,
                color: d.palette.textMuted,
              }}
            >
              <span>Product</span>
              <span>Pricing</span>
              <span>Docs</span>
              <span
                style={{
                  color: d.palette.text,
                  borderBottom: `1px solid ${d.palette.text}`,
                }}
              >
                Sign in
              </span>
            </div>
          </div>

          <div
            style={{
              fontSize: 9,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              marginBottom: 12,
              color: d.palette.textMuted,
            }}
          >
            ── Voice operations
          </div>
          <div
            style={{
              fontFamily: d.fontDisplay,
              fontSize: 32,
              fontWeight: 700,
              lineHeight: 1.0,
              letterSpacing: "-0.025em",
            }}
          >
            One platform.
            <br />
            Every conversation.
            <br />
            <span style={{ color: d.palette.primary }}>Measurable.</span>
          </div>
          <p
            style={{
              fontSize: 11,
              lineHeight: 1.55,
              marginTop: 12,
              color: d.palette.textMuted,
              maxWidth: 280,
            }}
          >
            Voice agents, dispatch, scheduling, and analytics — built for teams
            that ship. No black boxes.
          </p>

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button
              style={{
                background: d.palette.text,
                color: d.palette.bg,
                borderRadius: d.radius.sm,
                padding: "7px 12px",
                fontSize: 11,
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                border: "none",
              }}
            >
              Try the demo →
            </button>
            <button
              style={{
                background: "transparent",
                color: d.palette.text,
                borderRadius: d.radius.sm,
                padding: "7px 12px",
                fontSize: 11,
                fontWeight: 500,
                border: `1px solid ${d.palette.border}`,
              }}
            >
              Read the docs
            </button>
          </div>

          <div
            style={{
              marginTop: "auto",
              paddingTop: 16,
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 12,
              borderTop: `1px solid ${d.palette.border}`,
            }}
          >
            {[
              { v: "2.4M", l: "Calls" },
              { v: "99.9%", l: "Uptime" },
              { v: "850", l: "Agents" },
              { v: "12", l: "Verticals" },
            ].map((s) => (
              <div key={s.l}>
                <div
                  style={{
                    fontFamily: "ui-monospace, SF Mono, monospace",
                    fontVariantNumeric: "tabular-nums",
                    fontSize: 14,
                    fontWeight: 600,
                  }}
                >
                  {s.v}
                </div>
                <div
                  style={{
                    fontSize: 9,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    marginTop: 2,
                    color: d.palette.textMuted,
                  }}
                >
                  {s.l}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // crisp
  return (
    <div
      style={{
        ...frame(d, 0),
        background: `linear-gradient(180deg, ${d.palette.surface} 0%, ${d.palette.surfaceMuted} 100%)`,
      }}
    >
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          padding: 20,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingBottom: 16,
            borderBottom: `1px solid ${d.palette.border}`,
            marginBottom: 20,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{
                width: 22,
                height: 22,
                background: d.palette.primary,
                borderRadius: d.radius.md,
                display: "grid",
                placeItems: "center",
              }}
            >
              <Phone size={11} color="#fff" />
            </div>
            <span
              style={{
                fontFamily: d.fontDisplay,
                fontWeight: 700,
                fontSize: 14,
              }}
            >
              QVO
            </span>
          </div>
          <button
            style={{
              background: d.palette.primary,
              color: "#fff",
              borderRadius: d.radius.md,
              padding: "5px 10px",
              fontSize: 10,
              fontWeight: 600,
              boxShadow: d.elevation.e1,
              border: "none",
            }}
          >
            Start free trial
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 16,
            flex: 1,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 9,
                fontWeight: 600,
                marginBottom: 8,
                padding: "2px 8px",
                background: `${d.palette.primary}1A`,
                color: d.palette.primary,
                borderRadius: d.radius.pill,
                width: "fit-content",
              }}
            >
              <Sparkles size={10} /> NEW · Vertical agents
            </div>
            <div
              style={{
                fontFamily: d.fontDisplay,
                fontSize: 24,
                fontWeight: 700,
                lineHeight: 1.1,
                letterSpacing: "-0.015em",
              }}
            >
              The voice operations hub for modern businesses
            </div>
            <p
              style={{
                fontSize: 11,
                marginTop: 8,
                lineHeight: 1.55,
                color: d.palette.textMuted,
              }}
            >
              Answer every call. Book every appointment. Track every outcome.
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                style={{
                  background: d.palette.primary,
                  color: "#fff",
                  borderRadius: d.radius.md,
                  padding: "7px 12px",
                  fontSize: 11,
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  boxShadow: d.elevation.e2,
                  border: "none",
                }}
              >
                Try demo <ArrowRight size={11} />
              </button>
              <button
                style={{
                  background: d.palette.surface,
                  color: d.palette.text,
                  border: `1px solid ${d.palette.border}`,
                  borderRadius: d.radius.md,
                  padding: "7px 12px",
                  fontSize: 11,
                  fontWeight: 500,
                }}
              >
                Book demo
              </button>
            </div>
          </div>
          <div
            style={{
              ...card(d),
              boxShadow: d.elevation.e2,
              padding: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: 10,
                marginBottom: 8,
                color: d.palette.textMuted,
              }}
            >
              <span
                style={{ display: "flex", alignItems: "center", gap: 4 }}
              >
                <PhoneIncoming size={10} color={d.palette.success} />
                Live call · 02:14
              </span>
              <Wifi size={10} color={d.palette.success} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                { who: "Caller", t: "Hi, I need to book an appointment." },
                {
                  who: "Agent",
                  t: "Of course — what day works best?",
                  primary: true,
                },
                { who: "Caller", t: "Thursday afternoon if possible." },
                {
                  who: "Agent",
                  t: "I have 2:30 PM available. Shall I book it?",
                  primary: true,
                },
              ].map((m, i) => (
                <div
                  key={i}
                  style={{
                    background: m.primary
                      ? `${d.palette.primary}12`
                      : d.palette.surfaceMuted,
                    borderRadius: d.radius.sm,
                    padding: "5px 7px",
                  }}
                >
                  <div
                    style={{
                      fontSize: 8,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: m.primary
                        ? d.palette.primary
                        : d.palette.textMuted,
                    }}
                  >
                    {m.who}
                  </div>
                  <div style={{ fontSize: 10, marginTop: 2 }}>{m.t}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TenantDashboard({ d }: { d: DirectionTokens }) {
  const stats = [
    { l: "Calls today", v: "184", icon: PhoneCall, t: "+12%" },
    { l: "Bookings", v: "27", icon: Calendar, t: "+4" },
    { l: "Active agents", v: "6", icon: Bot, t: "" },
    { l: "Live", v: "3", icon: TrendingUp, t: "now" },
  ];

  const useGlass = d.id === "harbor";
  const useTight = d.id === "signal";

  return (
    <div style={frame(d, 0)}>
      <div style={{ height: "100%", display: "flex" }}>
        <div
          style={{
            width: 110,
            background: d.palette.surfaceInverse,
            color: d.palette.textInverse,
            padding: useTight ? "12px 8px" : "14px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 12,
            }}
          >
            <div
              style={{
                width: 16,
                height: 16,
                background: d.palette.primary,
                borderRadius: d.radius.sm,
                display: "grid",
                placeItems: "center",
              }}
            >
              <Phone size={9} color="#fff" />
            </div>
            <span
              style={{
                fontFamily: d.fontDisplay,
                fontWeight: 700,
                fontSize: 11,
              }}
            >
              QVO
            </span>
          </div>
          {[
            { l: "Dashboard", active: true },
            { l: "Agents" },
            { l: "Calls" },
            { l: "Campaigns" },
            { l: "Analytics" },
            { l: "Dispatch" },
            { l: "Settings" },
          ].map((n) => (
            <div
              key={n.l}
              style={{
                fontSize: 10,
                padding: useTight ? "4px 6px" : "5px 8px",
                borderRadius: d.radius.sm,
                background: n.active
                  ? useGlass
                    ? "rgba(255,255,255,.08)"
                    : d.palette.primary
                  : "transparent",
                color: n.active
                  ? useGlass
                    ? "#fff"
                    : d.palette.primaryOn
                  : "rgba(255,255,255,.65)",
                fontWeight: n.active ? 600 : 400,
              }}
            >
              {n.l}
            </div>
          ))}
        </div>

        <div style={{ flex: 1, padding: 16, overflow: "hidden" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: d.fontDisplay,
                  fontWeight: 700,
                  fontSize: 16,
                  letterSpacing: "-0.01em",
                }}
              >
                Dashboard
              </div>
              <div style={{ fontSize: 10, color: d.palette.textMuted }}>
                What's happening today
              </div>
            </div>
            <button
              style={{
                background: d.palette.primary,
                color: d.palette.primaryOn,
                borderRadius: d.radius.md,
                padding: "5px 10px",
                fontSize: 10,
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                boxShadow: useGlass
                  ? `0 4px 12px ${d.palette.primary}30`
                  : d.elevation.e1,
                border: "none",
              }}
            >
              <Plus size={10} /> New agent
            </button>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 8,
              marginBottom: 12,
            }}
          >
            {stats.map((s) => (
              <div
                key={s.l}
                style={{
                  ...card(d),
                  padding: useTight ? 8 : 10,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 4,
                  }}
                >
                  <s.icon size={11} color={d.palette.primary} />
                  {s.t && (
                    <span
                      style={{
                        fontSize: 8,
                        fontWeight: 600,
                        color: d.palette.success,
                      }}
                    >
                      {s.t}
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontFamily: useTight
                      ? "ui-monospace, SF Mono, monospace"
                      : d.fontDisplay,
                    fontWeight: 700,
                    fontSize: 16,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {s.v}
                </div>
                <div
                  style={{
                    fontSize: 9,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: d.palette.textMuted,
                  }}
                >
                  {s.l}
                </div>
              </div>
            ))}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 1fr",
              gap: 8,
              flex: 1,
            }}
          >
            <div style={{ ...card(d), padding: 10 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 8,
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 600 }}>
                  Recent conversations
                </div>
                <span style={{ fontSize: 9, color: d.palette.primary }}>
                  View all →
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {[
                  { name: "Marcus Chen", agent: "Front Desk", s: "completed" },
                  { name: "+1 (415) 555-0142", agent: "Sales", s: "live" },
                  { name: "Sarah Park", agent: "Support", s: "completed" },
                  {
                    name: "+1 (628) 555-0177",
                    agent: "Front Desk",
                    s: "completed",
                  },
                ].map((c, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: useTight ? "3px 4px" : "4px 6px",
                      borderRadius: d.radius.sm,
                      background:
                        i % 2 && useTight
                          ? d.palette.surfaceMuted
                          : "transparent",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <PhoneIncoming size={9} color={d.palette.textMuted} />
                      <span style={{ fontSize: 10, fontWeight: 500 }}>
                        {c.name}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span style={{ fontSize: 9, color: d.palette.textMuted }}>
                        {c.agent}
                      </span>
                      <span
                        style={{
                          fontSize: 8,
                          fontWeight: 600,
                          padding: "2px 6px",
                          background:
                            c.s === "live"
                              ? `${d.palette.success}1F`
                              : d.palette.surfaceMuted,
                          color:
                            c.s === "live"
                              ? d.palette.success
                              : d.palette.textMuted,
                          borderRadius: d.radius.pill,
                        }}
                      >
                        {c.s}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div
              style={{
                ...card(d),
                padding: 10,
                background: useGlass
                  ? `linear-gradient(135deg, ${d.palette.primary}14 0%, ${d.palette.surface} 100%)`
                  : d.palette.surface,
              }}
            >
              <Sparkles size={12} color={d.palette.primary} />
              <div
                style={{
                  fontFamily: d.fontDisplay,
                  fontWeight: 600,
                  fontSize: 11,
                  marginTop: 6,
                  letterSpacing: "-0.01em",
                }}
              >
                Quick start
              </div>
              <div
                style={{
                  fontSize: 9,
                  marginTop: 4,
                  lineHeight: 1.5,
                  color: d.palette.textMuted,
                }}
              >
                3 of 5 steps complete
              </div>
              <div
                style={{
                  height: 4,
                  background: d.palette.surfaceMuted,
                  borderRadius: d.radius.pill,
                  marginTop: 6,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: "60%",
                    height: "100%",
                    background: d.palette.primary,
                  }}
                />
              </div>
              <div
                style={{
                  marginTop: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                {["Create agent", "Attach number", "Test call"].map((s, i) => (
                  <div
                    key={s}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {i < 2 ? (
                      <CheckCircle2 size={10} color={d.palette.success} />
                    ) : (
                      <div
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: "50%",
                          border: `1.5px solid ${d.palette.border}`,
                        }}
                      />
                    )}
                    <span style={{ fontSize: 10 }}>{s}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DenseDispatchBoard({ d }: { d: DirectionTokens }) {
  const useTight = d.id === "signal";
  const useGlass = d.id === "harbor";

  const cols = [
    { k: "Pending", n: 4, c: d.palette.warning },
    { k: "Assigned", n: 7, c: d.palette.info },
    { k: "En route", n: 3, c: d.palette.primary },
    { k: "On site", n: 5, c: d.palette.success },
  ];

  const jobs = [
    {
      id: "J-2841",
      title: "AC unit not cooling",
      pri: "urgent",
      tech: "M. Rivera",
      time: "2:15 PM",
      col: 0,
    },
    {
      id: "J-2840",
      title: "Quarterly HVAC check",
      pri: "low",
      tech: "—",
      time: "Tomorrow",
      col: 0,
    },
    {
      id: "J-2839",
      title: "Furnace install (new)",
      pri: "high",
      tech: "K. Patel",
      time: "3:30 PM",
      col: 1,
    },
    {
      id: "J-2838",
      title: "Drain clog — kitchen",
      pri: "med",
      tech: "J. Kim",
      time: "1:45 PM",
      col: 2,
    },
    {
      id: "J-2837",
      title: "Leak under sink",
      pri: "high",
      tech: "S. Davis",
      time: "12:30 PM",
      col: 3,
    },
  ];

  return (
    <div style={frame(d, 0)}>
      <div
        style={{ height: "100%", display: "flex", flexDirection: "column" }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: `1px solid ${d.palette.border}`,
            background: d.palette.surface,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Truck size={14} color={d.palette.primary} />
            <div>
              <div
                style={{
                  fontFamily: d.fontDisplay,
                  fontSize: 13,
                  fontWeight: 700,
                  letterSpacing: "-0.01em",
                }}
              >
                Dispatch board
              </div>
              <div style={{ fontSize: 9, color: d.palette.textMuted }}>
                19 active · 6 technicians on shift
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 8px",
                background: d.palette.surfaceMuted,
                border: `1px solid ${d.palette.border}`,
                borderRadius: d.radius.sm,
                fontSize: 10,
                color: d.palette.textMuted,
              }}
            >
              <Search size={10} /> Search
            </div>
            <button
              style={{
                background: d.palette.primary,
                color: d.palette.primaryOn,
                fontSize: 10,
                fontWeight: 600,
                padding: "5px 10px",
                borderRadius: d.radius.sm,
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                boxShadow: d.elevation.e1,
                border: "none",
              }}
            >
              <Plus size={10} /> New job
            </button>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 8,
            padding: 8,
            overflow: "hidden",
            background: d.palette.bg,
          }}
        >
          {cols.map((col, ci) => (
            <div
              key={col.k}
              style={{
                background: useTight ? "transparent" : d.palette.surfaceMuted,
                borderRadius: d.radius.md,
                padding: useTight ? 4 : 6,
                border: useTight ? `1px dashed ${d.palette.border}` : "none",
                display: "flex",
                flexDirection: "column",
                gap: 4,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "2px 4px 0",
                  marginBottom: 4,
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: 6 }}
                >
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: col.c,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    {col.k}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: 9,
                    padding: "2px 6px",
                    fontFamily: "ui-monospace, monospace",
                    background: d.palette.surface,
                    color: d.palette.textMuted,
                    borderRadius: d.radius.pill,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {col.n}
                </span>
              </div>
              {jobs
                .filter((j) => j.col === ci)
                .slice(0, 3)
                .map((j) => (
                  <div
                    key={j.id}
                    style={{
                      ...card(d),
                      padding: useTight ? 6 : 8,
                      boxShadow: useGlass ? d.elevation.e1 : "none",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 4,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 8,
                          fontFamily: "ui-monospace, monospace",
                          color: d.palette.textMuted,
                        }}
                      >
                        {j.id}
                      </span>
                      <span
                        style={{
                          fontSize: 8,
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                          padding: "2px 4px",
                          background:
                            j.pri === "urgent"
                              ? `${d.palette.error}1F`
                              : j.pri === "high"
                                ? `${d.palette.warning}1F`
                                : d.palette.surfaceMuted,
                          color:
                            j.pri === "urgent"
                              ? d.palette.error
                              : j.pri === "high"
                                ? d.palette.warning
                                : d.palette.textMuted,
                          borderRadius: d.radius.sm,
                        }}
                      >
                        {j.pri}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 500,
                        lineHeight: 1.4,
                        marginBottom: 4,
                      }}
                    >
                      {j.title}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        fontSize: 9,
                        color: d.palette.textMuted,
                      }}
                    >
                      <span
                        style={{
                          maxWidth: 70,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {j.tech}
                      </span>
                      <span
                        style={{
                          fontVariantNumeric: "tabular-nums",
                          fontFamily: useTight
                            ? "ui-monospace, monospace"
                            : "inherit",
                        }}
                      >
                        {j.time}
                      </span>
                    </div>
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ----------------- Token strip ----------------- */

function TokenStrip({ d }: { d: DirectionTokens }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <SectionLabel d={d}>Palette · WCAG AA pairs</SectionLabel>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(6, 1fr)",
            gap: 6,
          }}
        >
          <PaletteSwatch label="Primary" hex={d.palette.primary} textOn="#fff" />
          <PaletteSwatch
            label="Surface"
            hex={d.palette.surface}
            textOn={d.palette.text}
          />
          <PaletteSwatch
            label="Inverse"
            hex={d.palette.surfaceInverse}
            textOn="#fff"
          />
          <PaletteSwatch label="Success" hex={d.palette.success} textOn="#fff" />
          <PaletteSwatch label="Warning" hex={d.palette.warning} textOn="#fff" />
          <PaletteSwatch label="Error" hex={d.palette.error} textOn="#fff" />
        </div>
        <div
          style={{
            marginTop: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 10,
          }}
        >
          <span style={{ color: d.palette.textMuted }}>
            Dark pair: {d.paletteDark.bg} surface · {d.paletteDark.primary}{" "}
            primary
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontWeight: 500,
              color: d.palette.success,
            }}
          >
            <CheckCircle2 size={10} /> 4.5:1 verified
          </span>
        </div>
      </div>

      <div>
        <SectionLabel d={d}>Type scale · {d.fontPairingName}</SectionLabel>
        <div
          style={{
            background: d.palette.surface,
            border: `1px solid ${d.palette.border}`,
            borderRadius: d.radius.md,
            padding: 12,
          }}
        >
          <div
            style={{
              fontFamily: d.fontDisplay,
              fontSize: 24,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: "-0.02em",
            }}
          >
            Display
          </div>
          <div
            style={{
              fontFamily: d.fontDisplay,
              fontSize: 18,
              fontWeight: 600,
              lineHeight: 1.2,
              marginTop: 4,
            }}
          >
            Headline
          </div>
          <div
            style={{
              fontFamily: d.fontDisplay,
              fontSize: 14,
              fontWeight: 600,
              marginTop: 4,
            }}
          >
            Title
          </div>
          <div
            style={{
              fontFamily: d.fontBody,
              fontSize: 12,
              marginTop: 4,
              color: d.palette.textMuted,
            }}
          >
            Body — sized to {d.type.body.split(" — ")[0]}
          </div>
          <div
            style={{
              fontFamily: d.fontBody,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.06em",
              marginTop: 4,
              color: d.palette.textMuted,
              textTransform: "uppercase",
            }}
          >
            LABEL
          </div>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 8,
        }}
      >
        <div>
          <SectionLabel d={d}>Radius</SectionLabel>
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 6,
              background: d.palette.surface,
              border: `1px solid ${d.palette.border}`,
              borderRadius: d.radius.md,
              padding: 8,
              height: 72,
            }}
          >
            {(["sm", "md", "lg", "xl"] as const).map((k) => (
              <div
                key={k}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <div
                  style={{
                    background: d.palette.primary,
                    width: 24,
                    height: 24,
                    borderRadius: d.radius[k],
                  }}
                />
                <span style={{ fontSize: 8, color: d.palette.textMuted }}>
                  {d.radius[k]}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <SectionLabel d={d}>Spacing</SectionLabel>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: d.palette.surface,
              border: `1px solid ${d.palette.border}`,
              borderRadius: d.radius.md,
              padding: 8,
              height: 72,
            }}
          >
            {([1, 2, 3, 4, 5] as const).map((k) => (
              <div
                key={k}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <div
                  style={{
                    background: d.palette.text,
                    width: d.spacing[k],
                    height: 32,
                    borderRadius: 1,
                  }}
                />
                <span style={{ fontSize: 8, color: d.palette.textMuted }}>
                  {d.spacing[k]}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <SectionLabel d={d}>Elevation</SectionLabel>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-around",
              background: d.palette.bg,
              borderRadius: d.radius.md,
              padding: 8,
              height: 72,
            }}
          >
            {(["e1", "e2", "e3"] as const).map((k) => (
              <div
                key={k}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <div
                  style={{
                    background: d.palette.surface,
                    width: 26,
                    height: 26,
                    borderRadius: d.radius.sm,
                    boxShadow: d.elevation[k],
                  }}
                />
                <span style={{ fontSize: 8, color: d.palette.textMuted }}>
                  {k}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div>
        <SectionLabel d={d}>Motion</SectionLabel>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 10,
            fontFamily: "ui-monospace, monospace",
            background: d.palette.surface,
            border: `1px solid ${d.palette.border}`,
            borderRadius: d.radius.md,
            padding: "6px 8px",
            color: d.palette.textMuted,
          }}
        >
          <span>fast {d.motion.fast}</span>
          <span>·</span>
          <span>base {d.motion.base}</span>
          <span>·</span>
          <span>slow {d.motion.slow}</span>
          <span>·</span>
          <span style={{ color: d.palette.text }}>{d.motion.easing}</span>
        </div>
      </div>
    </div>
  );
}

function DirectionColumn({
  d,
  index,
}: {
  d: DirectionTokens;
  index: number;
}) {
  return (
    <section
      style={{
        background: "#FFFFFF",
        borderRadius: 18,
        border: "1px solid #E5E9EE",
        boxShadow: "0 8px 30px rgba(15,26,36,.04)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "20px 22px 16px",
          borderBottom: "1px solid #EEF2F6",
          background: `linear-gradient(180deg, ${d.palette.surface} 0%, ${d.palette.surfaceMuted} 100%)`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.1em",
              color: d.palette.primary,
              textTransform: "uppercase",
            }}
          >
            Direction {String.fromCharCode(65 + index)}
          </span>
          <span
            style={{
              fontSize: 10,
              color: d.palette.textMuted,
              fontWeight: 500,
            }}
          >
            · {d.category}
          </span>
        </div>
        <h2
          style={{
            fontFamily: d.fontDisplay,
            fontWeight: 700,
            fontSize: 26,
            color: d.palette.text,
            letterSpacing: "-0.02em",
            lineHeight: 1.1,
            margin: 0,
          }}
        >
          {d.name}
        </h2>
        <p
          style={{
            fontSize: 12,
            marginTop: 8,
            lineHeight: 1.55,
            color: d.palette.textMuted,
            margin: "8px 0 0",
          }}
        >
          {d.tagline}
        </p>
      </header>

      <div
        style={{
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {[
          { l: "Marketing hero", el: <MarketingHero d={d} /> },
          { l: "Tenant dashboard", el: <TenantDashboard d={d} /> },
          { l: "Dense data · Dispatch board", el: <DenseDispatchBoard d={d} /> },
        ].map((s) => (
          <div key={s.l}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 8,
              }}
            >
              <Eye size={11} color={d.palette.textMuted} />
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: d.palette.textMuted,
                }}
              >
                {s.l}
              </span>
            </div>
            {s.el}
          </div>
        ))}
      </div>

      <div
        style={{
          padding: "16px 20px 20px",
          borderTop: "1px solid #EEF2F6",
          background: "#FAFBFC",
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            marginBottom: 12,
            color: d.palette.text,
          }}
        >
          Design tokens
        </div>
        <TokenStrip d={d} />
      </div>

      <div
        style={{
          padding: "16px 20px 20px",
          borderTop: "1px solid #EEF2F6",
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            marginBottom: 8,
            color: d.palette.text,
          }}
        >
          Why this direction
        </div>
        <p
          style={{
            fontSize: 12,
            lineHeight: 1.55,
            marginBottom: 12,
            color: d.palette.textMuted,
            margin: "0 0 12px",
          }}
        >
          {d.rationale}
        </p>
        <div style={{ display: "grid", gap: 8 }}>
          <div>
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom: 4,
                color: d.palette.success,
              }}
            >
              ✓ Best for
            </div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {d.bestFor.map((s) => (
                <li
                  key={s}
                  style={{
                    fontSize: 11,
                    display: "flex",
                    gap: 6,
                    color: d.palette.text,
                    marginBottom: 2,
                  }}
                >
                  <span style={{ color: d.palette.success }}>•</span>
                  {s}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom: 4,
                display: "flex",
                alignItems: "center",
                gap: 4,
                color: d.palette.warning,
              }}
            >
              <AlertTriangle size={9} /> Trade-offs
            </div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {d.tradeoffs.map((s) => (
                <li
                  key={s}
                  style={{
                    fontSize: 11,
                    display: "flex",
                    gap: 6,
                    color: d.palette.textMuted,
                    marginBottom: 2,
                  }}
                >
                  <span style={{ color: d.palette.warning }}>•</span>
                  {s}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function DesignDirections() {
  // Internal-only page: emit a noindex/nofollow meta tag so search
  // engines don't surface this in public results.
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    const prevTitle = document.title;
    document.title = "QVO · Design Directions (internal)";
    return () => {
      document.head.removeChild(meta);
      document.title = prevTitle;
    };
  }, []);

  return (
    <>
      <PrimitivesShowcase />
      <div
        style={{
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          background: "#F2F4F7",
          minHeight: "100vh",
          padding: "32px 24px 64px",
        }}
      >
        <div style={{ maxWidth: 1680, margin: "0 auto" }}>
        <header style={{ marginBottom: 32 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <div
              style={{
                background: "#0E2738",
                color: "#fff",
                width: 28,
                height: 28,
                borderRadius: 8,
                display: "grid",
                placeItems: "center",
              }}
            >
              <Sparkles size={14} />
            </div>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.12em",
                color: "#506575",
                textTransform: "uppercase",
              }}
            >
              QVO · Design direction lock-in
            </span>
            <span
              style={{
                marginLeft: 8,
                padding: "3px 10px",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.10em",
                color: "#C98A2E",
                background: "#F6E7CB",
                borderRadius: 999,
                textTransform: "uppercase",
              }}
              aria-label="Internal page — not for public distribution"
            >
              Internal · Frozen snapshot
            </span>
          </div>
          <h1
            style={{
              fontFamily: "Sora, ui-sans-serif, sans-serif",
              fontSize: 36,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: "#0E2738",
              lineHeight: 1.1,
              maxWidth: 900,
              margin: 0,
            }}
          >
            Three directions, three surfaces. Pick one and we'll roll it across
            every page.
          </h1>
          <p
            style={{
              color: "#506575",
              fontSize: 15,
              marginTop: 12,
              maxWidth: 760,
              lineHeight: 1.6,
            }}
          >
            Each column shows the same Marketing Hero, Tenant Dashboard, and
            Dispatch board rendered in a different visual language — plus the
            full token system (palette, typography, radius, spacing, elevation,
            motion) that drives it. All three meet our accessibility floor (4.5:1
            contrast, focus rings, reduced-motion, 44×44 touch targets, no
            color-only meaning) and all three keep the QVO brand recognizable.
          </p>
        </header>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 24,
          }}
        >
          {DIRECTIONS.map((d, i) => (
            <DirectionColumn key={d.id} d={d} index={i} />
          ))}
        </div>

        <footer
          style={{
            marginTop: 40,
            padding: 20,
            background: "#FFFFFF",
            border: "1px solid #E5E9EE",
            borderRadius: 14,
            color: "#0E2738",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div
              style={{
                background: "#0E2738",
                color: "#fff",
                width: 32,
                height: 32,
                borderRadius: 8,
                display: "grid",
                placeItems: "center",
                flexShrink: 0,
              }}
            >
              <CheckCircle2 size={16} />
            </div>
            <div>
              <div
                style={{
                  fontFamily: "Sora, ui-sans-serif, sans-serif",
                  fontSize: 16,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                }}
              >
                What happens after you pick
              </div>
              <p
                style={{
                  fontSize: 13,
                  marginTop: 4,
                  lineHeight: 1.55,
                  color: "#506575",
                  maxWidth: 880,
                }}
              >
                Reply with <strong>A (Refined Harbor)</strong>,{" "}
                <strong>B (Signal Density)</strong>, or{" "}
                <strong>C (Crisp Modern)</strong>. The chosen direction's tokens
                become the source of truth in{" "}
                <code
                  style={{
                    background: "#F2F4F7",
                    padding: "1px 6px",
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                >
                  client-app/src/index.css
                </code>{" "}
                (Tailwind v4{" "}
                <code
                  style={{
                    background: "#F2F4F7",
                    padding: "1px 6px",
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                >
                  @theme
                </code>
                ) and a typed module at{" "}
                <code
                  style={{
                    background: "#F2F4F7",
                    padding: "1px 6px",
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                >
                  client-app/src/lib/designTokens.ts
                </code>
                . A one-page design-system readme captures the rules so the
                downstream polish tasks execute against a single rubric.
              </p>
            </div>
          </div>
        </footer>
        </div>
      </div>
    </>
  );
}
