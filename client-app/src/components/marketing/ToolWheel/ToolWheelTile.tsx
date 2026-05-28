/**
 * Single tile in the demo Tool Wheel.
 *
 * Two visual states:
 *   - active   → scale 1.08, teal glow ring, full-opacity icon, label below
 *   - inactive → scale 1.0,  no glow,        60%-opacity icon, no label
 *
 * The tile rotates as part of the parent wheel (so the icon stays upright
 * relative to its position on the ring — see `counterRotateDeg` which the
 * parent passes in to cancel out the ring rotation, keeping the icon
 * always upright regardless of the ring's current angle).
 */
import { type CSSProperties } from 'react';
import { type ToolDefinition } from './tool-wheel-icons';

interface ToolWheelTileProps {
  tool: ToolDefinition;
  active: boolean;
  /** Position on the ring, in degrees from 12 o'clock, clockwise. */
  positionDeg: number;
  /** Radius from the wheel center, in px. */
  radiusPx: number;
  /** Current ring rotation in deg — we counter-rotate the tile so the icon stays upright. */
  ringRotationDeg: number;
}

export function ToolWheelTile({
  tool,
  active,
  positionDeg,
  radiusPx,
  ringRotationDeg,
}: ToolWheelTileProps) {
  const { Icon } = tool;
  // Tiles sit on a circle. Standard polar→cartesian, but rotated so 0° is at
  // the TOP of the wheel (12 o'clock) rather than the right (3 o'clock).
  // x = r sin θ,  y = -r cos θ  (negative y because CSS y grows downward).
  const theta = (positionDeg * Math.PI) / 180;
  const x = radiusPx * Math.sin(theta);
  const y = -radiusPx * Math.cos(theta);

  const tileStyle: CSSProperties = {
    transform: `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${-ringRotationDeg}deg)`,
    transition: 'transform 0s',
  };

  return (
    <div
      className="absolute left-1/2 top-1/2 will-change-transform"
      style={tileStyle}
      data-tool={tool.id}
      data-active={active || undefined}
    >
      <div
        className={[
          'h-20 w-20 rounded-2xl flex items-center justify-center',
          'bg-surface border border-border-strong/40',
          'transition-all duration-300',
          active
            ? 'scale-110 border-primary shadow-[0_0_0_4px_rgba(46,140,131,0.18),0_8px_30px_rgba(46,140,131,0.35)]'
            : 'opacity-55',
        ].join(' ')}
      >
        <Icon
          className={[
            'h-9 w-9 transition-colors duration-300',
            active ? 'text-primary' : 'text-text-secondary',
          ].join(' ')}
        />
      </div>
      <div
        aria-hidden={!active}
        className={[
          'mt-2 text-center text-[11px] font-semibold uppercase tracking-wider transition-colors duration-300',
          active ? 'text-primary' : 'text-text-secondary/70',
        ].join(' ')}
      >
        {tool.label}
      </div>
    </div>
  );
}
