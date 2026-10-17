import { countSmsSegments, type SmsEncoding } from '../../../shared/sms/segments';

/** Hard cap for any outbound body (template-rendered or free text). */
export const SMS_MAX_BODY_CHARS = 640;
const MAX_VAR_CHARS = 200;

export interface SmsTemplate {
  key: string;
  /** `{name}` placeholders are replaced with `vars.name`. */
  text: string;
  vars: readonly string[];
  /** Variables that must be https URLs (no other links are allowed in templates). */
  urlVars?: readonly string[];
  /** Templates the voice agent may request (through the `send_sms` wrapper). */
  agent: boolean;
  /** Per-variable length cap (default 200). */
  maxVarChars?: number;
  /**
   * Platform alerts to staff (on-call / owner / admin numbers). Only the
   * `system` actor may send them, and they skip the per-recipient rate limit.
   */
  staffAlert?: boolean;
}

// `csat_survey` and `ops_alert` are system-only templates whose single variable
// is text built by platform code, never the LLM: the CSAT wording an owner
// configured (stream.ts call-completed hook) and connector outage alerts to
// tenant admins (SyncErrorAlerter).
// `escalation_alert` and `autopilot_alert` keep the exact wording of the
// staff alerts sent by the SMS connector (call escalation) and the autopilot
// high-risk notifier; their variables are filled by platform code.
// `ops_alert`, `escalation_alert` and `autopilot_alert` are staff alerts
// (`staffAlert`): system-only and not rate limited per recipient, as before
// the chokepoint, so a busy on-call number still gets every alert.

const TEMPLATES: readonly SmsTemplate[] = [
  {
    key: 'confirmation',
    text: '{businessName}: you are confirmed for {summary}.',
    vars: ['businessName', 'summary'],
    agent: true,
  },
  {
    key: 'directions',
    text: '{businessName} is at {address}.',
    vars: ['businessName', 'address'],
    agent: true,
  },
  {
    key: 'link',
    text: "{businessName}: here's the link you asked for: {url}",
    vars: ['businessName', 'url'],
    urlVars: ['url'],
    agent: true,
  },
  {
    key: 'reminder_24h',
    text: '{businessName}: reminder, {summary} is tomorrow at {time}.',
    vars: ['businessName', 'summary', 'time'],
    agent: false,
  },
  {
    key: 'reminder_2h',
    text: '{businessName}: reminder, {summary} is today at {time}.',
    vars: ['businessName', 'summary', 'time'],
    agent: false,
  },
  {
    key: 'csat_survey',
    text: '{message}',
    vars: ['message'],
    agent: false,
    maxVarChars: SMS_MAX_BODY_CHARS,
  },
  {
    key: 'ops_alert',
    text: '{message}',
    vars: ['message'],
    agent: false,
    maxVarChars: SMS_MAX_BODY_CHARS,
    staffAlert: true,
  },
  {
    key: 'escalation_alert',
    text: '[ESCALATION ALERT]\nSession: {session}\nReason: {reason}\nTime: {time}',
    vars: ['session', 'reason', 'time'],
    agent: false,
    maxVarChars: SMS_MAX_BODY_CHARS,
    staffAlert: true,
  },
  {
    key: 'autopilot_alert',
    text: '[QVO Autopilot] {riskTier} RISK: {title}. {summary}. Log in to review.',
    vars: ['riskTier', 'title', 'summary'],
    agent: false,
    maxVarChars: SMS_MAX_BODY_CHARS,
    staffAlert: true,
  },
];

const BY_KEY = new Map(TEMPLATES.map((t) => [t.key, t]));

export type SmsTemplateKey =
  | 'confirmation'
  | 'directions'
  | 'link'
  | 'reminder_24h'
  | 'reminder_2h'
  | 'csat_survey'
  | 'ops_alert'
  | 'escalation_alert'
  | 'autopilot_alert';

export function getSmsTemplate(key: string): SmsTemplate | undefined {
  return BY_KEY.get(key);
}

export function listSmsTemplates(): SmsTemplate[] {
  return TEMPLATES.slice();
}

export function isAgentSmsTemplate(key: string): boolean {
  return BY_KEY.get(key)?.agent === true;
}

export function isStaffAlertSmsTemplate(key: string): boolean {
  return BY_KEY.get(key)?.staffAlert === true;
}

export type RenderResult =
  | { ok: true; body: string }
  | { ok: false; field: string; message: string };

export function renderSmsTemplate(key: string, vars: Record<string, string> | undefined): RenderResult {
  const template = BY_KEY.get(key);
  if (!template) return { ok: false, field: 'templateKey', message: `Unknown SMS template: ${key}` };
  const given = vars ?? {};
  for (const name of Object.keys(given)) {
    if (!template.vars.includes(name)) {
      return { ok: false, field: `vars.${name}`, message: `Template ${key} has no variable ${name}` };
    }
  }
  const limit = template.maxVarChars ?? MAX_VAR_CHARS;
  const values: Record<string, string> = {};
  for (const name of template.vars) {
    const value = typeof given[name] === 'string' ? given[name].trim() : '';
    if (!value) return { ok: false, field: `vars.${name}`, message: `Template ${key} needs ${name}` };
    if (value.length > limit) {
      return { ok: false, field: `vars.${name}`, message: `${name} is longer than ${limit} characters` };
    }
    if (template.urlVars?.includes(name) && !isHttpsUrl(value)) {
      return { ok: false, field: `vars.${name}`, message: `${name} must be an https link` };
    }
    values[name] = value;
  }
  const body = template.text.replace(/\{(\w+)\}/g, (_m, name: string) => values[name] ?? '');
  return { ok: true, body };
}

function isHttpsUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export interface BodyStats {
  characters: number;
  segments: number;
  encoding: SmsEncoding;
}

export function bodyStats(body: string): BodyStats {
  const info = countSmsSegments(body);
  return { characters: body.length, segments: info.segments, encoding: info.encoding };
}
