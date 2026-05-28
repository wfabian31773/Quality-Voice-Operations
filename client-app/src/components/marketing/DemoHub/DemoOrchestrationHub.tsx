/**
 * QVO Demo Orchestration Hub — the rotating-spokes hero on /demo.
 *
 * Built on top of a 4K Higgsfield render (`/hero/demo-orchestration-hub.webp`)
 * showing four product UI panels at the corners connected by glowing teal
 * X-spokes to a central audio waveform. The image is intentionally static
 * background — the LIVE feel comes from three overlaid layers:
 *
 *   1. <DemoHubSpokes>     — animated SVG paths traced over the baked
 *                            spokes. The spoke matching the currently-
 *                            active tool lights up with a teal glow
 *                            filter. Pure CSS animation, no JS lib.
 *
 *   2. <DemoHubWaveform>   — Canvas2D positioned exactly over the baked
 *                            waveform area. When the demo audio plays,
 *                            it renders live frequency bars via an
 *                            AnalyserNode. When idle, soft breathing
 *                            line so the centerpiece never reads as
 *                            dead. Blend-mode `screen` so the live bars
 *                            visually "supercharge" the static ones.
 *
 *   3. <audio> element     — owns the playback. Two modes:
 *                              scripted: useDemoTimeline subscribes to
 *                                        `timeupdate` and emits
 *                                        `setActive(tool, label)` events
 *                                        from a JSON timeline (v1 ships
 *                                        this; audio file pending Wayne).
 *                              live:     reserved for v2 — WebSocket
 *                                        from a real demo call session.
 *
 * Coordinate system: all overlay positions are in % of the 16:9 frame
 * so they scale with whatever container width the hub is rendered in.
 * Spoke endpoint positions are sourced from `SPOKE_ENDPOINTS` in
 * `DemoHubSpokes.tsx`. The waveform overlay sits at (35-65%, 40-52%)
 * matching the baked waveform's bounds in the image.
 *
 * Accessibility:
 *   - `role="img"` + descriptive aria-label on the hero
 *   - `aria-live="polite"` region below for the active tool label, so
 *     screen readers announce tool changes without interruption
 *   - `prefers-reduced-motion`: spoke glow snap-on instead of fade
 *     (handled in DemoHubSpokes via CSS media query → future polish)
 */
import { useEffect, useRef, useState } from 'react';
import { type ScriptedTimeline, type WheelMode } from './types';
import { DemoHubSpokes } from './DemoHubSpokes';
import { DemoHubWaveform } from './DemoHubWaveform';
import { useDemoTimeline } from './useDemoTimeline';

interface DemoOrchestrationHubProps {
  /** v1 ships `scripted` and `static`; `live` reserved for v2. */
  mode: WheelMode;
  /** Required when mode === 'scripted'. */
  timeline?: ScriptedTimeline;
  /** className for the outer wrapper — controls margin in the parent layout. */
  className?: string;
}

// Bounds of the baked waveform within the 16:9 hero frame, in %.
// Sampled from demo-orchestration-hub.webp.
const WAVEFORM_BOUNDS = {
  leftPct: 35,
  topPct: 40,
  widthPct: 30,
  heightPct: 12,
} as const;

export function DemoOrchestrationHub({
  mode,
  timeline,
  className,
}: DemoOrchestrationHubProps) {
  // The audio element is owned by the hub so the waveform + timeline
  // driver share the same instance. Passing a ref out would create a
  // chicken-and-egg lifecycle problem with strict-mode double-mount.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // Track the rendered hub container so we can size the canvas overlay in
  // CSS pixels (Canvas2D needs explicit width/height, not a CSS-only %).
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // Scripted mode: timeline driver owns the activeTool state.
  // Static mode: noop driver, activeTool stays null.
  // Live mode: v2 (will be a sibling hook).
  const fallbackTimeline: ScriptedTimeline = { audioUrl: '', events: [] };
  const scripted = useDemoTimeline({
    timeline: timeline ?? fallbackTimeline,
    audioElement,
    enabled: mode === 'scripted' && !!timeline,
  });
  const activeTool = mode === 'scripted' ? scripted.activeTool : null;
  const activeLabel = mode === 'scripted' ? scripted.activeLabel : null;

  // Bind the audio element ref into state so child components (waveform,
  // timeline) can re-subscribe when it mounts. Without this they'd see
  // `null` on first render and never re-bind when the <audio> mounts.
  useEffect(() => {
    setAudioElement(audioRef.current);
  }, []);

  // Measure container width so we can size the overlay canvas in px. Use
  // ResizeObserver so we recompute when the viewport changes (mobile
  // landscape rotation, browser zoom, etc.).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 16:9 frame: height is width / (16/9) = width * 0.5625.
  const containerHeight = containerWidth * 0.5625;
  const waveformWidthPx = (containerWidth * WAVEFORM_BOUNDS.widthPct) / 100;
  const waveformHeightPx = (containerHeight * WAVEFORM_BOUNDS.heightPct) / 100;

  function togglePlay() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => {
        // The AudioContext-create-after-gesture rule means this can fail
        // on some browsers; we surface it as a console message rather
        // than crashing the page.
      });
    } else {
      el.pause();
    }
  }

  return (
    <div className={['flex flex-col items-center w-full', className].filter(Boolean).join(' ')}>
      <div
        ref={containerRef}
        className="relative w-full aspect-[16/9] rounded-2xl overflow-hidden shadow-2xl shadow-black/40 ring-1 ring-white/5"
        role="img"
        aria-label="QVO live orchestration hub: as the agent runs a call, glowing spokes light up to show which tool is firing right now — SMS, calendar, dispatch, or ticket."
        data-testid="demo-orchestration-hub"
      >
        {/* Background: the 4K hero render. <picture> serves the lighter
            1920px WebP to viewports under 1920px (most laptops + all
            mobile), the full 4K only to retina + 4K displays. */}
        <picture>
          <source
            srcSet="/hero/demo-orchestration-hub-1920.webp 1920w, /hero/demo-orchestration-hub.webp 5504w"
            sizes="(max-width: 1920px) 100vw, 5504px"
            type="image/webp"
          />
          <img
            src="/hero/demo-orchestration-hub-1920.webp"
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            loading="eager"
            decoding="async"
            fetchPriority="high"
          />
        </picture>

        {/* Spoke overlay — pointer-events none so panels remain inert. */}
        <DemoHubSpokes activeTool={activeTool} />

        {/* Waveform overlay positioned over the baked waveform area. */}
        {containerWidth > 0 && (
          <div
            className="absolute pointer-events-none flex items-center justify-center"
            style={{
              left: `${WAVEFORM_BOUNDS.leftPct}%`,
              top: `${WAVEFORM_BOUNDS.topPct}%`,
              width: `${WAVEFORM_BOUNDS.widthPct}%`,
              height: `${WAVEFORM_BOUNDS.heightPct}%`,
            }}
          >
            <DemoHubWaveform
              audioElement={audioElement}
              widthPx={Math.max(1, Math.floor(waveformWidthPx))}
              heightPx={Math.max(1, Math.floor(waveformHeightPx))}
            />
          </div>
        )}
      </div>

      {/* Active label — `aria-live=polite` so screen readers announce tool
          changes without interrupting the user. Reserves vertical space
          via h-6 so the layout doesn't jump when text appears/disappears. */}
      <div
        aria-live="polite"
        className="mt-5 h-6 text-sm font-medium text-text-primary text-center"
        data-testid="demo-hub-active-label"
      >
        {activeLabel ?? (isPlaying ? 'Listening…' : ' ')}
      </div>

      {/* Play / pause control. Only renders when there's actually an audio
          file (scripted mode with a timeline that has an audioUrl). In
          static mode or scripted mode with a placeholder timeline, this
          stays hidden so the hub works as a presentational widget. */}
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
            data-testid="demo-hub-play"
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
