/**
 * Inline SVG icons for the four canonical tools on the demo wheel.
 *
 * Why hand-rolled SVG instead of lucide-react: each tool needs a *shape*
 * silhouette that the eye can recognize at small sizes from across the
 * room. Lucide's icons are great line-art but at 56px in a wheel, three
 * 1.5px strokes don't carry the silhouette. These tile glyphs are filled,
 * higher contrast, and read at a glance even when dimmed to 50% opacity in
 * the inactive state.
 *
 * All glyphs are 32×32 viewBox so they scale uniformly in the tile.
 * `currentColor` lets the tile's color state (active=teal, inactive=muted)
 * cascade through naturally.
 */
import { type ReactElement } from 'react';
import { type ToolId } from './types';

interface ToolIconProps {
  className?: string;
}

function CalendarIcon({ className }: ToolIconProps): ReactElement {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="4" y="6" width="24" height="22" rx="3" />
      <line x1="4" y1="12" x2="28" y2="12" />
      <line x1="10" y1="3" x2="10" y2="9" strokeLinecap="round" />
      <line x1="22" y1="3" x2="22" y2="9" strokeLinecap="round" />
      <rect x="9" y="16" width="5" height="4" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SmsIcon({ className }: ToolIconProps): ReactElement {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" stroke="currentColor" strokeWidth={2}>
      <path
        d="M5 7a3 3 0 013-3h16a3 3 0 013 3v12a3 3 0 01-3 3h-9l-5 5v-5H8a3 3 0 01-3-3V7z"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="16" cy="13" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="20" cy="13" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function TicketIcon({ className }: ToolIconProps): ReactElement {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="6" y="4" width="20" height="24" rx="2" />
      <rect x="11" y="2" width="10" height="4" rx="1" fill="currentColor" stroke="none" />
      <path d="M10 14l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="10" y1="22" x2="22" y2="22" strokeLinecap="round" />
    </svg>
  );
}

function DispatchIcon({ className }: ToolIconProps): ReactElement {
  // Route pin + connecting path — reads as "send this where it needs to go".
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="9" cy="9" r="3" />
      <circle cx="23" cy="23" r="3" />
      <path d="M11.5 11.5L20.5 20.5" strokeLinecap="round" />
      <circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none" />
      <path d="M23 5l1 4-4-1z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export interface ToolDefinition {
  id: ToolId;
  label: string;
  Icon: (props: ToolIconProps) => ReactElement;
  /** Default in-flight label (overridable per scripted-timeline event). */
  defaultActionLabel: string;
}

/**
 * Canonical registry. The `defaultActionLabel` is what appears below the
 * active tile when a timeline event omits a custom label. Real product
 * copy lives in the timeline events themselves so each demo beat can be
 * specific ("Pulling 9:30 AM appointment for Sarah" rather than the
 * generic default).
 */
export const TOOL_REGISTRY: Record<ToolId, ToolDefinition> = {
  calendar: {
    id: 'calendar',
    label: 'Calendar',
    Icon: CalendarIcon,
    defaultActionLabel: 'Checking the calendar',
  },
  sms: {
    id: 'sms',
    label: 'SMS',
    Icon: SmsIcon,
    defaultActionLabel: 'Sending a text',
  },
  ticket: {
    id: 'ticket',
    label: 'Ticket',
    Icon: TicketIcon,
    defaultActionLabel: 'Opening a ticket',
  },
  dispatch: {
    id: 'dispatch',
    label: 'Dispatch',
    Icon: DispatchIcon,
    defaultActionLabel: 'Dispatching to your team',
  },
};
