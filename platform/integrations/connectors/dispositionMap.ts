export type DispositionMap = Record<string, { status: string; callDisposition?: string }>;

export type DispositionProvider = 'salesforce' | 'hubspot' | 'pipedrive';

export const DEFAULT_SALESFORCE_DISPOSITION_MAP: DispositionMap = {
  booked: { status: 'Completed', callDisposition: 'Booked Appointment' },
  no_answer: { status: 'Completed', callDisposition: 'No Answer' },
  spam: { status: 'Completed', callDisposition: 'Spam' },
  transferred: { status: 'Completed', callDisposition: 'Transferred' },
  completed: { status: 'Completed', callDisposition: 'Completed Call' },
};

export const DEFAULT_HUBSPOT_DISPOSITION_MAP: DispositionMap = {
  booked: { status: 'COMPLETED', callDisposition: 'Booked Appointment' },
  no_answer: { status: 'NO_ANSWER', callDisposition: 'No Answer' },
  spam: { status: 'COMPLETED', callDisposition: 'Spam' },
  transferred: { status: 'COMPLETED', callDisposition: 'Transferred' },
  completed: { status: 'COMPLETED', callDisposition: 'Completed Call' },
};

export const DEFAULT_PIPEDRIVE_DISPOSITION_MAP: DispositionMap = {
  booked: { status: 'meeting', callDisposition: 'Appointment Booked' },
  no_answer: { status: 'call', callDisposition: 'No Answer' },
  spam: { status: 'call', callDisposition: 'Spam Call' },
  transferred: { status: 'call', callDisposition: 'Call Transferred' },
  completed: { status: 'call', callDisposition: 'AI Voice Call' },
};

const DEFAULT_MAPS: Record<DispositionProvider, DispositionMap> = {
  salesforce: DEFAULT_SALESFORCE_DISPOSITION_MAP,
  hubspot: DEFAULT_HUBSPOT_DISPOSITION_MAP,
  pipedrive: DEFAULT_PIPEDRIVE_DISPOSITION_MAP,
};

const PROVIDER_LABELS: Record<DispositionProvider, string> = {
  salesforce: 'Salesforce',
  hubspot: 'HubSpot',
  pipedrive: 'Pipedrive',
};

const DISPOSITION_ALIASES: Record<string, string> = {
  appointment_booked: 'booked',
  noanswer: 'no_answer',
  no_response: 'no_answer',
  voicemail: 'no_answer',
  junk: 'spam',
  transfer: 'transferred',
  '': 'completed',
};

export function normalizeDispositionKey(disposition: string | undefined): string {
  const normalized = (disposition ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  return DISPOSITION_ALIASES[normalized] ?? normalized;
}

export function getDefaultDispositionMap(provider: DispositionProvider): DispositionMap {
  return DEFAULT_MAPS[provider];
}

export function parseDispositionMap(
  credentials: Record<string, string>,
  provider: DispositionProvider,
): DispositionMap | undefined {
  const raw = credentials.disposition_map;
  if (!raw || !raw.trim()) return undefined;
  const label = PROVIDER_LABELS[provider];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid ${label} disposition_map JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Invalid ${label} disposition_map: expected an object of { status, callDisposition } entries`,
    );
  }
  const result: DispositionMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(
        `Invalid ${label} disposition_map entry for "${key}": expected { status, callDisposition }`,
      );
    }
    const entry = value as Record<string, unknown>;
    const status = entry.status;
    const callDisposition = entry.callDisposition;
    if (typeof status !== 'string' || !status.trim()) {
      throw new Error(
        `Invalid ${label} disposition_map entry for "${key}": "status" is required and must be a non-empty string`,
      );
    }
    if (callDisposition !== undefined && typeof callDisposition !== 'string') {
      throw new Error(
        `Invalid ${label} disposition_map entry for "${key}": "callDisposition" must be a string when provided`,
      );
    }
    const normalizedKey = normalizeDispositionKey(key);
    result[normalizedKey] = {
      status: status.trim(),
      callDisposition:
        callDisposition === undefined ? undefined : (callDisposition as string).trim() || undefined,
    };
  }
  return result;
}

export function mapDisposition(
  provider: DispositionProvider,
  disposition: string | undefined,
  customMap?: DispositionMap,
): { status: string; callDisposition?: string } {
  const key = normalizeDispositionKey(disposition);
  const merged: DispositionMap = { ...DEFAULT_MAPS[provider], ...(customMap ?? {}) };
  const entry = merged[key];
  if (entry) return { status: entry.status, callDisposition: entry.callDisposition };
  const fallbackStatus = DEFAULT_MAPS[provider].completed?.status ?? 'COMPLETED';
  return { status: fallbackStatus, callDisposition: disposition };
}
