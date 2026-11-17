import { describe, expect, it } from 'vitest';
import {
  canTransition,
  DISPATCH_JOB_STATUSES,
  isDispatchJobStatus,
  isOpenJobStatus,
  isTerminalJobStatus,
  TERMINAL_JOB_STATUSES,
  VALID_TRANSITIONS,
} from './transitions';

describe('dispatch status transitions', () => {
  it('lists every known status as a key of VALID_TRANSITIONS', () => {
    expect(Object.keys(VALID_TRANSITIONS).sort()).toEqual([...DISPATCH_JOB_STATUSES].sort());
  });

  it.each(DISPATCH_JOB_STATUSES.flatMap((from) => DISPATCH_JOB_STATUSES.map((to) => [from, to] as const)))(
    'canTransition(%s → %s) matches VALID_TRANSITIONS',
    (from, to) => {
      expect(canTransition(from, to)).toBe(VALID_TRANSITIONS[from].includes(to));
    },
  );

  it('allows every listed transition and no others, including self', () => {
    const allowed = [
      ['pending', 'assigned'],
      ['pending', 'cancelled'],
      ['assigned', 'scheduled'],
      ['assigned', 'en_route'],
      ['assigned', 'in_progress'],
      ['assigned', 'cancelled'],
      ['assigned', 'pending'],
      ['scheduled', 'en_route'],
      ['scheduled', 'in_progress'],
      ['scheduled', 'cancelled'],
      ['scheduled', 'assigned'],
      ['en_route', 'on_site'],
      ['en_route', 'cancelled'],
      ['on_site', 'in_progress'],
      ['on_site', 'cancelled'],
      ['in_progress', 'completed'],
      ['in_progress', 'incomplete'],
      ['in_progress', 'cancelled'],
      ['in_progress', 'done'],
      ['completed', 'done'],
      ['incomplete', 'pending'],
      ['incomplete', 'assigned'],
      ['incomplete', 'cancelled'],
      ['cancelled', 'pending'],
    ];
    for (const [from, to] of allowed) {
      expect(canTransition(from, to)).toBe(true);
    }
    expect(VALID_TRANSITIONS.done).toEqual([]);
    for (const from of DISPATCH_JOB_STATUSES) {
      expect(canTransition(from, from)).toBe(false);
    }
  });

  it('rejects unknown statuses', () => {
    expect(canTransition('pending', 'no_show')).toBe(false);
    expect(canTransition('no_show', 'pending')).toBe(false);
    expect(canTransition('', 'pending')).toBe(false);
    expect(isDispatchJobStatus('pending')).toBe(true);
    expect(isDispatchJobStatus('no_show')).toBe(false);
  });

  it('treats completed, cancelled, done and incomplete as terminal', () => {
    expect([...TERMINAL_JOB_STATUSES].sort()).toEqual(['cancelled', 'completed', 'done', 'incomplete']);
    for (const status of DISPATCH_JOB_STATUSES) {
      expect(isTerminalJobStatus(status)).toBe(TERMINAL_JOB_STATUSES.has(status));
      expect(isOpenJobStatus(status)).toBe(!TERMINAL_JOB_STATUSES.has(status));
    }
  });
});
