import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isReplay,
  markSeen,
  deriveNonce,
  __setTwilioReplayDurableBackendForTests,
  __resetTwilioReplayCacheForTests,
  __getTwilioReplayCacheSizeForTests,
} from './twilioReplayCache';

const ENV_KEYS = ['TWILIO_REPLAY_WINDOW_SECONDS', 'TWILIO_REPLAY_CACHE_MAX_ENTRIES'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  __resetTwilioReplayCacheForTests();
  // Force the in-memory-only path unless a test installs its own backend.
  __setTwilioReplayDurableBackendForTests(null);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __resetTwilioReplayCacheForTests();
});

describe('deriveNonce', () => {
  it('keys SMS status callbacks by MessageSid + MessageStatus', () => {
    expect(
      deriveNonce('/twilio/sms-status', { MessageSid: 'MM1', MessageStatus: 'delivered' }),
    ).toBe('sms-status:MM1:delivered');
    // Falls back to SmsSid / SmsStatus and an 'unknown' status.
    expect(deriveNonce('/twilio/sms-status', { SmsSid: 'MM2' })).toBe('sms-status:MM2:unknown');
    expect(deriveNonce('/twilio/sms-status', {})).toBeNull();
  });

  it('keys voice status callbacks by CallSid + SequenceNumber', () => {
    expect(deriveNonce('/twilio/status', { CallSid: 'CA1', SequenceNumber: 3 })).toBe('status:CA1:3');
    expect(deriveNonce('/twilio/status', { CallSid: 'CA1', CallStatus: 'completed' })).toBe('status:CA1:completed');
    expect(deriveNonce('/twilio/status', {})).toBeNull();
  });

  it('keys inbound SMS by MessageSid', () => {
    expect(deriveNonce('/twilio/sms', { MessageSid: 'MM9' })).toBe('sms:MM9');
    expect(deriveNonce('/twilio/sms', {})).toBeNull();
  });

  it('keys voice and outbound webhooks by CallSid', () => {
    expect(deriveNonce('/twilio/voice', { CallSid: 'CA7' })).toBe('call:CA7');
    expect(deriveNonce('/twilio/outbound', { CallSid: 'CA8' })).toBe('call:CA8');
  });

  it('falls back to a best-effort key for unknown routes', () => {
    expect(deriveNonce('/twilio/whatever', { CallSid: 'CA5' })).toBe('twilio:CA5');
    expect(deriveNonce('/twilio/whatever', { MessageSid: 'MM5' })).toBe('twilio:MM5');
    expect(deriveNonce('/twilio/whatever', {})).toBeNull();
  });

  it('classifies the more specific /sms-status before the /sms and /status buckets', () => {
    // A naive substring check would mis-bucket this; assert it does not.
    const nonce = deriveNonce('/twilio/sms-status', { MessageSid: 'MM1', MessageStatus: 'sent' });
    expect(nonce?.startsWith('sms-status:')).toBe(true);
  });
});

describe('isReplay (in-memory layer)', () => {
  it('treats the first sighting as fresh and a repeat as a replay', async () => {
    expect(await isReplay('nonce-1')).toBe(false);
    expect(await isReplay('nonce-1')).toBe(true);
  });

  it('never flags an empty key', async () => {
    expect(await isReplay('')).toBe(false);
  });

  it('markSeen is a no-op (isReplay already claims atomically)', async () => {
    markSeen('nonce-x');
    expect(await isReplay('nonce-x')).toBe(false); // still fresh — markSeen did nothing
  });

  it('allows the same nonce again once its TTL window has elapsed', async () => {
    vi.useFakeTimers();
    try {
      process.env.TWILIO_REPLAY_WINDOW_SECONDS = '300';
      expect(await isReplay('nonce-ttl')).toBe(false);
      expect(await isReplay('nonce-ttl')).toBe(true);
      vi.advanceTimersByTime(301_000); // past the 5-minute window
      expect(await isReplay('nonce-ttl')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts oldest entries when the cache exceeds its cap', async () => {
    process.env.TWILIO_REPLAY_CACHE_MAX_ENTRIES = '2';
    await isReplay('a');
    await isReplay('b');
    await isReplay('c');
    expect(__getTwilioReplayCacheSizeForTests()).toBeLessThanOrEqual(2);
  });
});

describe('isReplay (durable backend)', () => {
  it('reports a replay when the durable backend says the nonce was already claimed', async () => {
    __setTwilioReplayDurableBackendForTests({ claim: vi.fn(async () => false) });
    expect(await isReplay('dup')).toBe(true);
  });

  it('reports fresh when the durable backend claims successfully', async () => {
    const claim = vi.fn(async () => true);
    __setTwilioReplayDurableBackendForTests({ claim });
    expect(await isReplay('new')).toBe(false);
    expect(claim).toHaveBeenCalledOnce();
  });

  it('fails open (treats as fresh) when the durable backend throws', async () => {
    __setTwilioReplayDurableBackendForTests({
      claim: vi.fn(async () => { throw new Error('db down'); }),
    });
    expect(await isReplay('blip')).toBe(false);
  });
});
