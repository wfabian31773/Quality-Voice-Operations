// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock useRole so the editor doesn't have to wire up auth context.
vi.mock('../../client-app/src/lib/useRole', () => ({
  useRole: () => ({ isManager: true, isAdmin: true, role: 'manager' }),
}));

// Mock TooltipWalkthrough so we don't have to wire up its store.
vi.mock('../../client-app/src/components/TooltipWalkthrough', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import KnowledgeBase from '../../client-app/src/pages/KnowledgeBase';

void React;

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

let fetchHandler: FetchHandler | null = null;
let originalFetch: typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  originalFetch = global.fetch;
  global.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    fetchHandler!(String(url), init)) as typeof fetch;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  fetchHandler = null;
  vi.useRealTimers();
});

describe('KnowledgeBase article editor autosave', () => {
  it('queues a follow-up save when the user keeps typing during an in-flight save (no lost edits)', async () => {
    const patchedBodies: Array<Record<string, unknown>> = [];
    let releaseFirstPatch: () => void = () => {};
    let signalFirstPatchStarted: () => void = () => {};
    const firstPatchStarted = new Promise<void>((resolve) => {
      signalFirstPatchStarted = resolve;
    });

    let patchCallCount = 0;

    fetchHandler = async (url, init) => {
      // Initial list / categories fetch — return an article to edit.
      if (url.includes('/api/knowledge-articles?') && (!init || init.method === undefined)) {
        return jsonResponse({
          articles: [
            {
              id: 42,
              title: 'Existing',
              content: 'Existing body',
              category: null,
              metadata: {},
              status: 'active',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          total: 1,
          categories: [],
          limit: 100,
          offset: 0,
        });
      }
      // Documents list (other tab) — return empty.
      if (url.includes('/api/knowledge-documents') && (!init || init.method === undefined)) {
        return jsonResponse({ documents: [] });
      }
      // Single article fetch when modal opens.
      if (url.endsWith('/api/knowledge-articles/42') && (!init || init.method === undefined)) {
        return jsonResponse({
          article: {
            id: 42,
            title: 'Existing',
            content: 'Existing body',
            category: null,
            metadata: {},
            status: 'active',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        });
      }
      // PATCH save.
      if (url.endsWith('/api/knowledge-articles/42') && init?.method === 'PATCH') {
        patchCallCount += 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patchedBodies.push(body);
        if (patchCallCount === 1) {
          signalFirstPatchStarted();
          await new Promise<void>((resolve) => {
            releaseFirstPatch = resolve;
          });
        }
        return jsonResponse({
          article: {
            id: 42,
            title: body.title,
            content: body.content,
            category: body.category,
            metadata: {},
            status: body.status,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        });
      }
      return jsonResponse({}, 200);
    };

    renderWithClient(<KnowledgeBase />);

    // Switch to the Articles tab.
    const articlesTab = await screen.findByRole('button', { name: /Articles \(\d+\)/ });
    fireEvent.click(articlesTab);

    // Open the editor on the existing article.
    const editButton = await screen.findByTitle ?? null;
    void editButton;
    // The pencil button has no accessible name; query by the row contents.
    const editRow = await screen.findByText('Existing');
    const editTd = editRow.closest('tr');
    expect(editTd).toBeTruthy();
    const pencilBtn = editTd!.querySelectorAll('button');
    // Expect: pencil (edit), trash (delete) — click the first.
    fireEvent.click(pencilBtn[0]);

    // The article fetch happens — wait for the textarea to appear with existing body.
    const textarea = await screen.findByDisplayValue('Existing body');

    // Type the first edit. Advance timers past the autosave debounce.
    fireEvent.change(textarea, { target: { value: 'First edit' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // Wait until the first PATCH actually started (handler observed it).
    await firstPatchStarted;
    // First PATCH is in flight (handler is awaiting releaseFirstPatch).
    // Now type a second edit while the request is still pending.
    fireEvent.change(textarea, { target: { value: 'Second edit' } });
    // Allow the debounce to elapse; performSave should be called and chain
    // onto the in-flight promise instead of being dropped.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // Release the first PATCH. The chained save should now fire with the
    // latest content ("Second edit").
    releaseFirstPatch();

    await waitFor(() => {
      expect(patchCallCount).toBeGreaterThanOrEqual(2);
    });

    // The most recent PATCH must contain "Second edit" — proving the in-flight
    // edit was not lost.
    expect(patchedBodies[patchedBodies.length - 1].content).toBe('Second edit');
  });
});
