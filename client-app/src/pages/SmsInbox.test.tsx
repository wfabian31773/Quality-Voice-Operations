// @vitest-environment happy-dom
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

void React;

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: { userId: 'staff-1', role: 'tenant_owner' } }),
}));

import SmsInbox from './SmsInbox';

const conversation = {
  id: 'thread-1',
  tenantId: 'tenant-1',
  phoneNumberId: 'line-1',
  remoteNumber: 'test-recipient',
  status: 'open',
  assigneeUserId: null,
  assigneeTeam: null,
  priority: 'normal',
  pinned: false,
  unreadCount: 0,
  followUp: false,
  followUpAt: null,
  lastMessageAt: null,
  lastMessagePreview: null,
  contactName: 'Customer One',
  contactEmail: null,
  contactLocation: null,
  tags: [],
  createdAt: '2026-11-14T12:00:00.000Z',
};

const scheduledAt = '2026-12-01T10:00';

function sentResponse() {
  return {
    message: {
      id: `message-${apiMock.post.mock.calls.length}`,
      body: 'Thanks for your message',
      direction: 'outbound',
      status: 'sent',
      createdAt: '2026-11-14T12:00:00.000Z',
    },
  };
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.get.mockImplementation(async (path: string) => {
    if (path === '/sms-inbox/conversations') return { conversations: [] };
    if (path === '/sms-inbox/counts') {
      return { counts: { open: 2, pending: 0, closed: 0, escalated: 0, archived: 0, unread: 0, deferred: 0 } };
    }
    if (path === '/sms-inbox/deferred') return { deferred: [] };
    if (path.endsWith('/messages')) return { messages: [] };
    if (path.endsWith('/notes')) return { notes: [] };
    if (path.startsWith('/sms-inbox/threads?')) {
      return {
        conversations: [conversation, { ...conversation, id: 'thread-2', contactName: 'Customer Two' }],
        total: 2,
      };
    }
    throw new Error(`Unexpected GET: ${path}`);
  });
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function selectConversation(name: string) {
  const entry = await screen.findByText(name, { selector: 'span' });
  await act(async () => { fireEvent.click(entry); });
}

async function openComposer(schedule?: string) {
  render(<SmsInbox />);
  await selectConversation('Customer One');
  const input = await screen.findByPlaceholderText<HTMLInputElement>('Type your reply...');
  fireEvent.change(input, { target: { value: 'Thanks for your message' } });
  if (schedule) {
    fireEvent.click(screen.getByTitle('Schedule'));
    changeSchedule(schedule);
  }
  return input;
}

function changeSchedule(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="datetime-local"]');
  expect(input).not.toBeNull();
  fireEvent.change(input!, { target: { value } });
}

async function submit(input: HTMLInputElement) {
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
}

function keyForCall(index: number): string {
  const key = apiMock.post.mock.calls[index]?.[2]?.headers?.['Idempotency-Key'];
  expect(typeof key).toBe('string');
  expect(key.trim()).toBe(key);
  expect(key.length).toBeGreaterThan(0);
  expect(key.length).toBeLessThanOrEqual(128);
  return key;
}

describe('SMS inbox composer idempotency', () => {
  it.each([
    [400, { error: 'Invalid number' }],
    [409, { error: 'Key reused', reason: 'idempotency_key_reused' }],
    [403, { error: 'Recipient opted out', reason: 'recipient_opted_out', code: 'RECIPIENT_OPTED_OUT' }],
    [503, { error: 'SMS service not configured', reason: 'messaging_not_enabled' }],
    [422, {
      error: 'Failed to send message: Twilio API error: 401 Authenticate',
      reason: 'provider_rejected',
      code: 'PROVIDER_REJECTED',
      final: true,
    }],
  ])('retires the key after a definitive %s rejection so a later retry can send', async (status, body) => {
    const rejection = Object.assign(new Error(String(body.error)), { status, body });
    apiMock.post
      .mockRejectedValueOnce(rejection)
      .mockImplementation(async () => sentResponse());
    const input = await openComposer();

    await submit(input);
    const firstKey = keyForCall(0);
    expect(input.value).toBe('Thanks for your message');

    await submit(input);
    expect(apiMock.post).toHaveBeenCalledTimes(2);
    expect(keyForCall(1)).not.toBe(firstKey);
  });

  it.each([
    [0, null],
    [403, { error: 'Outside quiet hours', reason: 'sms_quiet_hours' }],
    [429, { error: 'Too many messages to this number; try again later' }],
    [500, { error: 'Failed to send message' }],
    [500, { error: 'Failed to send message: fetch failed' }],
    [503, { error: 'Service Unavailable' }],
  ])('keeps the key after an ambiguous %s failure (%j)', async (status, body) => {
    const failure = Object.assign(new Error('failed'), { status, body });
    apiMock.post
      .mockRejectedValueOnce(failure)
      .mockImplementation(async () => sentResponse());
    const input = await openComposer();

    await submit(input);
    const firstKey = keyForCall(0);
    await submit(input);
    expect(keyForCall(1)).toBe(firstKey);
  });

  it.each([undefined, scheduledAt])('reuses the header after failure and rotates it after success (schedule: %s)', async (schedule) => {
    apiMock.post
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockImplementation(async () => sentResponse());
    const input = await openComposer(schedule);

    await submit(input);
    expect(apiMock.post).toHaveBeenCalledTimes(1);
    const firstKey = keyForCall(0);
    expect(apiMock.post).toHaveBeenNthCalledWith(1, '/sms-inbox/threads/thread-1/messages', {
      body: 'Thanks for your message',
      ...(schedule ? { scheduledAt: schedule } : {}),
    }, { headers: { 'Idempotency-Key': firstKey } });
    expect(input.value).toBe('Thanks for your message');

    await submit(input);
    expect(apiMock.post).toHaveBeenCalledTimes(2);
    expect(keyForCall(1)).toBe(firstKey);
    expect(input.value).toBe('');

    // An intentional second message may have the exact same text and schedule.
    fireEvent.change(input, { target: { value: 'Thanks for your message' } });
    if (schedule) {
      fireEvent.click(screen.getByTitle('Schedule'));
      changeSchedule(schedule);
    }
    await submit(input);
    expect(apiMock.post).toHaveBeenCalledTimes(3);
    expect(keyForCall(2)).not.toBe(firstKey);
  });

  it('ignores Enter and click submissions in the same batch and while a request is pending', async () => {
    let resolveSend!: (value: ReturnType<typeof sentResponse>) => void;
    apiMock.post.mockReturnValue(new Promise(resolve => { resolveSend = resolve; }));
    const input = await openComposer();
    const button = screen.getByRole('button', { name: /^Send$/ });

    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.click(button);
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(apiMock.post).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(apiMock.post).toHaveBeenCalledTimes(1);

    await act(async () => { resolveSend(sentResponse()); });
    expect(input.value).toBe('');
  });

  it.each(['body', 'thread', 'scheduledAt'])('rotates the key when %s changes and after reverting it', async (field) => {
    apiMock.post.mockRejectedValue(new Error('Connection lost'));
    const input = await openComposer(scheduledAt);
    await submit(input);
    const firstKey = keyForCall(0);

    const changeDraft = async (revert: boolean) => {
      if (field === 'body') {
        fireEvent.change(input, { target: { value: revert ? 'Thanks for your message' : 'Updated reply' } });
      } else if (field === 'thread') {
        await selectConversation(revert ? 'Customer One' : 'Customer Two');
      } else {
        changeSchedule(revert ? scheduledAt : '2026-12-02T10:00');
      }
    };

    await changeDraft(false);
    await submit(input);
    expect(apiMock.post).toHaveBeenCalledTimes(2);
    const changedKey = keyForCall(1);
    expect(changedKey).not.toBe(firstKey);
    expect(apiMock.post.mock.calls[1][0]).toBe(`/sms-inbox/threads/${field === 'thread' ? 'thread-2' : 'thread-1'}/messages`);

    await changeDraft(true);
    await submit(input);
    const revertedKey = keyForCall(2);
    expect(revertedKey).not.toBe(firstKey);
    expect(revertedKey).not.toBe(changedKey);
  });

  it('rotates the key when a scheduled reply becomes an immediate reply', async () => {
    apiMock.post.mockRejectedValue(new Error('Connection lost'));
    const input = await openComposer(scheduledAt);
    await submit(input);
    const firstKey = keyForCall(0);

    fireEvent.click(screen.getByTitle('Schedule'));
    await submit(input);
    expect(apiMock.post.mock.calls[1][1]).toEqual({ body: 'Thanks for your message' });
    expect(keyForCall(1)).not.toBe(firstKey);
  });

  it.each(['randomUUID', 'crypto'])('generates distinct valid fallback keys without %s', async (missing) => {
    const crypto = globalThis.crypto;
    vi.stubGlobal('crypto', missing === 'crypto' ? undefined : {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    });
    apiMock.post.mockImplementation(async () => sentResponse());
    const input = await openComposer();
    await submit(input);
    const firstKey = keyForCall(0);

    fireEvent.change(input, { target: { value: 'Another reply' } });
    await submit(input);
    expect(keyForCall(1)).not.toBe(firstKey);
  });
});
