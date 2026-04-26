import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPermanentSmtpError as serverClassifier } from '../../platform/email/smtpErrorClass';
import { isPermanentSmtpError as clientClassifier } from '../../client-app/src/lib/smtpErrorClass';

const serverSrc = readFileSync(
  join(process.cwd(), 'platform/email/smtpErrorClass.ts'),
  'utf8',
);
const clientSrc = readFileSync(
  join(process.cwd(), 'client-app/src/lib/smtpErrorClass.ts'),
  'utf8',
);

function extractKeywordList(src: string): string[] {
  const m = src.match(/PERMANENT_KEYWORDS[^\[]*\[([\s\S]*?)\]/);
  if (!m) throw new Error('Could not find PERMANENT_KEYWORDS in source');
  return Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]);
}

describe('client/server SMTP classifier parity', () => {
  it('PERMANENT_KEYWORDS lists are identical', () => {
    expect(extractKeywordList(clientSrc)).toEqual(extractKeywordList(serverSrc));
  });

  // Core fixtures the server-side test already covers, plus a few client-only
  // edge cases (admin pastes the raw nodemailer message, leading whitespace,
  // mixed case, …). The two implementations must agree on every one of them.
  const FIXTURES: Array<{ msg: string; permanent: boolean; reason: string }> = [
    { msg: '', permanent: false, reason: 'empty string' },
    { msg: '550 5.1.1 user unknown', permanent: true, reason: '5xx + 5.x.x' },
    { msg: '550 mailbox unavailable', permanent: true, reason: '5xx code' },
    { msg: 'Mailbox not found', permanent: true, reason: 'keyword' },
    { msg: 'Recipient address rejected', permanent: true, reason: 'keyword' },
    { msg: '451 4.7.1 greylisted, try again', permanent: false, reason: '4.x.x' },
    { msg: '421 try again later', permanent: false, reason: '4xx' },
    { msg: 'connection refused', permanent: false, reason: 'transient default' },
    { msg: 'EENVELOPE: No recipients defined', permanent: true, reason: 'eenvelope keyword' },
    { msg: '   USER UNKNOWN   ', permanent: true, reason: 'case + whitespace insensitive' },
    {
      msg: '451 4.3.0 try again, mailbox not found right now',
      permanent: false,
      reason: '4.x.x dominates keyword',
    },
    { msg: 'relay access denied for sender', permanent: true, reason: 'keyword' },
  ];

  for (const f of FIXTURES) {
    it(`agrees on "${f.msg}" (${f.reason})`, () => {
      const fromServer = serverClassifier(f.msg);
      const fromClient = clientClassifier(f.msg);
      expect(fromClient).toBe(fromServer);
      expect(fromClient).toBe(f.permanent);
    });
  }

  it('null/undefined: both treat as not-permanent', () => {
    expect(clientClassifier(null)).toBe(false);
    expect(clientClassifier(undefined)).toBe(false);
    expect(serverClassifier(null)).toBe(false);
    expect(serverClassifier(undefined)).toBe(false);
  });
});
