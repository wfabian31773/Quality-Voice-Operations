// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import Modal from '../../client-app/src/components/Modal';

void React;

afterEach(() => {
  cleanup();
});

function Harness({ open: initialOpen = true }: { open?: boolean }) {
  const [open, setOpen] = React.useState(initialOpen);
  return (
    <div>
      <button data-testid="opener" onClick={() => setOpen(true)}>
        Open
      </button>
      <Modal open={open} onClose={() => setOpen(false)} ariaLabel="Test dialog">
        <button data-testid="first">First</button>
        <button data-testid="middle">Middle</button>
        <button data-testid="last">Last</button>
      </Modal>
    </div>
  );
}

describe('Modal primitive', () => {
  it('renders with role="dialog" and aria-modal', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Test dialog');
  });

  it('focuses the first focusable element on open', async () => {
    render(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(document.activeElement).toBe(screen.getByTestId('first'));
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} ariaLabel="X">
        <button>Hi</button>
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('traps Tab cycle from last back to first', async () => {
    render(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    const first = screen.getByTestId('first') as HTMLButtonElement;
    const last = screen.getByTestId('last') as HTMLButtonElement;
    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('traps Shift+Tab from first back to last', async () => {
    render(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    const first = screen.getByTestId('first') as HTMLButtonElement;
    const last = screen.getByTestId('last') as HTMLButtonElement;
    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('restores focus to the previously focused element on close', async () => {
    function ToggleHarness() {
      const [open, setOpen] = React.useState(false);
      return (
        <div>
          <button data-testid="opener" onClick={() => setOpen(true)}>
            Open
          </button>
          <Modal open={open} onClose={() => setOpen(false)} ariaLabel="Test">
            <button data-testid="inner">Inner</button>
          </Modal>
        </div>
      );
    }
    render(<ToggleHarness />);
    const opener = screen.getByTestId('opener') as HTMLButtonElement;
    opener.focus();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(document.activeElement).toBe(screen.getByTestId('inner'));

    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(document.activeElement).toBe(opener);
  });
});
