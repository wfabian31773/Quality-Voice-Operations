// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

void React;

vi.mock('../../client-app/src/lib/analytics', () => ({
  trackPageView: vi.fn(),
  trackCTAClick: vi.fn(),
  trackConversionEvent: vi.fn(),
  captureUtmOnLoad: vi.fn(),
}));

// Test builds fail open when signup-config cannot be read. Pin the fallback to
// what a production build resolves, so reaching it is visible in the UI.
vi.mock('../../client-app/src/lib/signupCaptcha', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../client-app/src/lib/signupCaptcha')>();
  return {
    ...actual,
    resolveCaptchaConfigAfterFetchFailure: () => actual.resolveCaptchaConfigAfterFetchFailure('', true),
  };
});

import BookDemo from '../../client-app/src/pages/public/BookDemo';

const submitButton = () => screen.getByRole('button', { name: /request demo/i }) as HTMLButtonElement;

function stubFetch(signupConfig: () => Response, bookDemo?: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/signup-config') return signupConfig();
    if (url === '/api/book-demo' && init?.method === 'POST' && bookDemo) return bookDemo();
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderBookDemo() {
  return render(
    <MemoryRouter initialEntries={['/book-demo']}>
      <BookDemo />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { turnstile?: unknown }).turnstile;
});

describe('BookDemo CAPTCHA', () => {
  it('passes the book-demo action to the widget and posts the token', async () => {
    let solve: (token: string) => void = () => {};
    const turnstile = {
      render: vi.fn((_el: HTMLElement, opts: Record<string, unknown>) => {
        solve = opts.callback as (token: string) => void;
        return 'widget-1';
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    (window as unknown as { turnstile?: unknown }).turnstile = turnstile;
    const fetchMock = stubFetch(
      () => Response.json({ captchaRequired: true, siteKey: '0xpublic-site-key' }),
      () => Response.json({ error: 'CAPTCHA verification failed. Please try again.' }, { status: 400 }),
    );
    const { container } = renderBookDemo();

    await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(1));
    expect(turnstile.render.mock.calls[0][1]).toMatchObject({
      sitekey: '0xpublic-site-key',
      action: 'book-demo',
    });
    act(() => solve('token-1'));

    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Ada Lovelace' } });
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText(/company/i), { target: { value: 'Analytical Engines' } });
    fireEvent.submit(container.querySelector('form')!);

    expect(await screen.findByText(/CAPTCHA verification failed/i)).toBeTruthy();
    const post = fetchMock.mock.calls.find(([url]) => url === '/api/book-demo');
    expect(JSON.parse(post![1]!.body as string)).toMatchObject({
      email: 'ada@example.com',
      captchaToken: 'token-1',
    });
  });

  it.each([
    ['a 502 with a JSON body', () => Response.json({ captchaRequired: false, siteKey: null }, { status: 502 })],
    ['a 200 with a non-JSON body', () => new Response('<html>Bad Gateway</html>', { status: 200 })],
  ])('uses the fetch-failure fallback on %s', async (_label, signupConfig) => {
    stubFetch(signupConfig);
    renderBookDemo();

    expect(await screen.findByTestId('book-demo-captcha-unavailable')).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it('trusts a successful signup-config response', async () => {
    stubFetch(() => Response.json({ captchaRequired: false, siteKey: null }));
    renderBookDemo();

    await waitFor(() => expect(submitButton().disabled).toBe(false));
    expect(screen.queryByTestId('book-demo-captcha-unavailable')).toBeNull();
  });
});
