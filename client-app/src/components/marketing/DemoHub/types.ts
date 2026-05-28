/**
 * Shared types for the /demo Tool Wheel hero.
 *
 * The wheel surfaces four representative voice-agent tools — SMS, Calendar,
 * Ticket, Dispatch — around a center audio waveform. When the agent invokes
 * a tool during a demo, the ring rotates to bring that tool's tile to the
 * active slot (12 o'clock).
 *
 * v1 ships with `mode='scripted'` only — a JSON timeline tied to a
 * pre-recorded demo audio file. `mode='live'` is reserved for v2 when the
 * voice gateway exposes a per-session event stream and the demo number is
 * wired through.
 */

/**
 * Canonical tool identifier. Adding a fifth tool requires extending this
 * union AND adding the matching `ToolDefinition` to `TOOL_REGISTRY`
 * (`tool-wheel-icons.tsx`) — the geometry assumes the count maps cleanly
 * to a regular polygon. v1 uses 4 (90° spacing).
 */
export type ToolId = 'sms' | 'calendar' | 'ticket' | 'dispatch';

/**
 * The four tools in canonical clockwise order starting from 12 o'clock.
 * Defining this once (rather than recomputing across components) ensures
 * the tile positions, timeline driver lookup, and rotation math all agree.
 */
export const TOOL_ORDER: ReadonlyArray<ToolId> = ['calendar', 'sms', 'dispatch', 'ticket'] as const;

/**
 * One event in a scripted demo timeline. `at` is seconds into the demo
 * audio when the agent invokes the tool. `durationMs` is how long the
 * active glow persists before the wheel returns to idle (drift) state;
 * default is 1500ms.
 */
export interface ScriptedTimelineEvent {
  at: number;
  tool: ToolId;
  label: string;
  durationMs?: number;
}

export interface ScriptedTimeline {
  audioUrl: string;
  events: ReadonlyArray<ScriptedTimelineEvent>;
}

/**
 * Internal wheel state — what tool (if any) is currently active and what
 * label to show beneath it. `null` means idle (no active glow, slow drift
 * animation runs).
 */
export interface WheelState {
  activeTool: ToolId | null;
  activeLabel: string | null;
}

/**
 * Mode controls which driver hook owns `WheelState`.
 *  - `scripted`: timeline + audio element drives the wheel
 *  - `live`: WebSocket from a real demo call session (v2)
 *  - `static`: no driver — useful for storybook / smoke tests
 */
export type WheelMode = 'scripted' | 'live' | 'static';
