/**
 * Center waveform for the demo Tool Wheel.
 *
 * Two modes:
 *  - When `audioElement` is playing: 12 vertical bars driven by an
 *    `AnalyserNode` reading the live frequency data. 60fps via rAF.
 *  - When the audio is paused or `audioElement` is null: bars idle as a
 *    thin horizontal teal line in the middle, with a slow breathing pulse
 *    so the centerpiece never looks dead.
 *
 * Why canvas instead of SVG: 12 bars × 60fps × per-frame attribute writes
 * adds up to thousands of style-recalcs per second in the SVG path, which
 * the marketing bundle's main thread doesn't need. Canvas2D batches it
 * into one draw call.
 *
 * AudioContext is created lazily on the first connect call (Chrome refuses
 * to create one before a user gesture, so the visualizer falls back to its
 * idle state until the user clicks "play"). The context + source node are
 * created exactly once per audio element; subsequent re-renders reuse them.
 */
import { useEffect, useRef } from 'react';

interface ToolWheelWaveformProps {
  /**
   * Audio element to visualize. When null, the canvas renders its idle
   * (paused) state instead. The component owns the lifecycle of the
   * AudioContext / AnalyserNode / MediaElementSource bound to this
   * element; passing a new element disposes the prior chain.
   */
  audioElement: HTMLAudioElement | null;
  /** Diameter of the rendered canvas in px. Default 144 (fits a 320px wheel). */
  diameterPx?: number;
}

const BAR_COUNT = 12;

export function ToolWheelWaveform({ audioElement, diameterPx = 144 }: ToolWheelWaveformProps) {
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
    canvas.width = diameterPx * dpr;
    canvas.height = diameterPx * dpr;
    canvas.style.width = `${diameterPx}px`;
    canvas.style.height = `${diameterPx}px`;
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
        analyser.fftSize = 64; // 32 bins → plenty for 12 bars
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
      const w = diameterPx;
      const h = diameterPx;
      ctx2d.clearRect(0, 0, w, h);

      const playing = !!audioElement && !audioElement.paused && !audioElement.ended;
      const chain = playing ? ensureChain() : audioChainRef.current;

      let amplitudes: number[];
      if (playing && chain) {
        chain.analyser.getByteFrequencyData(chain.data);
        // Downsample the 32 frequency bins into BAR_COUNT bars by averaging
        // neighboring bins. Lower bars are the bass band (voice fundamentals),
        // upper bars are higher harmonics.
        const binsPerBar = Math.floor(chain.data.length / BAR_COUNT);
        amplitudes = Array.from({ length: BAR_COUNT }, (_, i) => {
          let sum = 0;
          for (let j = 0; j < binsPerBar; j++) sum += chain.data[i * binsPerBar + j];
          return Math.min(1, sum / binsPerBar / 200);
        });
      } else {
        // Idle: slow breathing line. amplitude pulses 0.08→0.18 every 3s.
        const elapsed = (now - lastIdleTimestamp) / 1000;
        const pulse = 0.13 + 0.05 * Math.sin((elapsed * Math.PI) / 1.5);
        amplitudes = Array.from({ length: BAR_COUNT }, () => pulse);
      }

      // Layout: bars centered horizontally + vertically. Bar width 4px,
      // gap 4px. Total bar group width = 12*4 + 11*4 = 92px.
      const barWidth = 4;
      const barGap = 4;
      const totalWidth = BAR_COUNT * barWidth + (BAR_COUNT - 1) * barGap;
      const startX = (w - totalWidth) / 2;
      const centerY = h / 2;
      const maxBarHeight = h * 0.62;

      ctx2d.fillStyle = '#2E8C83'; // Signal Teal — matches --qvo-accent
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
  }, [audioElement, diameterPx]);

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
      aria-hidden
      data-testid="tool-wheel-waveform"
    />
  );
}
