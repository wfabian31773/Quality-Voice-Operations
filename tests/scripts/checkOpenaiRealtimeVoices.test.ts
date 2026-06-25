import { describe, it, expect } from 'vitest';
import {
  parseAllowedVoicesFromErrorMessage,
  diffVoiceSets,
  runVoiceCheck,
} from '../../scripts/check-openai-realtime-voices';
import { VOICES } from '../../client-app/src/lib/agentVoices';

/**
 * Coverage goals for the voice-drift detector script:
 *
 *  1. Parsing — every wording variant we have observed (or expect) for
 *     OpenAI's "invalid voice" validation error must yield a clean,
 *     lowercase, sorted, deduplicated list of voice ids. If OpenAI
 *     ships a new wording the script should at least be able to extract
 *     the list from the wording shapes covered here without changes.
 *
 *  2. Diffing — `added` and `removed` are computed correctly regardless
 *     of input casing/order and never include duplicates.
 *
 *  3. End-to-end against a mocked `fetch` — the four exit-class outcomes
 *     (`in_sync`, `drift`, `parser_broken`, `request_failed`) are
 *     returned for the corresponding API responses, so the GitHub
 *     Action's exit-code branch always lands on the right path.
 */

describe('parseAllowedVoicesFromErrorMessage', () => {
  it("parses OpenAI's typical 'Supported values are: ...' wording", () => {
    const msg =
      "Invalid value: '__qvo_invalid_voice_probe__'. Supported values are: " +
      "'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'.";
    expect(parseAllowedVoicesFromErrorMessage(msg)).toEqual([
      'alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse',
    ]);
  });

  it("parses 'Allowed values are ...' wording without a colon", () => {
    const msg =
      "Voice 'foo' is not valid. Allowed values are 'alloy', 'ash', 'ballad'.";
    expect(parseAllowedVoicesFromErrorMessage(msg)).toEqual(['alloy', 'ash', 'ballad']);
  });

  it("parses 'must be one of: ...' wording", () => {
    const msg = "voice must be one of: 'alloy', 'ash', 'verse'.";
    expect(parseAllowedVoicesFromErrorMessage(msg)).toEqual(['alloy', 'ash', 'verse']);
  });

  it("parses Python-style 'is not one of [...]' wording", () => {
    const msg = "'foo' is not one of ['alloy', 'ash', 'ballad', 'verse'].";
    expect(parseAllowedVoicesFromErrorMessage(msg)).toEqual(['alloy', 'ash', 'ballad', 'verse']);
  });

  it('falls back to bare comma-separated identifiers when nothing is quoted', () => {
    const msg = 'voice must be one of alloy, ash, ballad, verse.';
    expect(parseAllowedVoicesFromErrorMessage(msg)).toEqual(['alloy', 'ash', 'ballad', 'verse']);
  });

  it('strips English connectors (and / or) when falling back to bare tokens', () => {
    const msg = 'voice must be one of alloy, ash or verse.';
    const parsed = parseAllowedVoicesFromErrorMessage(msg);
    expect(parsed).toEqual(['alloy', 'ash', 'verse']);
    expect(parsed).not.toContain('or');
    expect(parsed).not.toContain('and');
  });

  it('lowercases and deduplicates', () => {
    const msg = "Supported values are: 'Alloy', 'ALLOY', 'ash', 'ash'.";
    expect(parseAllowedVoicesFromErrorMessage(msg)).toEqual(['alloy', 'ash']);
  });

  it('returns null when no list-intro phrase is present (parser-broken signal)', () => {
    expect(parseAllowedVoicesFromErrorMessage('Some unrelated server error.')).toBeNull();
    expect(parseAllowedVoicesFromErrorMessage('')).toBeNull();
    // @ts-expect-error: deliberately exercise the runtime guard.
    expect(parseAllowedVoicesFromErrorMessage(null)).toBeNull();
  });
});

describe('diffVoiceSets', () => {
  it('reports no diff when sets are identical (regardless of order/casing)', () => {
    const diff = diffVoiceSets(['Ash', 'alloy', 'verse'], ['verse', 'alloy', 'ash']);
    expect(diff).toEqual({ added: [], removed: [] });
  });

  it('reports added voices when the API gained a voice', () => {
    const diff = diffVoiceSets(
      ['alloy', 'ash', 'verse', 'marin'],
      ['alloy', 'ash', 'verse'],
    );
    expect(diff).toEqual({ added: ['marin'], removed: [] });
  });

  it('reports removed voices when the API dropped a voice', () => {
    const diff = diffVoiceSets(
      ['alloy', 'ash'],
      ['alloy', 'ash', 'fable'],
    );
    expect(diff).toEqual({ added: [], removed: ['fable'] });
  });

  it('reports both added and removed in a single pass and sorts deterministically', () => {
    const diff = diffVoiceSets(
      ['alloy', 'cedar', 'marin'],
      ['alloy', 'fable', 'onyx'],
    );
    expect(diff.added).toEqual(['cedar', 'marin']);
    expect(diff.removed).toEqual(['fable', 'onyx']);
  });
});

/**
 * Build a minimal mocked `fetch` that returns whatever response the
 * test wants, so the script can be exercised end-to-end without
 * hitting the real OpenAI API.
 */
function mockFetch(response: {
  status: number;
  body: unknown | string;
  throws?: Error;
}): typeof fetch {
  return (async () => {
    if (response.throws) throw response.throws;
    const bodyText =
      typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    return new Response(bodyText, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('runVoiceCheck (end-to-end with mocked fetch)', () => {
  it('returns in_sync when the discovered set equals the canonical VOICES', async () => {
    const fetchImpl = mockFetch({
      status: 400,
      body: {
        error: {
          message:
            "Invalid value: 'x'. Supported values are: " +
            VOICES.map((v) => `'${v}'`).join(', ') +
            '.',
          type: 'invalid_request_error',
          param: 'voice',
          code: 'invalid_value',
        },
      },
    });

    const outcome = await runVoiceCheck({ apiKey: 'sk-test', fetchImpl });
    expect(outcome.status).toBe('in_sync');
    if (outcome.status === 'in_sync') {
      expect(outcome.discovered.sort()).toEqual([...VOICES].map((v) => v.toLowerCase()).sort());
    }
  });

  it('returns drift with added voices when OpenAI ships new voices', async () => {
    // Synthetic placeholder voices that match the parser's identifier
    // regex but won't collide with any real OpenAI voice past or
    // future. The original fixture used 'cedar' and 'marin' as the
    // "new" voices, but those were folded into VOICES on 2026-06-25
    // when the GA Realtime catalog added them — using them here would
    // make the test pass trivially (in_sync) instead of exercising
    // the drift-add branch. Same rationale as the removed-voice test
    // below: lift the test data outside the canonical list so the
    // assertion stays meaningful as the catalog churns.
    const newVoices = ['testvoice-a', 'testvoice-b'];
    const apiVoices = [...VOICES, ...newVoices];
    const fetchImpl = mockFetch({
      status: 400,
      body: {
        error: {
          message:
            "Invalid value. Supported values are: " +
            apiVoices.map((v) => `'${v}'`).join(', ') +
            '.',
        },
      },
    });

    const outcome = await runVoiceCheck({ apiKey: 'sk-test', fetchImpl });
    expect(outcome.status).toBe('drift');
    if (outcome.status === 'drift') {
      expect(outcome.diff.added).toEqual([...newVoices].sort());
      expect(outcome.diff.removed).toEqual([]);
    }
  });

  it('returns drift with removed voices when OpenAI drops a voice', async () => {
    // Pick a still-present canonical voice to drop in the mock. The
    // original fixture used 'fable', but that voice was removed from
    // VOICES on 2026-06-25 when OpenAI dropped it from the Realtime GA
    // catalog; the filter was a no-op against the new list. 'sage' is
    // a stable mid-list voice unlikely to be churned in future
    // catalog changes.
    const droppedVoice = 'sage';
    const fetchImpl = mockFetch({
      status: 400,
      body: {
        error: {
          message:
            "Supported values are: " +
            VOICES.filter((v) => v !== droppedVoice).map((v) => `'${v}'`).join(', ') +
            '.',
        },
      },
    });

    const outcome = await runVoiceCheck({ apiKey: 'sk-test', fetchImpl });
    expect(outcome.status).toBe('drift');
    if (outcome.status === 'drift') {
      expect(outcome.diff.removed).toEqual([droppedVoice]);
      expect(outcome.diff.added).toEqual([]);
    }
  });

  it('returns parser_broken when the API accepts our nonsense voice', async () => {
    // 200 means OpenAI no longer validates the way we assume → we
    // can't trust the diff. Surface as parser_broken so a human looks.
    const fetchImpl = mockFetch({
      status: 200,
      body: { client_secret: { value: 'ek_test', expires_at: 0 } },
    });

    const outcome = await runVoiceCheck({ apiKey: 'sk-test', fetchImpl });
    expect(outcome.status).toBe('parser_broken');
  });

  it('returns parser_broken when the error message has no recognizable list', async () => {
    const fetchImpl = mockFetch({
      status: 400,
      body: { error: { message: 'Some opaque server error with no list of values.' } },
    });

    const outcome = await runVoiceCheck({ apiKey: 'sk-test', fetchImpl });
    expect(outcome.status).toBe('parser_broken');
  });

  it('returns parser_broken when the body is not JSON', async () => {
    const fetchImpl = mockFetch({ status: 400, body: '<html>oops</html>' });

    const outcome = await runVoiceCheck({ apiKey: 'sk-test', fetchImpl });
    expect(outcome.status).toBe('parser_broken');
  });

  it('returns request_failed on network error', async () => {
    const fetchImpl = mockFetch({ status: 0, body: '', throws: new Error('ECONNRESET') });

    const outcome = await runVoiceCheck({ apiKey: 'sk-test', fetchImpl });
    expect(outcome.status).toBe('request_failed');
    if (outcome.status === 'request_failed') {
      expect(outcome.reason).toContain('ECONNRESET');
    }
  });

  it('returns request_failed on 429 (rate limit, transient)', async () => {
    const fetchImpl = mockFetch({
      status: 429,
      body: { error: { message: 'Rate limit exceeded.' } },
    });

    const outcome = await runVoiceCheck({ apiKey: 'sk-test', fetchImpl });
    expect(outcome.status).toBe('request_failed');
    if (outcome.status === 'request_failed') {
      expect(outcome.reason).toMatch(/429/);
    }
  });

  it('returns request_failed on 5xx (OpenAI infra outage, transient)', async () => {
    const fetchImpl = mockFetch({
      status: 503,
      body: '<html><body>Bad gateway</body></html>',
    });

    const outcome = await runVoiceCheck({ apiKey: 'sk-test', fetchImpl });
    expect(outcome.status).toBe('request_failed');
    if (outcome.status === 'request_failed') {
      expect(outcome.reason).toMatch(/503/);
    }
  });

  it('returns request_failed (with auth hint) on 401', async () => {
    const fetchImpl = mockFetch({
      status: 401,
      body: { error: { message: 'Incorrect API key' } },
    });

    const outcome = await runVoiceCheck({ apiKey: 'sk-test', fetchImpl });
    expect(outcome.status).toBe('request_failed');
    if (outcome.status === 'request_failed') {
      expect(outcome.reason).toMatch(/auth/i);
    }
  });
});
