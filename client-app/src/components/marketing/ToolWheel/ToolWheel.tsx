/**
 * QVO demo Tool Wheel — the rotating hero centerpiece on /demo.
 *
 * Geometry:
 *   - 4 tool tiles around a circle, 90° apart, starting at 12 o'clock
 *     and proceeding clockwise per TOOL_ORDER.
 *   - 12 o'clock is the "active slot": when a tool fires, the ring rotates
 *     to bring that tool's tile to 12 o'clock.
 *   - Inner ring at radius `INNER_DIAMETER / 2` holds the audio waveform
 *     centerpiece.
 *
 * Animation:
 *   - Web Animations API with a `back.out`-style cubic bezier
 *     (cubic-bezier(.34, 1.56, .64, 1)) — 700ms duration, slight overshoot
 *     that lands the tile crisply at 12 o'clock.
 *   - When the wheel is idle (no active tool), a slow continuous rotation
 *     (1 full revolution per 90s) runs via CSS keyframes for that
 *     "alive but not distracting" feel. Paused the instant a tool fires.
 *
 * Accessibility:
 *   - `prefers-reduced-motion`: rotation snaps instead of spring; idle
 *     drift disabled.
 *   - Active tool change is announced via a polite `aria-live` region
 *     (the action label below the wheel).
 *   - Each tile has a `data-tool` attribute for testing + future
 *     keyboard navigation (out of scope for v1 since the wheel is
 *     presentational on the /demo page).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { TOOL_ORDER, type ScriptedTimeline, type ToolId, type WheelMode } from './types';
import { TOOL_REGISTRY } from './tool-wheel-icons';
import { ToolWheelTile } from './ToolWheelTile';
import { ToolWheelWaveform } from './ToolWheelWaveform';
import { useToolWheelTimeline } from './useToolWheelTimeline';

interface ToolWheelProps {
  /** v1 ships `scripted` and `static`; `live` reserved for v2. */
  mode: WheelMode;
  /** Required when mode === 'scripted'. */
  timeline?: ScriptedTimeline;
  /**
   * Override the wheel diameter (px). Default 360 — fits a 7-col grid cell
   * on the /demo hero at the lg breakpoint.
   */
  diameterPx?: number;
  /** className for the outer wrapper — controls margin in the parent layout. */
  className?: string;
}

const DEFAULT_DIAMETER = 360;
const WAVEFORM_DIAMETER = 160;
const TILE_RADIUS_RATIO = 0.42; // tile centers sit at this fraction of the wheel radius

/**
 * Compute the ring rotation (in degrees) that brings the given tool to
 * the active slot (12 o'clock). Returns 0 when `tool` is null (idle).
 *
 * Each tile's natural position is `index * 90°` clockwise from 12 o'clock.
 * To bring it to 12, the ring must rotate `-index * 90°`. We normalize to
 * the smallest absolute rotation each transition so the wheel always takes
 * the shortest path (eg. dispatch→calendar is +90°, not -270°).
 */
function ringRotationForTool(tool: ToolId | null, previousRotation: number): number {
  if (tool === null) return previousRotation; // hold position during idle
  const index = TOOL_ORDER.indexOf(tool);
  if (index < 0) return previousRotation;
  const naturalDeg = -index * 90;
  // Choose the rotation closest to the previous one (avoid 270° spin when
  // 90° is enough).
  const candidates = [naturalDeg, naturalDeg + 360, naturalDeg - 360];
  let best = candidates[0];
  let bestDelta = Math.abs(candidates[0] - previousRotation);
  for (const c of candidates) {
    const d = Math.abs(c - previousRotation);
    if (d < bestDelta) {
      best = c;
      bestDelta = d;
    }
  }
  return best;
}

export function ToolWheel({
  mode,
  timeline,
  diameterPx = DEFAULT_DIAMETER,
  className,
}: ToolWheelProps) {
  // The audio element is owned by the wheel so the waveform + timeline
  // driver share the same instance — passing a ref into the parent would
  // create a chicken-and-egg lifecycle problem with strict mode double-mount.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Scripted mode: timeline driver owns the activeTool state.
  // Static mode: noop driver, activeTool stays null.
  // Live mode: v2 (will be a sibling hook).
  const fallbackTimeline: ScriptedTimeline = useMemo(
    () => ({ audioUrl: '', events: [] }),
    [],
  );
  const scripted = useToolWheelTimeline({
    timeline: timeline ?? fallbackTimeline,
    audioElement,
    enabled: mode === 'scripted' && !!timeline,
  });
  const activeTool = mode === 'scripted' ? scripted.activeTool : null;
  const activeLabel = mode === 'scripted' ? scripted.activeLabel : null;

  // Track the current ring rotation so the shortest-path math works across
  // successive tool changes.
  const ringRotationRef = useRef(0);
  const [ringRotationDeg, setRingRotationDeg] = useState(0);
  const ringEl = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = useRef(false);

  useEffect(() => {
    prefersReducedMotion.current = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }, []);

  // Animate ring rotation when activeTool changes.
  useEffect(() => {
    const target = ringRotationForTool(activeTool, ringRotationRef.current);
    if (target === ringRotationRef.current) return;
    const start = ringRotationRef.current;
    ringRotationRef.current = target;

    if (prefersReducedMotion.current || !ringEl.current?.animate) {
      // Snap — no animation.
      setRingRotationDeg(target);
      return;
    }

    const anim = ringEl.current.animate(
      [{ transform: `rotate(${start}deg)` }, { transform: `rotate(${target}deg)` }],
      {
        duration: 700,
        // back.out — overshoots slightly then lands. Matches the spring
        // physics framer-motion gives by default without adding the dep.
        easing: 'cubic-bezier(.34, 1.56, .64, 1)',
        fill: 'forwards',
      },
    );
    // Sync the React state at completion so subsequent renders match the
    // committed transform (avoids a one-frame jump when the animation ends).
    anim.onfinish = () => setRingRotationDeg(target);
  }, [activeTool]);

  // Bind the audio element ref into state so child components (waveform,
  // timeline) can re-subscribe when it mounts. Without this they'd see
  // `null` on first render and never re-bind when the <audio> mounts.
  useEffect(() => {
    setAudioElement(audioRef.current);
  }, []);

  const innerRadius = diameterPx / 2;
  const tileRadius = innerRadius * TILE_RADIUS_RATIO;

  function togglePlay() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => {
        /* user-gesture issues handled by the AudioContext logic in the waveform */
      });
    } else {
      el.pause();
    }
  }

  return (
    <div className={['relative inline-flex flex-col items-center', className].filter(Boolean).join(' ')}>
      {/* Outer ambient glow — a soft teal halo that fades in when a tool is active. */}
      <div
        aria-hidden
        className={[
          'absolute -inset-12 rounded-full pointer-events-none transition-opacity duration-700',
          activeTool ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
        style={{
          background:
            'radial-gradient(closest-side, rgba(46,140,131,0.22), rgba(46,140,131,0) 70%)',
        }}
      />

      <div
        className="relative"
        style={{ width: diameterPx, height: diameterPx }}
        role="img"
        aria-label="QVO live tool wheel: as the agent runs the call, the wheel rotates to show which tool is being used."
        data-testid="tool-wheel"
      >
        {/* Faint guide circle so the geometry reads as a "dial" even when no tool is active. */}
        <div
          aria-hidden
          className="absolute inset-0 rounded-full border border-border-strong/30"
        />

        {/* The rotating ring — tiles are positioned relative to its center
            and rotate together. The Web Animation API drives `transform`
            directly so the React-state `ringRotationDeg` only acts as a
            handoff for the post-animation final position. */}
        <div
          ref={ringEl}
          className="absolute inset-0"
          style={{
            transform: `rotate(${ringRotationDeg}deg)`,
            transformOrigin: 'center',
          }}
        >
          {TOOL_ORDER.map((toolId, i) => {
            const tool = TOOL_REGISTRY[toolId];
            const positionDeg = i * 90;
            return (
              <ToolWheelTile
                key={toolId}
                tool={tool}
                active={activeTool === toolId}
                positionDeg={positionDeg}
                radiusPx={tileRadius}
                ringRotationDeg={ringRotationDeg}
              />
            );
          })}
        </div>

        {/* Center waveform — does NOT rotate with the ring. */}
        <div
          className="absolute left-1/2 top-1/2"
          style={{ transform: 'translate(-50%, -50%)' }}
        >
          <div
            className="rounded-full bg-surface border border-border-strong/40 shadow-inner flex items-center justify-center"
            style={{ width: WAVEFORM_DIAMETER, height: WAVEFORM_DIAMETER }}
          >
            <ToolWheelWaveform audioElement={audioElement} diameterPx={WAVEFORM_DIAMETER - 16} />
          </div>
        </div>
      </div>

      {/* Active label — `aria-live=polite` so screen readers announce tool changes
          without interrupting the user. */}
      <div
        aria-live="polite"
        className="mt-6 h-6 text-sm font-medium text-text-primary text-center"
        data-testid="tool-wheel-active-label"
      >
        {activeLabel ?? (isPlaying ? 'Listening…' : ' ')}
      </div>

      {/* Play / pause control — only renders when there's actually an audio file
          (scripted mode with a timeline). In static mode this is hidden so the
          wheel works as a pure presentational widget. */}
      {mode === 'scripted' && timeline?.audioUrl && (
        <>
          <audio
            ref={audioRef}
            src={timeline.audioUrl}
            preload="metadata"
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
            crossOrigin="anonymous"
          />
          <button
            type="button"
            onClick={togglePlay}
            className="mt-4 inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-on-primary text-sm font-semibold px-5 py-2.5 rounded-full transition-colors shadow-lg shadow-primary/20"
            data-testid="tool-wheel-play"
          >
            {isPlaying ? (
              <>
                <span className="block h-3 w-3 rounded-sm bg-current" aria-hidden />
                Pause demo
              </>
            ) : (
              <>
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden>
                  <path d="M3 2v12l11-6z" />
                </svg>
                Play 30-second demo
              </>
            )}
          </button>
        </>
      )}
    </div>
  );
}
