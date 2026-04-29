// @vitest-environment happy-dom
//
// Regression test for task #845: the admin SMS-inbox composer must
// render the same live "X characters · Y segment(s)" indicator the
// dispatch template editor got in task #824, so an agent who pastes a
// long reply or sneaks in an em-dash (forcing UCS-2 and halving the
// per-segment budget to 70) sees the segment count jump immediately
// instead of finding out from the next Twilio bill.
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';

import SmsInbox from '../../client-app/src/pages/SmsInbox';

void React;

function makeFakeJwt(payload: Record<string, unknown>): string {
  const b64 = (s: string) =>
    Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '');
  return [
    b64(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    b64(JSON.stringify(payload)),
    'sig',
  ].join('.');
}

function loginAsManager() {
  // SmsInbox reads the JWT out of localStorage on import via
  // `initUserFromStorage`, so the role check (`tenant_owner` /
  // `operations_manager`) needs to be true before we render.
  localStorage.setItem(
    'auth_token',
    makeFakeJwt({
      sub: 'user-1',
      tenantId: 'tenant-1',
      email: 'manager@tenant.dev',
      role: 'tenant_owner',
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    }),
  );
}

const PHONE_LINE = {
  phoneNumberId: 'pn-1',
  phoneNumber: '+15551112222',
  friendlyName: 'Main',
};

const CONVERSATION = {
  id: 'conv-1',
  tenantId: 'tenant-1',
  phoneNumberId: 'pn-1',
  remoteNumber: '+15553334444',
  status: 'open',
  assigneeUserId: null,
  assigneeTeam: null,
  priority: 'normal',
  pinned: false,
  unreadCount: 0,
  followUp: false,
  followUpAt: null,
  lastMessageAt: '2024-01-01T00:00:00.000Z',
  lastMessagePreview: 'hello',
  contactName: 'Jane Customer',
  contactEmail: null,
  contactLocation: null,
  tags: [],
  createdAt: '2024-01-01T00:00:00.000Z',
};

let originalFetch: typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  localStorage.clear();
  loginAsManager();

  originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');

    // Initial bootstrap: phone lines + status counts.
    if (path.startsWith('/sms-inbox/conversations')) {
      return jsonResponse({ conversations: [PHONE_LINE] });
    }
    if (path.startsWith('/sms-inbox/counts')) {
      return jsonResponse({
        counts: {
          open: 1,
          pending: 0,
          closed: 0,
          escalated: 0,
          archived: 0,
          unread: 0,
        },
      });
    }
    // Conversation list (re-fetched whenever the filter changes).
    if (path.startsWith('/sms-inbox/threads?')) {
      return jsonResponse({ conversations: [CONVERSATION], total: 1 });
    }
    // Selecting a conversation pulls its messages + notes.
    if (path.endsWith('/messages') && path.includes('/threads/')) {
      return jsonResponse({ messages: [] });
    }
    if (path.endsWith('/notes') && path.includes('/threads/')) {
      return jsonResponse({ notes: [] });
    }

    // Catch-all so an unexpected endpoint doesn't break the render
    // (and so a regression that adds an extra fetch surfaces as a
    // visible 200 instead of an Unauthorized redirect).
    return jsonResponse({});
  }) as typeof fetch;

  // The SmsInbox layout uses scrollIntoView on the messages-end
  // sentinel; happy-dom doesn't ship the API.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  localStorage.clear();
});

async function openConversationAndGetReplyInput(): Promise<HTMLInputElement> {
  render(<SmsInbox />);

  // Wait for the loading skeleton to be replaced by the inbox.
  const conversationButton = await screen.findByText('Jane Customer');
  await act(async () => {
    fireEvent.click(conversationButton);
  });

  // The composer is a text input with placeholder "Type your reply..."
  const input = await screen.findByPlaceholderText(/type your reply/i);
  return input as HTMLInputElement;
}

describe('SmsInbox composer segment indicator', () => {
  it('hides the indicator when the composer is empty so we do not show "0 segments"', async () => {
    await openConversationAndGetReplyInput();
    expect(
      screen.queryByTestId('sms-inbox-composer-segments'),
    ).toBeNull();
  });

  it('updates the character + segment count live as the operator types a GSM-7 message', async () => {
    const input = await openConversationAndGetReplyInput();

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Hello dispatcher!' } });
    });

    const indicator = await screen.findByTestId('sms-inbox-composer-segments');
    // Plain ASCII -> GSM-7, one segment, no warning.
    expect(indicator.dataset.encoding).toBe('GSM-7');
    expect(indicator.dataset.segments).toBe('1');
    expect(indicator.textContent).toContain('17 characters');
    expect(indicator.textContent).toContain('1 segment');
    expect(indicator.textContent).not.toContain('Unicode');
    expect(
      screen.queryByTestId('sms-inbox-composer-segments-warning'),
    ).toBeNull();
  });

  it('warns when a long GSM-7 message tips into a second segment so the agent sees the doubled bill', async () => {
    const input = await openConversationAndGetReplyInput();

    await act(async () => {
      fireEvent.change(input, { target: { value: 'a'.repeat(161) } });
    });

    const indicator = await screen.findByTestId('sms-inbox-composer-segments');
    expect(indicator.dataset.encoding).toBe('GSM-7');
    expect(indicator.dataset.segments).toBe('2');
    expect(indicator.textContent).toContain('161 characters');
    expect(indicator.textContent).toContain('2 segments');

    const warning = screen.getByTestId(
      'sms-inbox-composer-segments-warning',
    );
    // The amber warning has to explain *why* the message just got
    // more expensive — "billed as 2 SMS" is the load-bearing phrase.
    expect(warning.textContent).toMatch(/billed as 2 SMS/i);
    expect(warning.textContent).toMatch(/160 characters/i);
  });

  it('flips to UCS-2 and explains the dropped 70-char budget when an em-dash sneaks in', async () => {
    const input = await openConversationAndGetReplyInput();

    // An em-dash is the canonical foot-gun: it's not in the GSM-7
    // table, so the carrier silently encodes the entire body as
    // UCS-2 and the per-segment budget halves to 70.
    await act(async () => {
      fireEvent.change(input, {
        target: { value: 'Thanks for getting in touch — we will be right with you.' },
      });
    });

    const indicator = await screen.findByTestId('sms-inbox-composer-segments');
    expect(indicator.dataset.encoding).toBe('UCS-2');
    expect(indicator.textContent).toContain('(Unicode)');

    const warning = screen.getByTestId(
      'sms-inbox-composer-segments-warning',
    );
    // The agent has to know the reason the message just got more
    // expensive — call out the non-GSM character + the 70-char drop.
    expect(warning.textContent).toMatch(/non-GSM character/i);
    expect(warning.textContent).toMatch(/70/);
  });

  it('reflects the live count after the composer is updated programmatically (e.g. AI Draft / template insert)', async () => {
    const input = await openConversationAndGetReplyInput();

    // First render: short body.
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Hi' } });
    });
    let indicator = await screen.findByTestId('sms-inbox-composer-segments');
    expect(indicator.textContent).toContain('2 characters');
    expect(indicator.dataset.segments).toBe('1');

    // Same composer, updated body — the indicator must re-render
    // without a remount, so a template insertion or AI draft can't
    // leave a stale count behind.
    await act(async () => {
      fireEvent.change(input, { target: { value: 'a'.repeat(161) } });
    });
    indicator = await screen.findByTestId('sms-inbox-composer-segments');
    expect(indicator.dataset.segments).toBe('2');
    expect(indicator.textContent).toContain('161 characters');

    // Clearing the composer hides the indicator again.
    await act(async () => {
      fireEvent.change(input, { target: { value: '' } });
    });
    await waitFor(() =>
      expect(
        screen.queryByTestId('sms-inbox-composer-segments'),
      ).toBeNull(),
    );
  });
});
