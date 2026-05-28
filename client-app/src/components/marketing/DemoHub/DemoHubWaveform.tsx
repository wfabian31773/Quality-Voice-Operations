/**
 * Live audio waveform overlay positioned over the baked waveform area of
 * the hub hero image. Two states:
 *
 *   - audio playing: 24 thin vertical bars driven by an `AnalyserNode`
 *     reading live frequency data, 60fps via rAF, Signal Teal (#2E8C83).
 *   - audio paused / null:  bars idle as a soft horizontal teal line
 *     with a slow breathing pulse — so the overlay matches the static
 *     baked waveform and the centerpiece never reads as "broken."
 *
 * Why canvas instead of SVG: 24 bars × 60fps × per-frame attribute writes
 * adds up to thousands of style-recalcs per second in the SVG path, which
 * the marketing bundle's main thread doesn't need. Canvas2D batches it
 * into one draw call.
 *
 * AudioContext is created lazily on the first connect call (Chrome refuses
 * to create one before a user gesture, so the visualizer falls back to its
 * idle state until the user clicks "play"). The context + source node are
 * created exactly once per audio element; subsequent re-renders reuse them.
 *
 * The canvas blend-mode is `screen` so the live bars add to the baked
 * image rather than replacing it — when audio plays, the static waveform
 * appears to "come alive" rather than being covered by an overlay.
 */
import { useEffect, useRef } from 'react';

interface DemoHubWaveformProps {
  /**
   * Audio element to visualize. When null, the canvas renders its idle
   * (paused) state instead. The component owns the lifecycle of the
   * AudioContext / AnalyserNode / MediaElementSource bound to this
   * element; passing a new element disposes the prior chain.
   */
  audioElement: HTMLAudioElement | null;
  /** Rendered canvas width in CSS pixels. */
  widthPx: number;
  /** Rendered canvas height in CSS pixels. */
  heightPx: number;
}

const BAR_COUNT = 24;
const TEAL = '#2E8C83'; // matches --qvo-accent / Signal Teal

export function DemoHubWaveform({ audioElement, widthPx, heightPx }: DemoHubWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  // The AudioContext + source node have to outlive React re-renders, so we
  // park them in refs keyed by the element identity. createMediaElement-
  // Source can only be called once per element per context, so re-creating
  // the chain on rerender throws.
  const audioChainRef = useRef<{
    element: HTMLAudioElement;
    ctx: AudioContext;
    analyser: AnalyserNode;
    data: Uint8Array<ArrayBuffer>;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    // Account for device pixel ratio so bars stay sharp on retina screens.
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = widthPx * dpr;
    canvas.height = heightPx * dpr;
    canvas.style.width = `${widthPx}px`;
    canvas.style.height = `${heightPx}px`;
    ctx2d.scale(dpr, dpr);

    // Tear down the prior audio chain if the element changed.
    if (audioChainRef.current && audioChainRef.current.element !== audioElement) {
      try {
        audioChainRef.current.ctx.close().catch(() => {});
      } catch {
        // ignore — closing an already-closed context throws on some browsers
      }
      audioChainRef.current = null;
    }

    // Build the chain lazily on the first frame after a `play()` — Chrome
    // forbids creating an AudioContext before a user gesture, so we wait
    // until the element is actually producing sound.
    function ensureChain(): typeof audioChainRef.current {
      if (!audioElement || audioChainRef.current) return audioChainRef.current;
      try {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AC) return null;
        const ctx = new AC();
        const source = ctx.createMediaElementSource(audioElement);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 128; // 64 bins → comfortable downsample to BAR_COUNT
        source.connect(analyser);
        analyser.connect(ctx.destination);
        // Explicit ArrayBuffer (not the default ArrayBufferLike) so the
        // type matches AnalyserNode.getByteFrequencyData under TS 5.7+.
        const data = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
        audioChainRef.current = { element: audioElement, ctx, analyser, data };
        return audioChainRef.current;
      } catch {
        // createMediaElementSource throws if the element already has a
        // source connected (e.g. a previous mount that didn't clean up).
        // Fall back to idle visuals — better than crashing the page.
        return null;
      }
    }

    let lastIdleTimestamp = performance.now();

    function draw(now: number) {
      if (!canvas || !ctx2d) return;
      const w = widthPx;
      const h = heightPx;
      ctx2d.clearRect(0, 0, w, h);

      const playing = !!audioElement && !audioElement.paused && !audioElement.ended;
      const chain = playing ? ensureChain() : audioChainRef.current;

      let amplitudes: number[];
      if (playing && chain) {
        chain.analyser.getByteFrequencyData(chain.data);
        // Downsample the frequency bins into BAR_COUNT bars by averaging
        // neighboring bins. Lower bars are the bass band (voice
        // fundamentals), upper bars are higher harmonics. Voice frequencies
        // sit mostly in the low-mid range, so the bars in the center of
        // the visualizer carry most of the motion — which matches what the
        // baked waveform shows in the image.
        const binsPerBar = Math.floor(chain.data.length / BAR_COUNT);
        amplitudes = Array.from({ length: BAR_COUNT }, (_, i) => {
          let sum = 0;
          for (let j = 0; j < binsPerBar; j++) sum += chain.data[i * binsPerBar + j];
          return Math.min(1, sum / binsPerBar / 200);
        });
      } else {
        // Idle: soft horizontal line with a slow breathing pulse so the
        // overlay still has presence even when no audio is playing.
        // Amplitude oscillates 0.06 → 0.16 every ~2s. Center bars sit
        // a touch taller than the edges (a flat bias toward bell-shape)
        // to match the baked waveform's natural shape.
        const elapsed = (now - lastIdleTimestamp) / 1000;
        const pulse = 0.11 + 0.05 * Math.sin((elapsed * Math.PI) / 1.0);
        amplitudes = Array.from({ length: BAR_COUNT }, (_, i) => {
          // bell curve bias: more amplitude in the middle bars
          const centerness = 1 - Math.abs(i - BAR_COUNT / 2) / (BAR_COUNT / 2);
          return pulse * (0.6 + 0.4 * centerness);
        });
      }

      // Layout: bars centered horizontally + vertically.
      // Bar width 3px, gap 3px → group width = 24*3 + 23*3 = 141px.
      const barWidth = 3;
      const barGap = 3;
      const totalWidth = BAR_COUNT * barWidth + (BAR_COUNT - 1) * barGap;
      const startX = (w - totalWidth) / 2;
      const centerY = h / 2;
      const maxBarHeight = h * 0.78;

      ctx2d.fillStyle = TEAL;
      for (let i = 0; i < BAR_COUNT; i++) {
        const amp = amplitudes[i];
        const barHeight = Math.max(2, amp * maxBarHeight);
        const x = startX + i * (barWidth + barGap);
        const y = centerY - barHeight / 2;
        // Rounded-rect bars: matches the rest of the brand's softened geometry.
        const r = barWidth / 2;
        ctx2d.beginPath();
        ctx2d.moveTo(x + r, y);
        ctx2d.lineTo(x + barWidth - r, y);
        ctx2d.quadraticCurveTo(x + barWidth, y, x + barWidth, y + r);
        ctx2d.lineTo(x + barWidth, y + barHeight - r);
        ctx2d.quadraticCurveTo(x + barWidth, y + barHeight, x + barWidth - r, y + barHeight);
        ctx2d.lineTo(x + r, y + barHeight);
        ctx2d.quadraticCurveTo(x, y + barHeight, x, y + barHeight - r);
        ctx2d.lineTo(x, y + r);
        ctx2d.quadraticCurveTo(x, y, x + r, y);
        ctx2d.closePath();
        ctx2d.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    }
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [audioElement, widthPx, heightPx]);

  // Tear down the AudioContext on unmount so the underlying audio node is
  // released — leaks here are user-perceptible (chrome shows a "still
  // playing" tab indicator after navigation away).
  useEffect(() => {
    return () => {
      if (audioChainRef.current) {
        try {
          audioChainRef.current.ctx.close().catch(() => {});
        } catch {
          // ignore
        }
        audioChainRef.current = null;
      }
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="block"
      style={{ mixBlendMode: 'screen' }}
      aria-hidden
      data-testid="demo-hub-waveform"
    />
  );
}
