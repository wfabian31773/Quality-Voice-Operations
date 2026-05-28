/**
 * Animated SVG spoke overlay for the Demo Orchestration Hub.
 *
 * Four glowing quadratic curves traced over the baked X-spokes in the
 * hero image, one per tool. Each spoke is normally barely visible (the
 * baked spokes carry the look) — when its tool fires, the matching SVG
 * path lights up with a strong teal stroke + drop-shadow filter,
 * visually "supercharging" the baked spoke for the duration of the
 * action.
 *
 * Geometry: all coordinates are percentages of the 16:9 viewBox
 * (100 × 56.25) so the overlay scales with the image regardless of
 * rendered size. The four endpoints were sampled from the hub image
 * (demo-orchestration-hub.webp) at the inner corner of each product
 * panel; the center (50, 50) is the convergence point where the live
 * waveform sits.
 *
 * Animation: pure CSS via the `data-active` attribute on each path —
 * keyframed opacity + filter intensity. No JS animation library
 * required, no rAF, no bundle cost.
 */
import { type ToolId } from './types';

interface DemoHubSpokesProps {
  activeTool: ToolId | null;
}

// (x, y) endpoint positions for each spoke, in % of the 16:9 viewBox.
// Sampled from demo-orchestration-hub.webp (Wayne's reference render):
const SPOKE_ENDPOINTS: Record<ToolId, { x: number; y: number }> = {
  sms: { x: 22, y: 35 },        // top-left  (Message panel)
  calendar: { x: 78, y: 35 },   // top-right (Provider Calendar panel)
  dispatch: { x: 22, y: 70 },   // bottom-left  (Scheduler timeline panel)
  ticket: { x: 78, y: 70 },     // bottom-right (Kanban dashboard panel)
};

// Where the spokes meet the center waveform.
const CENTER = { x: 50, y: 50 };

/**
 * Build a quadratic-bezier path from an endpoint to center. The control
 * point is biased slightly toward the corresponding diagonal so the
 * resulting curve matches the gentle arc of the baked spokes (which
 * bow outward away from the center rather than running straight).
 */
function spokePath(endpoint: { x: number; y: number }): string {
  // Control point: midway between endpoint and center, shifted slightly
  // outward (away from the visual center) for the gentle bow shape.
  const midX = (endpoint.x + CENTER.x) / 2;
  const midY = (endpoint.y + CENTER.y) / 2;
  const dx = endpoint.x - CENTER.x;
  const dy = endpoint.y - CENTER.y;
  // Perpendicular bias — for a top-left to center spoke (negative dx,
  // negative dy), the bow should push up-and-left, i.e. perpendicular
  // outward. The perpendicular to (dx, dy) is (-dy, dx); we want the
  // outward direction.
  const bowStrength = 0.18;
  const ctrlX = midX - dy * bowStrength;
  const ctrlY = midY + dx * bowStrength;
  return `M ${endpoint.x} ${endpoint.y} Q ${ctrlX} ${ctrlY} ${CENTER.x} ${CENTER.y}`;
}

export function DemoHubSpokes({ activeTool }: DemoHubSpokesProps) {
  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      viewBox="0 0 100 56.25"
      preserveAspectRatio="none"
      aria-hidden
      data-testid="demo-hub-spokes"
    >
      <defs>
        {/*
          Two stacked drop-shadow filters create the soft outer bloom +
          tight inner glow that a real volumetric light effect needs.
          The teal color (--qvo-accent #2E8C83) cascades through via
          stroke="currentColor" + a parent color.
        */}
        <filter id="demo-hub-spoke-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="0.8" result="outerBlur" />
          <feFlood floodColor="#2E8C83" floodOpacity="0.95" result="floodColor" />
          <feComposite in="floodColor" in2="outerBlur" operator="in" result="outerGlow" />
          <feMerge>
            <feMergeNode in="outerGlow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {(Object.entries(SPOKE_ENDPOINTS) as Array<[ToolId, { x: number; y: number }]>).map(
        ([toolId, endpoint]) => {
          const active = activeTool === toolId;
          return (
            <path
              key={toolId}
              d={spokePath(endpoint)}
              fill="none"
              stroke="#2E8C83"
              strokeWidth={active ? 0.6 : 0.25}
              strokeLinecap="round"
              filter={active ? 'url(#demo-hub-spoke-glow)' : undefined}
              style={{
                opacity: active ? 0.95 : 0.18,
                transition: 'opacity 280ms ease-out, stroke-width 280ms ease-out',
              }}
              data-tool={toolId}
              data-active={active || undefined}
            />
          );
        },
      )}
    </svg>
  );
}
