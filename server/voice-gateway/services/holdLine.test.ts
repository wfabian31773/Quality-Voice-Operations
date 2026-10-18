import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOLD_LINE_DELAY_MAX_MS,
  HOLD_LINE_DELAY_MIN_MS,
  HOLD_LINE_DELAY_MS,
  HOLD_LINE_MAX_RETRIES,
  HOLD_LINE_PHRASES,
  HOLD_LINE_RETRY_MS,
  HoldLine,
  holdLineInstruction,
  holdLineLanguage,
  holdLinePhrase,
  isHoldLineInstruction,
  resolveHoldLineDelayMs,
  type HoldLineDeps,
} from './holdLine';

function makeHoldLine(overrides: Partial<HoldLineDeps> = {}) {
  const said: Array<{ phrase: string; language: string; at: number }> = [];
  const onSaid = vi.fn();
  const start = Date.now();
  const holdLine = new HoldLine({
    say: (phrase, language) => {
      said.push({ phrase, language, at: Date.now() - start });
      return true;
    },
    onSaid,
    ...overrides,
  });
  /** The model's function-call response: created, the call arrives, done (no audio). */
  const toolCall = (name = 'check_availability') => {
    holdLine.agentResponseStarted();
    holdLine.toolStarted(name);
    holdLine.agentResponseEnded();
  };
  return { holdLine, said, onSaid, toolCall };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('hold line timing (response_done playback)', () => {
  it('a tool in flight for 2 s gets exactly one hold line, at 800 ms', async () => {
    const { holdLine, said, onSaid, toolCall } = makeHoldLine();
    toolCall();
    await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS - 1);
    expect(said).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(said).toEqual([{ phrase: 'One moment while I check that.', language: 'en', at: 800 }]);
    // Its own response plays and ends; the tool still runs: nothing more.
    holdLine.agentResponseStarted();
    holdLine.agentAudioStarted(true);
    holdLine.agentResponseEnded();
    await vi.advanceTimersByTimeAsync(1_200);
    holdLine.toolEnded();
    expect(said).toHaveLength(1);
    expect(onSaid).toHaveBeenCalledWith({ tool: 'check_availability', language: 'en', delayMs: 800, waitedMs: 800 });
  });

  it('in the call\'s language: Spanish from the agent config, or after record_language_change', async () => {
    const es = makeHoldLine({ language: 'es' });
    es.toolCall();
    await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
    expect(es.said.map((s) => s.phrase)).toEqual(['Un momento mientras lo reviso.']);

    const switched = makeHoldLine({ language: 'en' });
    switched.holdLine.setLanguage('Spanish');
    switched.toolCall();
    await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
    expect(switched.said.map((s) => [s.phrase, s.language])).toEqual([['Un momento mientras lo reviso.', 'es']]);
  });

  describe('a call language with no phrase row: no hold line, never English (Codex 4308599616)', () => {
    /** A slow tool (2 s) on a fresh wait; returns the phrases said. */
    async function slowTool(h: ReturnType<typeof makeHoldLine>) {
      h.holdLine.callerSpeechStarted();
      h.holdLine.callerSpeechStopped();
      h.toolCall();
      await vi.advanceTimersByTimeAsync(2_000);
      h.holdLine.toolEnded();
      return h.said.map((s) => s.phrase);
    }

    it('fr from the agent config: none', async () => {
      const fr = makeHoldLine({ language: 'fr' });
      expect(fr.holdLine.currentLanguage).toBeNull();
      expect(await slowTool(fr)).toEqual([]);
      expect(fr.onSaid).not.toHaveBeenCalled();
    });

    it('en, then record_language_change to de: none after the switch', async () => {
      const h = makeHoldLine({ language: 'en' });
      expect(await slowTool(h)).toEqual(['One moment while I check that.']);
      h.holdLine.setLanguage('de');
      expect(await slowTool(h)).toEqual(['One moment while I check that.']);
      expect(h.holdLine.currentLanguage).toBeNull();
    });

    it('the switch comes in the same tool call (record_language_change itself is slow): none', async () => {
      const h = makeHoldLine({ language: 'en' });
      h.toolCall('record_language_change');
      h.holdLine.setLanguage('pt-BR');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.said).toEqual([]);
    });

    it('es still gets the Spanish line, and a switch back to a row turns it on again', async () => {
      const es = makeHoldLine({ language: 'es-US' });
      expect(await slowTool(es)).toEqual(['Un momento mientras lo reviso.']);
      const back = makeHoldLine({ language: 'fr' });
      back.holdLine.setLanguage('Spanish');
      expect(await slowTool(back)).toEqual(['Un momento mientras lo reviso.']);
    });

    it('an unrecognised code is a language with no row: none', async () => {
      const h = makeHoldLine({ language: 'en' });
      h.holdLine.setLanguage('tlh');
      expect(h.holdLine.currentLanguage).toBeNull();
      expect(await slowTool(h)).toEqual([]);
      expect(makeHoldLine({ language: 'xx' }).holdLine.currentLanguage).toBeNull();
    });

    it('an empty or missing code: the agent\'s configured language if it has a row (English when none is configured), else none', async () => {
      const es = makeHoldLine({ language: 'es' });
      es.holdLine.setLanguage('de');
      es.holdLine.setLanguage('  ');
      expect(await slowTool(es)).toEqual(['Un momento mientras lo reviso.']);
      const fr = makeHoldLine({ language: 'fr' });
      fr.holdLine.setLanguage(undefined);
      expect(await slowTool(fr)).toEqual([]);
      expect([makeHoldLine({}).holdLine.currentLanguage, makeHoldLine({ language: '' }).holdLine.currentLanguage]).toEqual(['en', 'en']);
    });
  });

  it('a tool done at 500 ms gets none (the result arrived first)', async () => {
    const { holdLine, said, toolCall } = makeHoldLine();
    toolCall();
    await vi.advanceTimersByTimeAsync(500);
    holdLine.toolEnded();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(said).toEqual([]);
  });

  it('the caller speaking at the deadline: none for that tool call, even after they stop', async () => {
    const { holdLine, said, toolCall } = makeHoldLine();
    toolCall();
    await vi.advanceTimersByTimeAsync(600);
    holdLine.callerSpeechStarted(); // "hello?"
    await vi.advanceTimersByTimeAsync(400);
    holdLine.callerSpeechStopped();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(said).toEqual([]);
  });

  it('the caller stopped before the deadline: the line still comes at the deadline', async () => {
    const { holdLine, said, toolCall } = makeHoldLine();
    toolCall();
    await vi.advanceTimersByTimeAsync(200);
    holdLine.callerSpeechStarted();
    await vi.advanceTimersByTimeAsync(300);
    holdLine.callerSpeechStopped();
    await vi.advanceTimersByTimeAsync(300);
    expect(said.map((s) => s.at)).toEqual([800]);
  });

  it('a reply to the caller during the wait (the agent spoke): no hold line in that wait', async () => {
    const { holdLine, said, toolCall } = makeHoldLine();
    toolCall();
    await vi.advanceTimersByTimeAsync(300);
    holdLine.callerSpeechStarted();
    holdLine.callerSpeechStopped();
    holdLine.agentResponseStarted(); // "Still here, just pulling that up"
    holdLine.agentAudioStarted(false);
    holdLine.agentResponseEnded();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(said).toEqual([]);
  });

  it('a chain of 3 tool calls (one wait) gets one hold line', async () => {
    const { holdLine, said, toolCall } = makeHoldLine();
    for (const tool of ['list_services', 'check_availability', 'check_availability']) {
      toolCall(tool);
      await vi.advanceTimersByTimeAsync(1_500);
      holdLine.toolEnded(); // result → the model's next call, no audio in between
    }
    expect(said).toHaveLength(1);
  });

  it('once the agent has spoken in the turn, no hold line until the caller\'s next turn', async () => {
    const { holdLine, said, toolCall } = makeHoldLine();
    toolCall('check_availability');
    await vi.advanceTimersByTimeAsync(300);
    holdLine.toolEnded();
    // "Dee is free at nine, let me hold that for you" → another call in the same turn.
    holdLine.agentResponseStarted();
    holdLine.agentAudioStarted(false);
    holdLine.toolStarted('book_prepare');
    holdLine.agentResponseEnded();
    await vi.advanceTimersByTimeAsync(5_000);
    holdLine.toolEnded();
    expect(said).toEqual([]);
    // The caller's next turn is a new wait.
    holdLine.callerSpeechStarted();
    holdLine.callerSpeechStopped();
    toolCall('book_commit');
    await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
    expect(said).toHaveLength(1);
  });

  it('a chained call after a long quiet: the line comes as soon as its function-call response is done', async () => {
    const { holdLine, said, toolCall } = makeHoldLine();
    toolCall('list_services');
    await vi.advanceTimersByTimeAsync(400);
    holdLine.toolEnded();
    await vi.advanceTimersByTimeAsync(500); // model think time
    toolCall('check_availability'); // already 900 ms since the agent's last audio
    await vi.advanceTimersByTimeAsync(0);
    expect(said.map((s) => s.at)).toEqual([900]);
  });

  it('a new caller turn with nothing running starts a new wait', async () => {
    const { holdLine, said, toolCall } = makeHoldLine();
    toolCall();
    await vi.advanceTimersByTimeAsync(1_000);
    holdLine.toolEnded();
    holdLine.callerSpeechStarted();
    holdLine.callerSpeechStopped();
    toolCall();
    await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
    expect(said).toHaveLength(2);
  });

  it('nothing when say() is refused (a response is due); the wait stays open', async () => {
    let allow = false;
    const { holdLine, onSaid, toolCall } = makeHoldLine({ say: () => allow });
    toolCall();
    await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
    expect(onSaid).not.toHaveBeenCalled();
    allow = true;
    // The next quiet point re-arms (e.g. the response that was due was a function call only).
    holdLine.agentResponseStarted();
    holdLine.agentResponseEnded();
    await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
    expect(onSaid).toHaveBeenCalledTimes(1);
  });

  describe('a refused line is retried once the refusal clears, with no event (Codex 4308809833)', () => {
    /** say() refused until `allow` is set (the transport's caller-reply wait), counting every attempt. */
    function refusedAtFirst() {
      const gate = { allow: false, attempts: 0 };
      const h = makeHoldLine({ say: () => { gate.attempts += 1; return gate.allow; } });
      h.toolCall();
      return { ...h, gate };
    }

    it('the wait clears while the tool still runs: said exactly once', async () => {
      const { holdLine, onSaid, gate } = refusedAtFirst();
      await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
      expect(gate.attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000); // still refused (the 1.5 s reply wait)
      expect(onSaid).not.toHaveBeenCalled();
      gate.allow = true; // the wait cleared: nothing tells the hold line
      await vi.advanceTimersByTimeAsync(HOLD_LINE_RETRY_MS);
      expect(onSaid).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      holdLine.toolEnded();
      expect(onSaid).toHaveBeenCalledTimes(1);
      expect(gate.attempts).toBe(6);
    });

    it('the tool finishes before the retry: nothing said', async () => {
      const { holdLine, onSaid, gate } = refusedAtFirst();
      await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
      holdLine.toolEnded();
      gate.allow = true;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(onSaid).not.toHaveBeenCalled();
      expect(gate.attempts).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('the caller starts speaking while it waits for a retry: that tool call gets none, as at the deadline', async () => {
      const { holdLine, onSaid, gate } = refusedAtFirst();
      await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
      holdLine.callerSpeechStarted();
      holdLine.callerSpeechStopped();
      gate.allow = true;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(onSaid).not.toHaveBeenCalled();
      expect(gate.attempts).toBe(1);
    });

    it('stopped (hangup): no retries', async () => {
      const { holdLine, gate } = refusedAtFirst();
      await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
      holdLine.stop();
      gate.allow = true;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(gate.attempts).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a refusal that never clears (a closed socket) stops after HOLD_LINE_MAX_RETRIES', async () => {
      const { onSaid, gate } = refusedAtFirst();
      await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS + 60_000);
      expect(onSaid).not.toHaveBeenCalled();
      expect(gate.attempts).toBe(1 + HOLD_LINE_MAX_RETRIES);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('stop() clears the timer: nothing after hangup', async () => {
    const { holdLine, said, toolCall } = makeHoldLine();
    toolCall();
    holdLine.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(said).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("hold line timing ('twilio_mark' playback)", () => {
  it('agent audio playing at the deadline: none until 800 ms after it stops (the mark echo)', async () => {
    const { holdLine, said } = makeHoldLine({ playbackConfirm: 'twilio_mark' });
    // "Sure, let me check that for you" streams, then the call arrives; Twilio plays it for 2 s.
    holdLine.agentResponseStarted();
    holdLine.agentAudioStarted(false);
    holdLine.toolStarted('check_availability');
    holdLine.agentResponseEnded();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(said).toEqual([]);
    holdLine.agentPlaybackDone(); // mark echo: the preamble has played
    await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS - 1);
    expect(said).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(said.map((s) => s.at)).toEqual([2_800]);
  });

  it('no echo yet (the last answer may still be playing): no hold line; a function-call-only response does not end the wait for it', async () => {
    const { holdLine, said, toolCall } = makeHoldLine({ playbackConfirm: 'twilio_mark' });
    holdLine.agentResponseStarted();
    holdLine.agentAudioStarted(false); // a long answer, streamed faster than it plays
    holdLine.agentResponseEnded();
    toolCall();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(said).toEqual([]);
    holdLine.agentPlaybackDone();
    await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
    expect(said).toHaveLength(1);
  });
});

describe('phrase table and config', () => {
  it('one runtime-owned row per language; the instruction quotes it exactly; vertical-neutral', () => {
    expect(HOLD_LINE_PHRASES).toEqual({ en: 'One moment while I check that.', es: 'Un momento mientras lo reviso.' });
    expect(holdLineInstruction(HOLD_LINE_PHRASES.en)).toBe('Say exactly: "One moment while I check that.". Nothing else.');
    expect(isHoldLineInstruction(holdLineInstruction(HOLD_LINE_PHRASES.es))).toBe(true);
    expect(isHoldLineInstruction('Say exactly: "Hello". Nothing else.')).toBe(false);
    expect(JSON.stringify(HOLD_LINE_PHRASES)).not.toMatch(/barber|salon|haircut|appointment|booking/i);
  });

  it('language tags and names map to a row; others have no phrase (never an English fallback)', () => {
    expect(['es', 'es-US', 'ES_mx', 'Spanish', 'español'].map(holdLineLanguage)).toEqual(['es', 'es', 'es', 'es', 'es']);
    expect(['en', 'en-US', 'English'].map(holdLineLanguage)).toEqual(['en', 'en', 'en']);
    expect([undefined, '', 'fr', 42].map(holdLineLanguage)).toEqual([undefined, undefined, undefined, undefined]);
    expect(holdLinePhrase('fr')).toBeUndefined();
    expect(holdLinePhrase('es-MX')).toBe(HOLD_LINE_PHRASES.es);
  });

  it('delay per agent (metadata), else per tenant (settings), else 800 ms; clamped to 700..1000', () => {
    expect(resolveHoldLineDelayMs()).toBe(800);
    expect(resolveHoldLineDelayMs({ agentMetadata: { holdLineDelayMs: 900 }, tenantSettings: { holdLineDelayMs: 750 } })).toBe(900);
    expect(resolveHoldLineDelayMs({ agentMetadata: {}, tenantSettings: { holdLineDelayMs: '750' } })).toBe(750);
    expect(resolveHoldLineDelayMs({ agentMetadata: { holdLineDelayMs: 100 } })).toBe(HOLD_LINE_DELAY_MIN_MS);
    expect(resolveHoldLineDelayMs({ agentMetadata: { holdLineDelayMs: 5_000 } })).toBe(HOLD_LINE_DELAY_MAX_MS);
    expect(resolveHoldLineDelayMs({ agentMetadata: { holdLineDelayMs: 'soon' } })).toBe(800);
  });

  it('a configured delay moves the deadline', async () => {
    const { said, toolCall } = makeHoldLine({ delayMs: 950 });
    toolCall();
    await vi.advanceTimersByTimeAsync(949);
    expect(said).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(said.map((s) => s.at)).toEqual([950]);
  });
});
