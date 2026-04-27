import type { CSSProperties } from "react";
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
} from "lucide-react";
import type { DirectionTokens } from "./_qvoShared";

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

/* ----------------------------------------------------------------- */
/* MARKETING HERO                                                     */
/* ----------------------------------------------------------------- */
export function MarketingHero({ d }: { d: DirectionTokens }) {
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
        <div className="relative h-full flex flex-col justify-between p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
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
            <div className="flex items-center gap-3 text-[10px] opacity-70">
              <span>Product</span>
              <span>Pricing</span>
              <span>Demo</span>
            </div>
          </div>

          <div className="space-y-3">
            <div
              className="inline-flex items-center gap-1.5 text-[9px] font-medium px-2 py-1"
              style={{
                background: `${d.palette.primary}26`,
                color: "#7DD9CC",
                borderRadius: d.radius.pill,
                border: `1px solid ${d.palette.primary}40`,
              }}
            >
              <span
                className="w-1 h-1 rounded-full"
                style={{ background: d.palette.primary }}
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
              className="text-[11px] leading-relaxed opacity-70"
              style={{ maxWidth: 260 }}
            >
              Deploy intelligent voice agents that answer calls, book
              appointments, and dispatch technicians — 24/7.
            </p>
            <div className="flex gap-2">
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

          <div className="grid grid-cols-3 gap-2">
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
                <div className="text-[9px] opacity-50">{s.l}</div>
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
        <div className="h-full flex flex-col p-5">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
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
              className="flex items-center gap-4 text-[10px]"
              style={{ color: d.palette.textMuted }}
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
            className="text-[9px] uppercase tracking-[0.12em] mb-3"
            style={{ color: d.palette.textMuted }}
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
            className="text-[11px] leading-relaxed mt-3"
            style={{ color: d.palette.textMuted, maxWidth: 280 }}
          >
            Voice agents, dispatch, scheduling, and analytics — built for teams
            that ship. No black boxes.
          </p>

          <div className="flex gap-2 mt-4">
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
            className="mt-auto pt-4 grid grid-cols-4 gap-3 border-t"
            style={{ borderColor: d.palette.border }}
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
                  className="text-[9px] uppercase tracking-wider mt-0.5"
                  style={{ color: d.palette.textMuted }}
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
      <div className="h-full flex flex-col p-5">
        <div
          className="flex items-center justify-between pb-4 border-b mb-5"
          style={{ borderColor: d.palette.border }}
        >
          <div className="flex items-center gap-2">
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
            }}
          >
            Start free trial
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4 flex-1">
          <div className="flex flex-col justify-center">
            <div
              className="inline-flex items-center gap-1 text-[9px] font-semibold mb-2 px-2 py-0.5"
              style={{
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
              className="text-[11px] mt-2 leading-relaxed"
              style={{ color: d.palette.textMuted }}
            >
              Answer every call. Book every appointment. Track every outcome.
            </p>
            <div className="flex gap-2 mt-3">
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
              className="flex items-center justify-between text-[10px] mb-2"
              style={{ color: d.palette.textMuted }}
            >
              <span className="flex items-center gap-1">
                <PhoneIncoming size={10} color={d.palette.success} />
                Live call · 02:14
              </span>
              <Wifi size={10} color={d.palette.success} />
            </div>
            <div className="space-y-1.5">
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
                    className="text-[8px] font-semibold uppercase tracking-wider"
                    style={{
                      color: m.primary
                        ? d.palette.primary
                        : d.palette.textMuted,
                    }}
                  >
                    {m.who}
                  </div>
                  <div className="text-[10px] mt-0.5">{m.t}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* TENANT DASHBOARD                                                   */
/* ----------------------------------------------------------------- */
export function TenantDashboard({ d }: { d: DirectionTokens }) {
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
      <div className="h-full flex">
        {/* Sidebar */}
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
          <div className="flex items-center gap-1.5 mb-3">
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

        {/* Content */}
        <div className="flex-1 p-4 overflow-hidden">
          <div className="flex items-center justify-between mb-3">
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
              <div
                className="text-[10px]"
                style={{ color: d.palette.textMuted }}
              >
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
                boxShadow: useGlass ? `0 4px 12px ${d.palette.primary}30` : d.elevation.e1,
              }}
            >
              <Plus size={10} /> New agent
            </button>
          </div>

          <div className="grid grid-cols-4 gap-2 mb-3">
            {stats.map((s) => (
              <div
                key={s.l}
                style={{
                  ...card(d),
                  padding: useTight ? 8 : 10,
                  boxShadow: useGlass ? d.elevation.e1 : d.elevation.e1,
                }}
              >
                <div className="flex items-center justify-between mb-1">
                  <s.icon size={11} color={d.palette.primary} />
                  {s.t && (
                    <span
                      className="text-[8px] font-semibold"
                      style={{ color: d.palette.success }}
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
                  className="text-[9px] uppercase tracking-wider"
                  style={{ color: d.palette.textMuted }}
                >
                  {s.l}
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-2 flex-1">
            <div
              style={{
                ...card(d),
                gridColumn: "span 2",
                padding: 10,
              }}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] font-semibold">
                  Recent conversations
                </div>
                <span
                  className="text-[9px]"
                  style={{ color: d.palette.primary }}
                >
                  View all →
                </span>
              </div>
              <div className="space-y-1">
                {[
                  { name: "Marcus Chen", agent: "Front Desk", s: "completed" },
                  { name: "+1 (415) 555-0142", agent: "Sales", s: "live" },
                  { name: "Sarah Park", agent: "Support", s: "completed" },
                  { name: "+1 (628) 555-0177", agent: "Front Desk", s: "completed" },
                ].map((c, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between"
                    style={{
                      padding: useTight ? "3px 4px" : "4px 6px",
                      borderRadius: d.radius.sm,
                      background:
                        i % 2 && useTight ? d.palette.surfaceMuted : "transparent",
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      <PhoneIncoming size={9} color={d.palette.textMuted} />
                      <span className="text-[10px] font-medium">{c.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[9px]"
                        style={{ color: d.palette.textMuted }}
                      >
                        {c.agent}
                      </span>
                      <span
                        className="text-[8px] font-semibold px-1.5 py-0.5"
                        style={{
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
                className="text-[9px] mt-1 leading-relaxed"
                style={{ color: d.palette.textMuted }}
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
              <div className="mt-3 space-y-1">
                {["Create agent", "Attach number", "Test call"].map((s, i) => (
                  <div key={s} className="flex items-center gap-1.5">
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
                    <span className="text-[10px]">{s}</span>
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

/* ----------------------------------------------------------------- */
/* DENSE DATA SURFACE — DISPATCH BOARD                                */
/* ----------------------------------------------------------------- */
export function DenseDispatchBoard({ d }: { d: DirectionTokens }) {
  const useTight = d.id === "signal";
  const useGlass = d.id === "harbor";

  const cols = [
    { k: "Pending", n: 4, c: d.palette.warning },
    { k: "Assigned", n: 7, c: d.palette.info },
    { k: "En route", n: 3, c: d.palette.primary },
    { k: "On site", n: 5, c: d.palette.success },
  ];

  const jobs = [
    { id: "J-2841", title: "AC unit not cooling", pri: "urgent", tech: "M. Rivera", time: "2:15 PM", addr: "1242 Oak St", col: 0 },
    { id: "J-2840", title: "Quarterly HVAC check", pri: "low", tech: "—", time: "Tomorrow", addr: "55 Pine Ave", col: 0 },
    { id: "J-2839", title: "Furnace install (new)", pri: "high", tech: "K. Patel", time: "3:30 PM", addr: "881 Cedar Ln", col: 1 },
    { id: "J-2838", title: "Drain clog — kitchen", pri: "med", tech: "J. Kim", time: "1:45 PM", addr: "2010 Elm Dr", col: 2 },
    { id: "J-2837", title: "Leak under sink", pri: "high", tech: "S. Davis", time: "12:30 PM", addr: "440 Birch Rd", col: 3 },
  ];

  return (
    <div style={frame(d, 0)}>
      <div className="h-full flex flex-col">
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b"
          style={{ borderColor: d.palette.border, background: d.palette.surface }}
        >
          <div className="flex items-center gap-2">
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
              <div
                className="text-[9px]"
                style={{ color: d.palette.textMuted }}
              >
                19 active · 6 technicians on shift
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-1.5 px-2 py-1"
              style={{
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
              }}
            >
              <Plus size={10} /> New job
            </button>
          </div>
        </div>

        {/* Kanban */}
        <div
          className="flex-1 grid grid-cols-4 gap-2 p-2 overflow-hidden"
          style={{ background: d.palette.bg }}
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
                className="flex items-center justify-between px-1 mb-1"
                style={{ paddingTop: 2 }}
              >
                <div className="flex items-center gap-1.5">
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: col.c,
                    }}
                  />
                  <span
                    className="text-[10px] font-semibold uppercase tracking-wider"
                    style={{ color: d.palette.text }}
                  >
                    {col.k}
                  </span>
                </div>
                <span
                  className="text-[9px] px-1.5 py-0.5 font-mono"
                  style={{
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
                    <div className="flex items-center justify-between mb-1">
                      <span
                        className="text-[8px] font-mono"
                        style={{
                          color: d.palette.textMuted,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {j.id}
                      </span>
                      <span
                        className="text-[8px] font-semibold uppercase tracking-wider px-1 py-0.5"
                        style={{
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
                      className="text-[10px] font-medium leading-snug mb-1"
                      style={{ color: d.palette.text }}
                    >
                      {j.title}
                    </div>
                    <div
                      className="flex items-center justify-between text-[9px]"
                      style={{ color: d.palette.textMuted }}
                    >
                      <span className="truncate" style={{ maxWidth: 70 }}>
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
