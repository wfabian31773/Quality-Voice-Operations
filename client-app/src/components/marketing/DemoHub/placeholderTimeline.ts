/**
 * Placeholder scripted timeline for the demo Tool Wheel.
 *
 * Replace `audioUrl` with the real 30s Sage demo recording when Wayne
 * delivers it, and adjust the `at` timestamps to match the actual beats
 * in the audio (use the recording's waveform to pin the moments where the
 * agent invokes each tool).
 *
 * The current values are tuned for a hypothetical 30s patient-reschedule
 * call. They're realistic enough to demo the wheel during development
 * but explicitly marked as placeholder so they're never shipped as-is.
 */
import { type ScriptedTimeline } from './types';

export const PLACEHOLDER_DEMO_TIMELINE: ScriptedTimeline = {
  // TODO(QVO/Demo): replace with /demo/sage-rescheduling-demo.mp3 (30s)
  // — pending Wayne's recording delivery.
  audioUrl: '',
  events: [
    { at: 5.2, tool: 'calendar', label: 'Pulling next available appointment', durationMs: 1800 },
    { at: 12.0, tool: 'sms', label: 'Texting the confirmation', durationMs: 1500 },
    { at: 18.5, tool: 'ticket', label: 'Logging a recall ticket', durationMs: 1400 },
    { at: 24.8, tool: 'dispatch', label: 'Dispatching to your front desk', durationMs: 1600 },
  ],
};
