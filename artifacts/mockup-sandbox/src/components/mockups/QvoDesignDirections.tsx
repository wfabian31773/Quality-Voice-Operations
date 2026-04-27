import {
  DIRECTIONS,
  PaletteSwatch,
  SectionLabel,
  type DirectionTokens,
} from "./_qvoShared";
import {
  MarketingHero,
  TenantDashboard,
  DenseDispatchBoard,
} from "./_qvoSurfaces";
import { Sparkles, Eye, CheckCircle2, AlertTriangle } from "lucide-react";

function TokenStrip({ d }: { d: DirectionTokens }) {
  return (
    <div className="space-y-3">
      {/* Palette */}
      <div>
        <SectionLabel d={d}>Palette · WCAG AA pairs</SectionLabel>
        <div className="grid grid-cols-6 gap-1.5">
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
        <div className="mt-1 flex items-center justify-between text-[10px]">
          <span style={{ color: d.palette.textMuted }}>
            Dark pair: {d.paletteDark.bg} surface · {d.paletteDark.primary}{" "}
            primary
          </span>
          <span
            className="inline-flex items-center gap-1 font-medium"
            style={{ color: d.palette.success }}
          >
            <CheckCircle2 size={10} /> 4.5:1 verified
          </span>
        </div>
      </div>

      {/* Type scale */}
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

      {/* Radius + spacing + elevation row */}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <SectionLabel d={d}>Radius</SectionLabel>
          <div
            className="flex items-end gap-1.5"
            style={{
              background: d.palette.surface,
              border: `1px solid ${d.palette.border}`,
              borderRadius: d.radius.md,
              padding: 8,
              height: 72,
            }}
          >
            {(["sm", "md", "lg", "xl"] as const).map((k) => (
              <div key={k} className="flex flex-col items-center gap-1">
                <div
                  style={{
                    background: d.palette.primary,
                    width: 24,
                    height: 24,
                    borderRadius: d.radius[k],
                  }}
                />
                <span
                  className="text-[8px]"
                  style={{ color: d.palette.textMuted }}
                >
                  {d.radius[k]}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <SectionLabel d={d}>Spacing</SectionLabel>
          <div
            className="flex items-center gap-1"
            style={{
              background: d.palette.surface,
              border: `1px solid ${d.palette.border}`,
              borderRadius: d.radius.md,
              padding: 8,
              height: 72,
            }}
          >
            {([1, 2, 3, 4, 5] as const).map((k) => (
              <div key={k} className="flex flex-col items-center gap-1">
                <div
                  style={{
                    background: d.palette.text,
                    width: d.spacing[k],
                    height: 32,
                    borderRadius: 1,
                  }}
                />
                <span
                  className="text-[8px]"
                  style={{ color: d.palette.textMuted }}
                >
                  {d.spacing[k]}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <SectionLabel d={d}>Elevation</SectionLabel>
          <div
            className="flex items-center justify-around"
            style={{
              background: d.palette.bg,
              borderRadius: d.radius.md,
              padding: 8,
              height: 72,
            }}
          >
            {(["e1", "e2", "e3"] as const).map((k) => (
              <div key={k} className="flex flex-col items-center gap-1">
                <div
                  style={{
                    background: d.palette.surface,
                    width: 26,
                    height: 26,
                    borderRadius: d.radius.sm,
                    boxShadow: d.elevation[k],
                  }}
                />
                <span
                  className="text-[8px]"
                  style={{ color: d.palette.textMuted }}
                >
                  {k}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Motion */}
      <div>
        <SectionLabel d={d}>Motion</SectionLabel>
        <div
          className="flex items-center gap-2 text-[10px] font-mono"
          style={{
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
      {/* Header */}
      <header
        style={{
          padding: "20px 22px 16px",
          borderBottom: "1px solid #EEF2F6",
          background: `linear-gradient(180deg, ${d.palette.surface} 0%, ${d.palette.surfaceMuted} 100%)`,
        }}
      >
        <div className="flex items-center gap-2 mb-2">
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
          }}
        >
          {d.name}
        </h2>
        <p
          className="text-[12px] mt-2 leading-relaxed"
          style={{ color: d.palette.textMuted }}
        >
          {d.tagline}
        </p>
      </header>

      {/* Surfaces */}
      <div className="p-5 space-y-4">
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Eye size={11} color={d.palette.textMuted} />
            <span
              className="text-[10px] font-semibold uppercase tracking-[0.08em]"
              style={{ color: d.palette.textMuted }}
            >
              Marketing hero
            </span>
          </div>
          <MarketingHero d={d} />
        </div>

        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Eye size={11} color={d.palette.textMuted} />
            <span
              className="text-[10px] font-semibold uppercase tracking-[0.08em]"
              style={{ color: d.palette.textMuted }}
            >
              Tenant dashboard
            </span>
          </div>
          <TenantDashboard d={d} />
        </div>

        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Eye size={11} color={d.palette.textMuted} />
            <span
              className="text-[10px] font-semibold uppercase tracking-[0.08em]"
              style={{ color: d.palette.textMuted }}
            >
              Dense data · Dispatch board
            </span>
          </div>
          <DenseDispatchBoard d={d} />
        </div>
      </div>

      {/* Tokens */}
      <div
        style={{
          padding: "16px 20px 20px",
          borderTop: "1px solid #EEF2F6",
          background: "#FAFBFC",
        }}
      >
        <div
          className="text-[10px] font-bold uppercase tracking-[0.1em] mb-3"
          style={{ color: d.palette.text }}
        >
          Design tokens
        </div>
        <TokenStrip d={d} />
      </div>

      {/* Rationale */}
      <div
        style={{
          padding: "16px 20px 20px",
          borderTop: "1px solid #EEF2F6",
        }}
      >
        <div
          className="text-[10px] font-bold uppercase tracking-[0.1em] mb-2"
          style={{ color: d.palette.text }}
        >
          Why this direction
        </div>
        <p
          className="text-[12px] leading-relaxed mb-3"
          style={{ color: d.palette.textMuted }}
        >
          {d.rationale}
        </p>
        <div className="grid grid-cols-1 gap-2">
          <div>
            <div
              className="text-[10px] font-semibold uppercase tracking-wider mb-1"
              style={{ color: d.palette.success }}
            >
              ✓ Best for
            </div>
            <ul className="space-y-0.5">
              {d.bestFor.map((s) => (
                <li
                  key={s}
                  className="text-[11px] flex items-start gap-1.5"
                  style={{ color: d.palette.text }}
                >
                  <span style={{ color: d.palette.success }}>•</span>
                  {s}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div
              className="text-[10px] font-semibold uppercase tracking-wider mb-1 flex items-center gap-1"
              style={{ color: d.palette.warning }}
            >
              <AlertTriangle size={9} /> Trade-offs
            </div>
            <ul className="space-y-0.5">
              {d.tradeoffs.map((s) => (
                <li
                  key={s}
                  className="text-[11px] flex items-start gap-1.5"
                  style={{ color: d.palette.textMuted }}
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

export default function QvoDesignDirections() {
  return (
    <div
      style={{
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        background: "#F2F4F7",
        minHeight: "100vh",
        padding: "32px 24px 64px",
      }}
    >
      <div style={{ maxWidth: 1680, margin: "0 auto" }}>
        {/* Page header */}
        <header className="mb-8">
          <div className="flex items-center gap-2 mb-3">
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

        {/* Comparison grid */}
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

        {/* Footer note */}
        <footer
          className="mt-10 p-5"
          style={{
            background: "#FFFFFF",
            border: "1px solid #E5E9EE",
            borderRadius: 14,
            color: "#0E2738",
          }}
        >
          <div className="flex items-start gap-3">
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
                className="text-[13px] mt-1 leading-relaxed"
                style={{ color: "#506575", maxWidth: 880 }}
              >
                The chosen direction's tokens become the source of truth in{" "}
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
                . A one-page design-system readme captures the rules so the next
                two tasks (in-app polish, marketing polish) execute against a
                single rubric. No production page is restyled until you confirm.
              </p>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
