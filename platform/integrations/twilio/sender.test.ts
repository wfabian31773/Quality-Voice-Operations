import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  getPlatformPool: () => ({ query: async () => ({ rows: [] }) }),
}));

import { sendTwilioSms, twilioPost, TwilioApiError, TwilioSendOutcomeUnknownError } from './sender';

const creds = { accountSid: 'ACtest', apiKey: 'test', apiKeySecret: 'test', phoneNumber: '+13125550100' };
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv('TWILIO_ACCOUNT_SID', '');
  vi.stubEnv('TWILIO_AUTH_TOKEN', '');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Twilio send failure boundary', () => {
  it('fails locally without credentials, then sends after credentials are configured', async () => {
    const failed = sendTwilioSms('tenant-1', '+13125550142', creds.phoneNumber, 'hello');
    await expect(failed).rejects.toThrow('No Twilio credentials configured for tenant');
    await expect(failed).rejects.not.toBeInstanceOf(TwilioSendOutcomeUnknownError);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv('TWILIO_ACCOUNT_SID', creds.accountSid);
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'test');
    fetchMock.mockResolvedValueOnce(Response.json({ sid: 'SMtest', status: 'queued' }));
    await expect(sendTwilioSms('tenant-1', '+13125550142', creds.phoneNumber, 'hello'))
      .resolves.toEqual({ sid: 'SMtest', status: 'queued' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves request construction errors as definite local failures', async () => {
    const localError = new Error('Invalid request configuration');
    vi.stubGlobal('Request', class { constructor() { throw localError; } });
    await expect(twilioPost(creds, '/Messages.json', { Body: 'hello' })).rejects.toBe(localError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) }),
    new DOMException('Aborted', 'AbortError'),
    new DOMException('Timed out', 'TimeoutError'),
  ])('marks a network/abort/timeout failure as possibly sent (%s)', async (cause) => {
    fetchMock.mockRejectedValueOnce(cause);
    await expect(twilioPost(creds, '/Messages.json', { Body: 'hello' }))
      .rejects.toMatchObject({ name: 'TwilioSendOutcomeUnknownError', cause });
  });

  it('keeps an HTTP rejection definite even if the error body cannot be read', async () => {
    fetchMock.mockResolvedValueOnce(new Response('truncated', { status: 503 }));
    await expect(twilioPost(creds, '/Messages.json', {})).rejects.toBeInstanceOf(TwilioApiError);
  });

  it('protects an accepted request when its response body cannot be read', async () => {
    fetchMock.mockResolvedValueOnce(new Response('truncated', { status: 201 }));
    await expect(twilioPost(creds, '/Messages.json', {})).rejects.toBeInstanceOf(TwilioSendOutcomeUnknownError);
  });
});
