/**
 * QVO Demo Orchestration Hub — the rotating-spokes hero on /demo.
 *
 * Built on top of a Seedance 2.0 video render
 * (`/hero/demo-orchestration-hub.mp4`) showing four product UI panels
 * at the corners connected by glowing teal X-spokes to a central audio
 * waveform. The video handles ALL motion:
 *   - center waveform pulses continuously
 *   - four spokes light up sequentially in a clockwise cycle
 *   - QVO wordmark stays static
 *   - seamlessly loops
 *
 * The earlier attempt overlaid a Canvas waveform + SVG spokes on a still
 * image — both fought the cinematic aesthetic of the Seedance output and
 * have been removed. The video carries the visual; this component just
 * wires up playback + the optional demo-audio timeline label.
 *
 * The video is `muted autoplay loop playsinline`:
 *   - muted: required for browser autoplay (and our user-clicked demo
 *     audio plays separately through <audio>, so the video's baked-in
 *     music track must NOT play)
 *   - autoplay: the hub is the page's centerpiece — should be alive on
 *     first paint, no click required
 *   - loop: continuous ambient cycle
 *   - playsinline: prevents iOS Safari from going fullscreen
 *
 * Two driver modes for the demo audio:
 *   - scripted: useDemoTimeline subscribes to the <audio> element's
 *               `timeupdate` and emits `setActive(tool, label)` events
 *               from a JSON timeline. v1 ships this. Sage audio file
 *               pending Wayne.
 *   - live:     reserved for v2 — WebSocket from a real demo call session.
 *
 * The active-tool label below the hub is the only live data overlay —
 * when a tool fires per the scripted timeline, the label shows
 * "Sending the confirmation text" etc. The video's spoke sequence is
 * decorative ambient motion, not data-bound; the label carries the
 * "which tool fired right now" semantic.
 *
 * Accessibility:
 *   - `role="img"` + descriptive aria-label on the hero (we treat the
 *     decorative video as a single image for AT consumers)
 *   - `aria-live="polite"` region below for the active tool label, so
 *     screen readers announce tool changes without interruption
 *   - poster image (WebP fallback) shown while the video preloads or
 *     if the user has data-saver / autoplay blocked
 */
import { useEffect, useRef, useState } from 'react';
import { type ScriptedTimeline, type WheelMode } from './types';
import { useDemoTimeline } from './useDemoTimeline';

interface DemoOrchestrationHubProps {
  /** v1 ships `scripted` and `static`; `live` reserved for v2. */
  mode: WheelMode;
  /** Required when mode === 'scripted'. */
  timeline?: ScriptedTimeline;
  /** className for the outer wrapper — controls margin in the parent layout. */
  className?: string;
}

export function DemoOrchestrationHub({
  mode,
  timeline,
  className,
}: DemoOrchestrationHubProps) {
  // The demo audio element is owned by the hub so the timeline driver
  // shares the same instance. Passing a ref out would create a chicken-
  // and-egg lifecycle problem with strict-mode double-mount.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Scripted mode: timeline driver owns the activeLabel state.
  // Static mode: noop driver, activeLabel stays null.
  // Live mode: v2 (will be a sibling hook).
  const fallbackTimeline: ScriptedTimeline = { audioUrl: '', events: [] };
  const scripted = useDemoTimeline({
    timeline: timeline ?? fallbackTimeline,
    audioElement,
    enabled: mode === 'scripted' && !!timeline,
  });
  const activeLabel = mode === 'scripted' ? scripted.activeLabel : null;

  // Bind the audio element ref into state so the timeline driver can
  // re-subscribe when it mounts. Without this it sees `null` on first
  // render and never re-binds when the <audio> mounts.
  useEffect(() => {
    setAudioElement(audioRef.current);
  }, []);

  function togglePlay() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => {
        // Browsers can refuse play() outside a user gesture; the click
        // handler IS a user gesture so this rarely fires in practice.
      });
    } else {
      el.pause();
    }
  }

  return (
    <div className={['flex flex-col items-center w-full', className].filter(Boolean).join(' ')}>
      <div
        className="relative w-full aspect-[16/9] rounded-2xl overflow-hidden shadow-2xl shadow-black/40 ring-1 ring-white/5"
        role="img"
        aria-label="QVO live orchestration hub: as the agent runs a call, glowing spokes light up to show which tool is firing right now — SMS, calendar, dispatch, or ticket."
        data-testid="demo-orchestration-hub"
      >
        {/* The Seedance video is the entire visual. `poster` shows the
            WebP still while the video preloads or if the user has
            autoplay blocked. `muted autoplay loop playsinline` is the
            modern hero-video contract:
              - muted     → required for browser autoplay policy
              - autoplay  → alive on first paint
              - loop      → continuous ambient cycle
              - playsinline → prevents iOS Safari fullscreen takeover
            preload="metadata" delays the byte transfer until the user
            is close to the hero (vite/the browser handles this); we
            don't `preload="auto"` because the 5.7MB asset would compete
            with above-the-fold CSS/JS on slower connections. */}
        <video
          className="absolute inset-0 w-full h-full object-cover"
          src="/hero/demo-orchestration-hub.mp4"
          poster="/hero/demo-orchestration-hub-1920.webp"
          muted
          autoPlay
          loop
          playsInline
          preload="metadata"
          aria-hidden
        />
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

      {/* Play / pause control for the Sage demo audio. Only renders when
          there's an actual audio file (scripted mode with a timeline that
          has an audioUrl). In static mode or scripted mode with a
          placeholder timeline (audioUrl=''), this stays hidden so the
          hub works as a pure presentational widget. */}
      {mode === 'scripted' && timeline?.audioUrl && (
        <>
          <audio
            ref={audioRef}
            src={timeline.audioUrl}
            preload="metadata"
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
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
