/**
 * Scripted timeline driver for the Tool Wheel.
 *
 * Subscribes to an `HTMLAudioElement`'s `timeupdate` event and emits
 * `setActive(toolId, label)` whenever the current playback position
 * crosses one of the timeline's events. Tracks the last-fired event so
 * a single event can't fire twice during one playback, but rewinding
 * (`currentTime = 0`) correctly re-arms all events for the next play.
 *
 * Active state auto-clears after `durationMs` (default 1500ms) so the
 * wheel idles between tool calls instead of staying stuck on the last
 * one until the audio ends.
 */
import { useEffect, useRef, useState } from 'react';
import { type ScriptedTimeline, type WheelState, type ToolId } from './types';
import { TOOL_REGISTRY } from './tool-wheel-icons';

interface UseToolWheelTimelineOptions {
  timeline: ScriptedTimeline;
  audioElement: HTMLAudioElement | null;
  enabled?: boolean;
}

interface UseToolWheelTimelineResult extends WheelState {
  /**
   * Manually set the active tool. Useful when the parent wants to
   * preview the active state from a hover affordance ("hover this card
   * to see what dispatch looks like"). Pass `null` to clear.
   */
  setActiveManual: (tool: ToolId | null, label?: string) => void;
}

const DEFAULT_DURATION_MS = 1500;

export function useToolWheelTimeline({
  timeline,
  audioElement,
  enabled = true,
}: UseToolWheelTimelineOptions): UseToolWheelTimelineResult {
  const [state, setState] = useState<WheelState>({ activeTool: null, activeLabel: null });
  // Track the highest event index already fired during this playback. Reset
  // to -1 whenever currentTime jumps backwards (seek/restart).
  const lastFiredIndexRef = useRef<number>(-1);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sort events by `at` once per timeline so the scan can short-circuit.
  const sortedEvents = [...timeline.events].sort((a, b) => a.at - b.at);

  useEffect(() => {
    if (!enabled || !audioElement) return;

    let prevTime = 0;

    function handleTimeUpdate() {
      if (!audioElement) return;
      const t = audioElement.currentTime;
      // Rewind detection: drop the last-fired marker so events re-arm.
      if (t < prevTime - 0.25) {
        lastFiredIndexRef.current = -1;
      }
      prevTime = t;

      for (let i = lastFiredIndexRef.current + 1; i < sortedEvents.length; i++) {
        const ev = sortedEvents[i];
        if (ev.at > t) break;
        // Crossed this event since the last tick — fire it.
        lastFiredIndexRef.current = i;
        const label = ev.label || TOOL_REGISTRY[ev.tool].defaultActionLabel;
        setState({ activeTool: ev.tool, activeLabel: label });
        // Schedule auto-clear back to idle.
        if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
        clearTimerRef.current = setTimeout(() => {
          setState({ activeTool: null, activeLabel: null });
        }, ev.durationMs ?? DEFAULT_DURATION_MS);
      }
    }

    function handleSeeking() {
      // Aggressive reset on any seek — operator might be scrubbing.
      lastFiredIndexRef.current = -1;
      setState({ activeTool: null, activeLabel: null });
    }

    function handleEnded() {
      // Reset so a replay re-arms all events.
      lastFiredIndexRef.current = -1;
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      setState({ activeTool: null, activeLabel: null });
    }

    audioElement.addEventListener('timeupdate', handleTimeUpdate);
    audioElement.addEventListener('seeking', handleSeeking);
    audioElement.addEventListener('ended', handleEnded);
    return () => {
      audioElement.removeEventListener('timeupdate', handleTimeUpdate);
      audioElement.removeEventListener('seeking', handleSeeking);
      audioElement.removeEventListener('ended', handleEnded);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
    // We intentionally omit `sortedEvents` from the dep array — it's
    // recreated every render (array spread) but the underlying events
    // only change when `timeline` changes. Reading it via closure is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioElement, enabled, timeline]);

  function setActiveManual(tool: ToolId | null, label?: string) {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    if (tool === null) {
      setState({ activeTool: null, activeLabel: null });
    } else {
      setState({
        activeTool: tool,
        activeLabel: label ?? TOOL_REGISTRY[tool].defaultActionLabel,
      });
    }
  }

  return { ...state, setActiveManual };
}
