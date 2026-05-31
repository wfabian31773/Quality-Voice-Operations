import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlatformTwilioAdapter, createTwilioAdapterFromEnv } from './twilioAdapter';

function fakeResponse(init: { ok: boolean; status?: number; text?: string }): Response {
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    text: async () => init.text ?? '',
  } as Response;
}

const adapter = new PlatformTwilioAdapter({ accountSid: 'AC_test', authToken: 'tok_test' });
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlatformTwilioAdapter.terminateCall', () => {
  it('POSTs a completed-status update with basic auth and returns success', async () => {
    fetchSpy.mockResolvedValue(fakeResponse({ ok: true }));
    const result = await adapter.terminateCall('CA123');
    expect(result.success).toBe(true);

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test/Calls/CA123.json');
    expect(options.method).toBe('POST');
    expect((options.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    expect(String(options.body)).toContain('Status=completed');
  });

  it('surfaces a non-OK Twilio response as an error', async () => {
    fetchSpy.mockResolvedValue(fakeResponse({ ok: false, status: 404, text: 'not found' }));
    const result = await adapter.terminateCall('CA123');
    expect(result).toEqual({ success: false, error: 'Twilio API error: 404' });
  });

  it('returns the error when the request itself throws', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    const result = await adapter.terminateCall('CA123');
    expect(result.success).toBe(false);
    expect(result.error).toContain('network down');
  });
});

describe('PlatformTwilioAdapter.initiateTransfer', () => {
  it('POSTs a Dial TwiML to the target number and returns success', async () => {
    fetchSpy.mockResolvedValue(fakeResponse({ ok: true }));
    const result = await adapter.initiateTransfer('CA123', '+15551112222');
    expect(result.success).toBe(true);
    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(decodeURIComponent(String(options.body))).toContain('<Dial>+15551112222</Dial>');
  });

  it('surfaces a non-OK response as an error', async () => {
    fetchSpy.mockResolvedValue(fakeResponse({ ok: false, status: 401, text: 'unauthorized' }));
    expect(await adapter.initiateTransfer('CA123', '+1555')).toEqual({
      success: false,
      error: 'Twilio API error: 401',
    });
  });

  it('returns the error when the request throws', async () => {
    fetchSpy.mockRejectedValue(new Error('timeout'));
    const result = await adapter.initiateTransfer('CA123', '+1555');
    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
  });
});

describe('createTwilioAdapterFromEnv', () => {
  const saved = { sid: process.env.TWILIO_ACCOUNT_SID, tok: process.env.TWILIO_AUTH_TOKEN };
  afterEach(() => {
    if (saved.sid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
    else process.env.TWILIO_ACCOUNT_SID = saved.sid;
    if (saved.tok === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = saved.tok;
  });

  it('builds an adapter when both credentials are present', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC_env';
    process.env.TWILIO_AUTH_TOKEN = 'tok_env';
    expect(createTwilioAdapterFromEnv()).toBeInstanceOf(PlatformTwilioAdapter);
  });

  it('returns undefined when credentials are missing', () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    expect(createTwilioAdapterFromEnv()).toBeUndefined();
  });
});
