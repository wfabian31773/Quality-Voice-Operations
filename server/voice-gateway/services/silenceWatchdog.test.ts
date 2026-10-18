import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HANGUP_GRACE_MS,
  HEARD_SILENCE_CHECK_MS,
  MAX_CALL_DURATION_MS,
  MAX_DURATION_WRAP_UP_INSTRUCTION,
  NEVER_HEARD_GOODBYE_INSTRUCTION,
  NEVER_HEARD_PROMPT_INTERVAL_MS,
  NEVER_HEARD_PROMPTS,
  SILENCE_PROMPT_INSTRUCTION,
  SilenceWatchdog,
  type SilenceWatchdogAction,
  type SilenceWatchdogEndReason,
} from './silenceWatchdog';

function makeWatchdog() {
  const said: string[] = [];
  const actions: SilenceWatchdogAction[] = [];
  const endings: SilenceWatchdogEndReason[] = [];
  const hangUps: SilenceWatchdogEndReason[] = [];
  const watchdog = new SilenceWatchdog({
    say: (instruction) => said.push(instruction),
    onEnding: (reason) => endings.push(reason),
    hangUp: (reason) => hangUps.push(reason),
    onAction: (action) => actions.push(action),
  });
  const prompts = () => said.filter((s) => s === SILENCE_PROMPT_INSTRUCTION).length;
  // The model answering an instruction: one agent turn.
  const agentTurn = () => {
    watchdog.agentTurnStarted();
    watchdog.agentTurnEnded();
  };
  return { watchdog, said, actions, endings, hangUps, prompts, agentTurn };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SilenceWatchdog', () => {
  it('never-heard caller: 3 prompts ~8 s apart, then goodbye and hang-up with outcome never_heard', () => {
    const { watchdog, said, actions, endings, hangUps, prompts } = makeWatchdog();
    watchdog.start();

    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS - 1);
    expect(prompts()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(prompts()).toBe(1);
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS);
    expect(prompts()).toBe(2);
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS);
    expect(prompts()).toBe(NEVER_HEARD_PROMPTS);
    expect(hangUps).toEqual([]);

    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS);
    expect(said[said.length - 1]).toBe(NEVER_HEARD_GOODBYE_INSTRUCTION);
    expect(endings).toEqual(['never_heard']);
    expect(hangUps).toEqual([]);

    vi.advanceTimersByTime(HANGUP_GRACE_MS);
    expect(hangUps).toEqual(['never_heard']);
    expect(actions).toEqual(['silence_prompt', 'silence_prompt', 'silence_prompt', 'never_heard_hangup']);

    // Nothing after the hang-up.
    vi.advanceTimersByTime(MAX_CALL_DURATION_MS);
    expect(prompts()).toBe(NEVER_HEARD_PROMPTS);
    expect(hangUps).toEqual(['never_heard']);
  });

  it('never-heard: the 8 s count restarts after each prompt is spoken, and agent turns do not reset the 3-prompt budget', () => {
    const { watchdog, hangUps, prompts, agentTurn } = makeWatchdog();
    watchdog.start();
    for (let i = 1; i <= NEVER_HEARD_PROMPTS; i += 1) {
      vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS);
      expect(prompts()).toBe(i);
      watchdog.agentTurnStarted();
      vi.advanceTimersByTime(5_000); // prompt playing: not silence
      watchdog.agentTurnEnded();
    }
    agentTurn(); // some other agent line: still never heard
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS + HANGUP_GRACE_MS);
    expect(hangUps).toEqual(['never_heard']);
  });

  it('heard caller is never cut: one check after 15 s, then 5+ minutes of silence gives no hang-up and no more prompts', () => {
    const { watchdog, actions, hangUps, prompts, agentTurn } = makeWatchdog();
    watchdog.start();
    watchdog.callerHeard();

    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS - 1);
    expect(prompts()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(prompts()).toBe(1);
    expect(actions).toEqual(['silence_check']);

    agentTurn(); // the check itself being spoken does not re-open the budget
    vi.advanceTimersByTime(6 * 60_000);
    expect(prompts()).toBe(1);
    expect(hangUps).toEqual([]);
    expect(actions).toEqual(['silence_check']);
  });

  it('heard caller: the single check is available again after the caller or agent speaks', () => {
    const { watchdog, prompts, agentTurn } = makeWatchdog();
    watchdog.start();
    watchdog.callerHeard();
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS);
    agentTurn(); // the check's own response
    expect(prompts()).toBe(1);

    watchdog.callerHeard(); // caller answers
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS);
    agentTurn();
    expect(prompts()).toBe(2);

    agentTurn(); // a real agent turn (e.g. after a tool result)
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS);
    expect(prompts()).toBe(3);
  });

  it('heard stays heard: a later agent turn never puts the caller back on the never-heard ladder', () => {
    const { watchdog, hangUps, prompts, agentTurn } = makeWatchdog();
    watchdog.start();
    watchdog.callerHeard();
    agentTurn();
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS * 4);
    expect(prompts()).toBe(1);
    expect(hangUps).toEqual([]);
  });

  it('re-arm after the greeting: silence is counted from the end of the greeting turn and from each agent turn', () => {
    const { watchdog, prompts } = makeWatchdog();
    watchdog.start();
    watchdog.agentTurnStarted(); // greeting starts right away
    vi.advanceTimersByTime(20_000); // a long greeting is not silence
    expect(prompts()).toBe(0);
    watchdog.agentTurnEnded(); // greeting done: timer starts here
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS - 1);
    expect(prompts()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(prompts()).toBe(1);

    // Caller speaks, then the agent answers: the next check counts from the end of that turn.
    watchdog.callerHeard();
    vi.advanceTimersByTime(10_000);
    watchdog.agentTurnStarted();
    vi.advanceTimersByTime(10_000);
    watchdog.agentTurnEnded();
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS - 1);
    expect(prompts()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(prompts()).toBe(2);
  });

  it('does not count silence while a tool is running', () => {
    const { watchdog, prompts } = makeWatchdog();
    watchdog.start();
    watchdog.callerHeard();
    watchdog.toolStarted();
    vi.advanceTimersByTime(60_000);
    expect(prompts()).toBe(0);
    watchdog.toolEnded();
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS);
    expect(prompts()).toBe(1);
  });

  it('is not armed before start (session not open yet)', () => {
    const { watchdog, said } = makeWatchdog();
    watchdog.callerHeard();
    watchdog.agentTurnEnded();
    vi.advanceTimersByTime(MAX_CALL_DURATION_MS + HANGUP_GRACE_MS);
    expect(said).toEqual([]);
  });

  it('max cap: wrap-up and hang-up at 10 min with outcome max_duration, even for a heard caller', () => {
    const { watchdog, said, actions, endings, hangUps, agentTurn } = makeWatchdog();
    watchdog.start();
    // A heard caller who keeps talking: never silent for 15 s.
    for (let t = 0; t < MAX_CALL_DURATION_MS - 10_000; t += 10_000) {
      watchdog.callerHeard();
      agentTurn();
      vi.advanceTimersByTime(10_000);
    }
    expect(endings).toEqual([]);
    watchdog.callerHeard();
    vi.advanceTimersByTime(10_000);
    expect(endings).toEqual(['max_duration']);
    expect(said[said.length - 1]).toBe(MAX_DURATION_WRAP_UP_INSTRUCTION);
    expect(actions).toEqual(['max_duration_hangup']);
    expect(hangUps).toEqual([]);
    vi.advanceTimersByTime(HANGUP_GRACE_MS);
    expect(hangUps).toEqual(['max_duration']);
  });

  it('stop() clears every timer: no prompt, goodbye or hang-up after close', () => {
    const { watchdog, said, hangUps } = makeWatchdog();
    watchdog.start();
    watchdog.stop();
    vi.advanceTimersByTime(MAX_CALL_DURATION_MS + HANGUP_GRACE_MS);
    expect(said).toEqual([]);
    expect(hangUps).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() during the goodbye grace cancels the pending hang-up', () => {
    const { watchdog, hangUps } = makeWatchdog();
    watchdog.start();
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS * (NEVER_HEARD_PROMPTS + 1));
    watchdog.stop(); // caller hung up during the goodbye
    vi.advanceTimersByTime(HANGUP_GRACE_MS);
    expect(hangUps).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses only fixed instruction text', () => {
    for (const text of [SILENCE_PROMPT_INSTRUCTION, NEVER_HEARD_GOODBYE_INSTRUCTION, MAX_DURATION_WRAP_UP_INSTRUCTION]) {
      expect(text).not.toMatch(/\$\{|\d{4}/);
    }
    expect(SILENCE_PROMPT_INSTRUCTION).toContain('Are you still there?');
  });
});
