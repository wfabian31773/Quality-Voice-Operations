// @vitest-environment happy-dom
//
// Task #844: regression test for the dispatch notification template
// editor's hard-block when the rendered SMS body exceeds the tenant's
// segment cap. Mirrors the server-side enforcement covered by
// `tests/admin-api/dispatchMergeTokenWarning.test.ts` so a regression
// in the client-side disable can't quietly let a 2-segment template
// slip past the editor.

import * as React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AdminFormModal } from '../../client-app/src/pages/Dispatch';

void React;

afterEach(() => {
  cleanup();
});

// 161 GSM-7 chars -> 2 SMS segments. With the editor's renderer
// passing through (no merge tokens here) the count matches what the
// server's `checkSmsSegmentLimit` will see.
const BODY_OVER_CAP = 'a'.repeat(161);
// 159 GSM-7 chars -> 1 SMS segment, comfortably under any cap.
const BODY_UNDER_CAP = 'b'.repeat(159);

function Harness({
  initialBody,
  initialChannel = 'sms',
  smsSegmentLimit,
  onSave,
}: {
  initialBody: string;
  initialChannel?: string;
  smsSegmentLimit: number | null;
  onSave?: () => void;
}) {
  const [formData, setFormData] = React.useState<Record<string, unknown>>({
    name: 'Test template',
    trigger_event: 'en_route',
    channel: initialChannel,
    subject: '',
    body_template: initialBody,
    is_active: true,
  });
  return (
    <AdminFormModal
      formType="notification"
      formData={formData}
      setFormData={setFormData}
      smsSegmentLimit={smsSegmentLimit}
      onClose={() => {}}
      onSave={onSave ?? (() => {})}
    />
  );
}

describe('AdminFormModal SMS segment cap enforcement (task #844)', () => {
  it('disables Save and renders the blocked warning when the body exceeds the tenant cap', () => {
    render(<Harness initialBody={BODY_OVER_CAP} smsSegmentLimit={1} />);

    const save = screen.getByTestId('admin-form-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // The tooltip explains the math, mirroring the server's 400 error
    // message so a dispatcher who hits the API directly sees the same
    // segment count.
    expect(save.title).toMatch(/2 segments/);
    expect(save.title).toMatch(/caps dispatch SMS templates at 1/);
    expect(
      screen.getByTestId('notification-template-preview-segments-blocked'),
    ).toBeTruthy();
  });

  it('does not call onSave when the disabled Save button is clicked', () => {
    const onSave = vi.fn();
    render(
      <Harness
        initialBody={BODY_OVER_CAP}
        smsSegmentLimit={1}
        onSave={onSave}
      />,
    );

    const save = screen.getByTestId('admin-form-save') as HTMLButtonElement;
    fireEvent.click(save);
    // `disabled` buttons don't fire click handlers in React, so onSave
    // must stay untouched. Any regression that drops the disabled
    // flag would break this assertion immediately.
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps Save enabled when the body is under the tenant cap', () => {
    render(<Harness initialBody={BODY_UNDER_CAP} smsSegmentLimit={1} />);

    const save = screen.getByTestId('admin-form-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(
      screen.queryByTestId('notification-template-preview-segments-blocked'),
    ).toBeNull();
  });

  it('keeps Save enabled when the tenant has not opted into a cap (unlimited)', () => {
    // Default behavior — `smsSegmentLimit === null` means existing
    // 2+ segment templates keep working unchanged.
    render(<Harness initialBody={BODY_OVER_CAP} smsSegmentLimit={null} />);

    const save = screen.getByTestId('admin-form-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(
      screen.queryByTestId('notification-template-preview-segments-blocked'),
    ).toBeNull();
  });

  it('skips the cap entirely for email-only templates (no SMS billing)', () => {
    // The cap is about SMS billing; pasting a long welcome email
    // shouldn't be blocked because the channel doesn't ship over
    // carriers.
    render(
      <Harness
        initialBody={BODY_OVER_CAP}
        initialChannel="email"
        smsSegmentLimit={1}
      />,
    );

    const save = screen.getByTestId('admin-form-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(
      screen.queryByTestId('notification-template-preview-segments-blocked'),
    ).toBeNull();
  });

  it('blocks Save when the channel is "both" (email + SMS) and SMS is over cap', () => {
    render(
      <Harness
        initialBody={BODY_OVER_CAP}
        initialChannel="both"
        smsSegmentLimit={1}
      />,
    );

    const save = screen.getByTestId('admin-form-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(
      screen.getByTestId('notification-template-preview-segments-blocked'),
    ).toBeTruthy();
  });
});
