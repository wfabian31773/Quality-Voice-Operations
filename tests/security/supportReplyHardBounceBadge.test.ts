import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const adminUiFile = readFileSync(
  join(process.cwd(), 'client-app/src/pages/PlatformAdmin.tsx'),
  'utf8',
);
const clientClassifier = readFileSync(
  join(process.cwd(), 'client-app/src/lib/smtpErrorClass.ts'),
  'utf8',
);

describe('PlatformAdmin support inbox — hard-bounce badge', () => {
  it('imports the client-side SMTP classifier', () => {
    expect(adminUiFile).toMatch(
      /import\s*\{\s*isPermanentSmtpError\s*\}\s*from\s*'\.\.\/lib\/smtpErrorClass'/,
    );
  });

  it('reuses the same regex/keyword shape as the server classifier so the parity test guards both', () => {
    expect(clientClassifier).toMatch(/PERMANENT_KEYWORDS/);
    expect(clientClassifier).toMatch(/4\\d\{2\}/);
    expect(clientClassifier).toMatch(/5\\d\{2\}/);
    expect(clientClassifier).toMatch(/export function isPermanentSmtpError/);
  });

  it('renders a distinct "Hard bounce — won\'t auto-retry" badge for permanent reply failures', () => {
    // Reply badge in the support TicketThread. The string lives in two forms:
    // - JSX text: `Hard bounce — won&rsquo;t auto-retry`
    // - JS literal: `Hard bounce — won\u2019t auto-retry`
    expect(adminUiFile).toMatch(
      /Hard bounce[^"<]*won(?:&rsquo;|\\u2019|\u2019|')t auto-retry/,
    );
    // Driven by classifying email_error client-side, gated on a permanent failure.
    expect(adminUiFile).toMatch(
      /isPermanentSmtpError\(\s*r\.email_error\s*\)/,
    );
  });

  it('annotates the docs-feedback "email-failure list" with the same hard-bounce indicator', () => {
    // The DocsFeedbackTab shows last_reply_error rows; they must run through
    // the same classifier so ops can filter / triage in one place.
    expect(adminUiFile).toMatch(
      /isPermanentSmtpError\(\s*c\.last_reply_error\s*\)/,
    );
  });

  it('annotates the ticket-level email_error indicator on the inbox row', () => {
    expect(adminUiFile).toMatch(
      /isPermanentSmtpError\(\s*t\.email_error\s*\)/,
    );
    expect(adminUiFile).toMatch(/email failed \(hard bounce\)/);
  });

  it('explains in the failed-reply detail why auto-retry was skipped', () => {
    expect(adminUiFile).toMatch(
      /permanent SMTP failure[\s\S]{0,120}auto-retry/i,
    );
  });
});
