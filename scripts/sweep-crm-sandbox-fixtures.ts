/**
 * Weekly cleanup sweep for leftover sandbox booking fixtures.
 *
 * For each configured CRM sandbox (HubSpot, Salesforce, Pipedrive, Zoho),
 * deletes fixture records left behind by `appointmentBooked.integration
 * .test.ts` (Apt Booked Co company, apt-booked-*@example.invalid email,
 * +1555 phone, "<company> - QVO Appointment" deal) older than 24h, plus
 * their associated notes/tasks/activities. Children are deleted before
 * parents. Salesforce REST DELETE is soft-delete; the sweep follows up
 * with SOAP `emptyRecycleBin` for true hard-delete (best-effort).
 *
 * Operational details (cron schedule, secret matrix, alerting, hard-
 * delete prerequisites): docs/runbooks/crm-sandbox-credentials.md
 * (Appendix → Automated fixture-namespace sweep).
 *
 * Local: `npx tsx scripts/sweep-crm-sandbox-fixtures.ts --dry-run`
 * CI:    `.github/workflows/crm-sandbox-fixture-sweep.yml`
 */

const COMPANY_PREFIX = 'Apt Booked Co';
const EMAIL_PREFIX = 'apt-booked-';
const EMAIL_SUFFIX = '@example.invalid';
const PHONE_PREFIX = '+1555';
const DEAL_NAME_SUFFIX = ' - QVO Appointment'; // adapter convention

const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

// Cap how many rows we touch per (provider, object) per run. A blown-up
// sweep (e.g. months of accumulated leaks after the suite stabilises) is
// fine to chip away at across multiple weekly runs — far better than
// trying to delete thousands of rows in one CI run and tripping a rate
// limit halfway through.
const PER_OBJECT_DELETE_CAP = 200;

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has('--dry-run');

const overrideMin = process.env.SWEEP_MIN_AGE_MINUTES
  ? Number(process.env.SWEEP_MIN_AGE_MINUTES)
  : undefined;
const MIN_AGE_MS =
  overrideMin && Number.isFinite(overrideMin) && overrideMin > 0
    ? overrideMin * 60 * 1000
    : DEFAULT_MIN_AGE_MS;

const NOW_MS = Date.now();
const CUTOFF_MS = NOW_MS - MIN_AGE_MS;
const CUTOFF_ISO = new Date(CUTOFF_MS).toISOString();

// ---------------------------------------------------------------------------
// Result accounting
// ---------------------------------------------------------------------------

type ObjectKind = 'contacts' | 'companies' | 'deals' | 'notes' | 'leads';

type ProviderResult = {
  provider: 'hubspot' | 'salesforce' | 'pipedrive' | 'zoho';
  status: 'skipped' | 'ok' | 'failed';
  reason?: string;
  scanned: Partial<Record<ObjectKind, number>>;
  deleted: Partial<Record<ObjectKind, number>>;
  errors: string[];
};

function emptyCounts(): Partial<Record<ObjectKind, number>> {
  return {};
}

function inc(map: Partial<Record<ObjectKind, number>>, key: ObjectKind, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function totalDeleted(r: ProviderResult): number {
  return Object.values(r.deleted).reduce((a, b) => a + (b ?? 0), 0);
}

function totalScanned(r: ProviderResult): number {
  return Object.values(r.scanned).reduce((a, b) => a + (b ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Helpers (pure — exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Returns true when a record's claimed creation timestamp is at or
 * before the configured cutoff. Records with no parseable creation
 * timestamp are treated as "too new to be sure" and skipped, so a
 * provider returning a missing/garbled timestamp can't cause us to
 * delete an in-flight fixture.
 */
export function isOldEnough(createdAtMs: number | undefined, cutoffMs: number): boolean {
  if (createdAtMs === undefined || !Number.isFinite(createdAtMs)) return false;
  return createdAtMs <= cutoffMs;
}

/**
 * True when the row's surface identifiers match this suite's per-run
 * synthetic namespace. We require BOTH the namespace match AND
 * `isOldEnough` before deleting; this function only validates the
 * namespace half so each provider's record-shape can plug it in.
 */
export function isFixtureName(name: string | undefined | null): boolean {
  if (!name) return false;
  return name.startsWith(`${COMPANY_PREFIX} `) || name.startsWith(COMPANY_PREFIX);
}

export function isFixtureEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  return email.startsWith(EMAIL_PREFIX) && email.endsWith(EMAIL_SUFFIX);
}

export function isFixturePhone(phone: string | undefined | null): boolean {
  if (!phone) return false;
  // Normalise out non-digit/+ chars before matching — providers normalise
  // phones differently on storage (Pipedrive returns `+1555…` raw, HubSpot
  // strips formatting for some accounts, Zoho echoes input verbatim).
  const normalised = String(phone).replace(/[^\d+]/g, '');
  return normalised.startsWith(PHONE_PREFIX);
}

export function isFixtureDealName(dealName: string | undefined | null): boolean {
  if (!dealName) return false;
  // Adapter convention: `${company} - QVO Appointment`. We only sweep
  // deals whose company half also matches the namespace so we can never
  // delete a customer's deal that happens to end in " - QVO Appointment".
  if (!dealName.endsWith(DEAL_NAME_SUFFIX)) return false;
  const companyPart = dealName.slice(0, dealName.length - DEAL_NAME_SUFFIX.length);
  return isFixtureName(companyPart);
}

// ---------------------------------------------------------------------------
// Search-criteria builders (pure — exported for unit tests)
//
// Contacts/Leads are matched by EITHER the synthetic email OR the
// synthetic phone (so a caller-ID-only fixture is still swept).
// ---------------------------------------------------------------------------

export type HubspotFilterGroup = {
  filters: Array<{ propertyName: string; operator: string; value: string }>;
};

/**
 * HubSpot CRM Search request body for the contacts object. Multiple
 * filterGroups are OR'd together at the top level — one for the email
 * prefix, one for the phone prefix — so a contact matching either is
 * returned. Each group also pins on `hs_createdate < cutoff` to avoid
 * pulling young rows we'd discard anyway.
 */
export function buildHubspotContactSearchBody(cutoffMs: number, limit: number): {
  filterGroups: HubspotFilterGroup[];
  properties: string[];
  limit: number;
  sorts: unknown[];
} {
  const cutoff = String(cutoffMs);
  return {
    filterGroups: [
      {
        filters: [
          { propertyName: 'email', operator: 'STARTS_WITH', value: EMAIL_PREFIX },
          { propertyName: 'hs_createdate', operator: 'LT', value: cutoff },
        ],
      },
      {
        filters: [
          { propertyName: 'phone', operator: 'STARTS_WITH', value: PHONE_PREFIX },
          { propertyName: 'hs_createdate', operator: 'LT', value: cutoff },
        ],
      },
    ],
    properties: ['email', 'phone', 'hs_createdate'],
    limit,
    sorts: [{ propertyName: 'hs_createdate', direction: 'ASCENDING' }],
  };
}

/**
 * SOQL for Salesforce Contact: email OR phone OR mobilePhone matches the
 * fixture namespace, AND record is older than cutoff.
 */
export function buildSalesforceContactQuery(cutoffIso: string, limit: number): string {
  return (
    `SELECT Id, Email, Phone, MobilePhone, CreatedDate FROM Contact ` +
    `WHERE (Email LIKE '${EMAIL_PREFIX}%${EMAIL_SUFFIX}' ` +
    `OR Phone LIKE '${PHONE_PREFIX}%' ` +
    `OR MobilePhone LIKE '${PHONE_PREFIX}%') ` +
    `AND CreatedDate < ${cutoffIso} LIMIT ${limit}`
  );
}

/** SOQL for Salesforce Lead: same OR rule as Contact, plus IsConverted=false. */
export function buildSalesforceLeadQuery(cutoffIso: string, limit: number): string {
  return (
    `SELECT Id, Email, Phone, MobilePhone, CreatedDate, IsConverted FROM Lead ` +
    `WHERE (Email LIKE '${EMAIL_PREFIX}%${EMAIL_SUFFIX}' ` +
    `OR Phone LIKE '${PHONE_PREFIX}%' ` +
    `OR MobilePhone LIKE '${PHONE_PREFIX}%') ` +
    `AND CreatedDate < ${cutoffIso} AND IsConverted = false LIMIT ${limit}`
  );
}

/** COQL for Zoho Contacts: email OR Phone OR Mobile matches the fixture namespace. */
export function buildZohoContactQuery(cutoffIso: string, limit: number): string {
  return (
    `select id, Email, Phone, Mobile, Created_Time from Contacts ` +
    `where (Email like '${EMAIL_PREFIX}%${EMAIL_SUFFIX}' ` +
    `or Phone like '${PHONE_PREFIX}%' ` +
    `or Mobile like '${PHONE_PREFIX}%') ` +
    `and Created_Time < '${cutoffIso}' limit ${limit}`
  );
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

type FetchInit = RequestInit & { timeoutMs?: number };

async function http(url: string, init: FetchInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson<T>(res: Response): Promise<T | null> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

async function sweepHubSpot(): Promise<ProviderResult> {
  const result: ProviderResult = {
    provider: 'hubspot',
    status: 'skipped',
    scanned: emptyCounts(),
    deleted: emptyCounts(),
    errors: [],
  };

  const token = process.env.HUBSPOT_SANDBOX_ACCESS_TOKEN;
  if (!token) {
    result.reason = 'HUBSPOT_SANDBOX_ACCESS_TOKEN not set';
    return result;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const search = async (
    object: 'contacts' | 'companies' | 'deals',
    filterGroups: unknown[],
    properties: string[],
  ): Promise<Array<{ id: string; properties: Record<string, string> }>> => {
    // HubSpot's CRM search caps at 200 results per page; we paginate
    // until we hit the per-object cap so a backlog gets chipped away
    // across runs without exploding the request count in a single run.
    const out: Array<{ id: string; properties: Record<string, string> }> = [];
    let after: string | undefined;
    while (out.length < PER_OBJECT_DELETE_CAP) {
      const body: Record<string, unknown> = {
        filterGroups,
        properties,
        limit: Math.min(100, PER_OBJECT_DELETE_CAP - out.length),
        sorts: [{ propertyName: 'hs_createdate', direction: 'ASCENDING' }],
      };
      if (after) body.after = after;
      const res = await http(`https://api.hubapi.com/crm/v3/objects/${object}/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`HubSpot ${object} search failed: HTTP ${res.status}`);
      }
      const payload = (await readJson<{
        results?: Array<{ id?: string; properties?: Record<string, string> }>;
        paging?: { next?: { after?: string } };
      }>(res)) ?? {};
      const page = payload.results ?? [];
      for (const row of page) {
        if (!row.id) continue;
        out.push({ id: row.id, properties: row.properties ?? {} });
        if (out.length >= PER_OBJECT_DELETE_CAP) break;
      }
      after = payload.paging?.next?.after;
      if (!after || page.length === 0) break;
    }
    return out;
  };

  const del = async (object: 'contacts' | 'companies' | 'deals' | 'notes', id: string): Promise<void> => {
    if (DRY_RUN) return;
    const res = await http(
      `https://api.hubapi.com/crm/v3/objects/${object}/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers },
    );
    // 204 = deleted, 404 = already gone (someone else swept first); both fine.
    if (!res.ok && res.status !== 404) {
      throw new Error(`HubSpot ${object}/${id} delete failed: HTTP ${res.status}`);
    }
  };

  // Notes are identified by association (their bodies aren't fixture-
  // distinct). Delete children before parents.
  const listAssociatedNoteIds = async (
    parentObject: 'companies' | 'contacts' | 'deals',
    parentId: string,
  ): Promise<string[]> => {
    const url = `https://api.hubapi.com/crm/v4/objects/${parentObject}/${encodeURIComponent(
      parentId,
    )}/associations/notes?limit=500`;
    const res = await http(url, { headers });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`HubSpot ${parentObject}/${parentId} associations failed: HTTP ${res.status}`);
    const body =
      (await readJson<{ results?: Array<{ toObjectId?: string | number }> }>(res)) ?? {};
    return (body.results ?? [])
      .map((r) => (r.toObjectId !== undefined ? String(r.toObjectId) : ''))
      .filter((id) => id.length > 0);
  };

  try {
    // 1. Search for the three fixture parent types and collect their IDs.
    const companies = await search(
      'companies',
      [
        {
          filters: [
            { propertyName: 'name', operator: 'STARTS_WITH', value: COMPANY_PREFIX },
            { propertyName: 'hs_createdate', operator: 'LT', value: String(CUTOFF_MS) },
          ],
        },
      ],
      ['name', 'hs_createdate'],
    );
    inc(result.scanned, 'companies', companies.length);
    const fixtureCompanies = companies.filter(
      (row) =>
        isFixtureName(row.properties.name) &&
        isOldEnough(Number(row.properties.hs_createdate), CUTOFF_MS),
    );

    // Email OR phone — see buildHubspotContactSearchBody.
    const contactBody = buildHubspotContactSearchBody(CUTOFF_MS, PER_OBJECT_DELETE_CAP);
    const contacts = await search('contacts', contactBody.filterGroups, contactBody.properties);
    inc(result.scanned, 'contacts', contacts.length);
    const fixtureContacts = contacts.filter(
      (row) =>
        (isFixtureEmail(row.properties.email) || isFixturePhone(row.properties.phone)) &&
        isOldEnough(Number(row.properties.hs_createdate), CUTOFF_MS),
    );

    const deals = await search(
      'deals',
      [
        {
          filters: [
            { propertyName: 'dealname', operator: 'STARTS_WITH', value: COMPANY_PREFIX },
            { propertyName: 'hs_createdate', operator: 'LT', value: String(CUTOFF_MS) },
          ],
        },
      ],
      ['dealname', 'hs_createdate'],
    );
    inc(result.scanned, 'deals', deals.length);
    const fixtureDeals = deals.filter(
      (row) =>
        isFixtureDealName(row.properties.dealname) &&
        isOldEnough(Number(row.properties.hs_createdate), CUTOFF_MS),
    );

    // 2. Collect associated note IDs from every fixture parent. Use a
    //    Set because the same note can be associated with multiple
    //    fixture parents (e.g. attached to both a contact and a deal).
    const noteIds = new Set<string>();
    for (const c of fixtureCompanies) {
      for (const id of await listAssociatedNoteIds('companies', c.id)) noteIds.add(id);
    }
    for (const c of fixtureContacts) {
      for (const id of await listAssociatedNoteIds('contacts', c.id)) noteIds.add(id);
    }
    for (const d of fixtureDeals) {
      for (const id of await listAssociatedNoteIds('deals', d.id)) noteIds.add(id);
    }
    inc(result.scanned, 'notes', noteIds.size);

    // 3. Delete notes first (children before parents).
    let notesDeletedSoFar = 0;
    for (const id of noteIds) {
      if (notesDeletedSoFar >= PER_OBJECT_DELETE_CAP) break;
      await del('notes', id);
      inc(result.deleted, 'notes');
      notesDeletedSoFar++;
    }

    // 4. Delete the fixture parents themselves.
    for (const row of fixtureDeals) {
      await del('deals', row.id);
      inc(result.deleted, 'deals');
    }
    for (const row of fixtureContacts) {
      await del('contacts', row.id);
      inc(result.deleted, 'contacts');
    }
    for (const row of fixtureCompanies) {
      await del('companies', row.id);
      inc(result.deleted, 'companies');
    }

    result.status = 'ok';
  } catch (err) {
    result.status = 'failed';
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Salesforce
// ---------------------------------------------------------------------------

async function sweepSalesforce(): Promise<ProviderResult> {
  const result: ProviderResult = {
    provider: 'salesforce',
    status: 'skipped',
    scanned: emptyCounts(),
    deleted: emptyCounts(),
    errors: [],
  };

  const token = process.env.SALESFORCE_SANDBOX_ACCESS_TOKEN;
  const instance = process.env.SALESFORCE_SANDBOX_INSTANCE_URL;
  if (!token || !instance) {
    result.reason = 'SALESFORCE_SANDBOX_ACCESS_TOKEN / _INSTANCE_URL not set';
    return result;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const query = async <T>(soql: string): Promise<T[]> => {
    // Single-page query; PER_OBJECT_DELETE_CAP enforced via SOQL LIMIT.
    const url = `${instance}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`;
    const res = await http(url, { headers });
    if (!res.ok) throw new Error(`Salesforce query failed: HTTP ${res.status} (${soql.slice(0, 80)})`);
    const body = (await readJson<{ records?: T[] }>(res)) ?? {};
    return body.records ?? [];
  };

  const del = async (sobject: string, id: string): Promise<void> => {
    if (DRY_RUN) return;
    const res = await http(
      `${instance}/services/data/v60.0/sobjects/${sobject}/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Salesforce ${sobject}/${id} delete failed: HTTP ${res.status}`);
    }
  };

  // SOQL `IN` clauses can carry plenty of IDs, but to keep query
  // strings under Salesforce's URI length limit we batch the parent
  // IDs into chunks of 50 when issuing the child-lookup queries.
  const CHILD_QUERY_BATCH = 50;
  const chunks = <T>(arr: T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };
  const quoteIdList = (ids: string[]): string => ids.map((id) => `'${id}'`).join(',');

  // True hard-delete (REST DELETE only soft-deletes into the Recycle
  // Bin). Best-effort: failure is logged to errors[] without failing
  // the run — see runbook for the Bulk API Hard Delete permission.
  const emptyRecycleBin = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    if (DRY_RUN) return;
    // Salesforce caps emptyRecycleBin at 200 IDs per call.
    for (const batch of chunks(ids, 200)) {
      const idElems = batch.map((id) => `<urn:ids>${id}</urn:ids>`).join('');
      const envelope =
        `<?xml version="1.0" encoding="utf-8"?>` +
        `<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/" ` +
        `xmlns:urn="urn:partner.soap.sforce.com">` +
        `<env:Header><urn:SessionHeader><urn:sessionId>${token}</urn:sessionId>` +
        `</urn:SessionHeader></env:Header>` +
        `<env:Body><urn:emptyRecycleBin>${idElems}</urn:emptyRecycleBin></env:Body>` +
        `</env:Envelope>`;
      const res = await http(`${instance}/services/Soap/u/60.0`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=UTF-8',
          SOAPAction: '""',
        },
        body: envelope,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // Don't fail the run — soft-delete is still in effect and
        // Salesforce auto-purges after 15 days.
        result.errors.push(
          `Salesforce emptyRecycleBin returned HTTP ${res.status}; ` +
            `${batch.length} record(s) remain soft-deleted (Recycle Bin auto-purges after 15 days). ` +
            `If this persists, grant the integration user the "Bulk API Hard Delete" profile permission. ` +
            `Response head: ${text.slice(0, 200)}`,
        );
        return;
      }
    }
  };

  try {
    // Note: SOQL string literals would need single-quote escaping, but
    // our synthetic namespace contains none.
    const cap = PER_OBJECT_DELETE_CAP;
    const allDeletedIds: string[] = [];

    // 1. Search for the four fixture parent types and collect IDs.
    const accounts = await query<{ Id: string; Name: string; CreatedDate: string }>(
      `SELECT Id, Name, CreatedDate FROM Account WHERE Name LIKE '${COMPANY_PREFIX}%' AND CreatedDate < ${CUTOFF_ISO} LIMIT ${cap}`,
    );
    inc(result.scanned, 'companies', accounts.length);
    const fixtureAccounts = accounts.filter(
      (r) => isFixtureName(r.Name) && isOldEnough(Date.parse(r.CreatedDate), CUTOFF_MS),
    );

    // Email OR Phone OR MobilePhone — see buildSalesforceContactQuery.
    const contacts = await query<{
      Id: string; Email: string | null; Phone: string | null; MobilePhone: string | null; CreatedDate: string;
    }>(buildSalesforceContactQuery(CUTOFF_ISO, cap));
    inc(result.scanned, 'contacts', contacts.length);
    const fixtureContacts = contacts.filter(
      (r) =>
        (isFixtureEmail(r.Email) || isFixturePhone(r.Phone) || isFixturePhone(r.MobilePhone)) &&
        isOldEnough(Date.parse(r.CreatedDate), CUTOFF_MS),
    );

    const opps = await query<{ Id: string; Name: string; CreatedDate: string }>(
      `SELECT Id, Name, CreatedDate FROM Opportunity WHERE Name LIKE '${COMPANY_PREFIX}%' AND CreatedDate < ${CUTOFF_ISO} LIMIT ${cap}`,
    );
    inc(result.scanned, 'deals', opps.length);
    const fixtureOpps = opps.filter(
      (r) => isFixtureName(r.Name) && isOldEnough(Date.parse(r.CreatedDate), CUTOFF_MS),
    );

    // Leads survive when conversion never completed (mid-test crash).
    // Same email-OR-phone OR rule as Contact — see buildSalesforceLeadQuery.
    const leads = await query<{
      Id: string; Email: string | null; Phone: string | null; MobilePhone: string | null; CreatedDate: string; IsConverted: boolean;
    }>(buildSalesforceLeadQuery(CUTOFF_ISO, cap));
    inc(result.scanned, 'leads', leads.length);
    const fixtureLeads = leads.filter(
      (r) =>
        (isFixtureEmail(r.Email) || isFixturePhone(r.Phone) || isFixturePhone(r.MobilePhone)) &&
        isOldEnough(Date.parse(r.CreatedDate), CUTOFF_MS),
    );

    // 2. Tasks: identified by association (WhoId/WhatId/AccountId).
    const parentIdsForTask = [
      ...fixtureAccounts.map((r) => r.Id),
      ...fixtureContacts.map((r) => r.Id),
      ...fixtureOpps.map((r) => r.Id),
      ...fixtureLeads.map((r) => r.Id),
    ];
    const taskIds = new Set<string>();
    for (const batch of chunks(parentIdsForTask, CHILD_QUERY_BATCH)) {
      if (batch.length === 0) continue;
      const idList = quoteIdList(batch);
      const tasks = await query<{ Id: string }>(
        `SELECT Id FROM Task WHERE WhoId IN (${idList}) OR WhatId IN (${idList}) OR AccountId IN (${idList}) LIMIT ${cap}`,
      );
      for (const t of tasks) taskIds.add(t.Id);
    }

    // 3. ContentDocuments (notes): linked from Tasks today, but we
    //    also follow links from the parent objects defensively.
    const linkedEntityIds = [
      ...parentIdsForTask,
      ...Array.from(taskIds),
    ];
    const contentDocIds = new Set<string>();
    for (const batch of chunks(linkedEntityIds, CHILD_QUERY_BATCH)) {
      if (batch.length === 0) continue;
      const links = await query<{ ContentDocumentId: string }>(
        `SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId IN (${quoteIdList(
          batch,
        )}) LIMIT ${cap}`,
      );
      for (const l of links) contentDocIds.add(l.ContentDocumentId);
    }
    inc(result.scanned, 'notes', taskIds.size + contentDocIds.size);

    // 4. Delete children before parents. Track deleted IDs so the
    //    SOAP emptyRecycleBin call below can hard-delete them.
    let notesDeletedSoFar = 0;
    for (const id of taskIds) {
      if (notesDeletedSoFar >= cap) break;
      await del('Task', id);
      allDeletedIds.push(id);
      inc(result.deleted, 'notes');
      notesDeletedSoFar++;
    }
    for (const id of contentDocIds) {
      if (notesDeletedSoFar >= cap) break;
      // Deleting the ContentDocument cascades to all its links.
      await del('ContentDocument', id);
      allDeletedIds.push(id);
      inc(result.deleted, 'notes');
      notesDeletedSoFar++;
    }

    // 5. Delete parents (Opportunity → Contact → Account → Lead).
    for (const r of fixtureOpps) {
      await del('Opportunity', r.Id);
      allDeletedIds.push(r.Id);
      inc(result.deleted, 'deals');
    }
    for (const r of fixtureContacts) {
      await del('Contact', r.Id);
      allDeletedIds.push(r.Id);
      inc(result.deleted, 'contacts');
    }
    for (const r of fixtureAccounts) {
      await del('Account', r.Id);
      allDeletedIds.push(r.Id);
      inc(result.deleted, 'companies');
    }
    for (const r of fixtureLeads) {
      await del('Lead', r.Id);
      allDeletedIds.push(r.Id);
      inc(result.deleted, 'leads');
    }

    // 6. Hard-delete: empty the Recycle Bin for everything we just
    //    soft-deleted. Best-effort — see emptyRecycleBin comment.
    await emptyRecycleBin(allDeletedIds);

    result.status = 'ok';
  } catch (err) {
    result.status = 'failed';
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pipedrive
// ---------------------------------------------------------------------------

async function sweepPipedrive(): Promise<ProviderResult> {
  const result: ProviderResult = {
    provider: 'pipedrive',
    status: 'skipped',
    scanned: emptyCounts(),
    deleted: emptyCounts(),
    errors: [],
  };

  const oauth = process.env.PIPEDRIVE_SANDBOX_ACCESS_TOKEN;
  const apiToken = process.env.PIPEDRIVE_SANDBOX_API_TOKEN;
  const companyDomain = process.env.PIPEDRIVE_SANDBOX_COMPANY_DOMAIN;
  if (!oauth && !apiToken) {
    result.reason = 'PIPEDRIVE_SANDBOX_ACCESS_TOKEN / _API_TOKEN not set';
    return result;
  }

  const apiBase = companyDomain
    ? `https://${companyDomain}.pipedrive.com/api/v1`
    : 'https://api.pipedrive.com/v1';

  const authedUrl = (path: string): { url: string; headers: Record<string, string> } => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let url = `${apiBase}${path}`;
    if (oauth) {
      headers.Authorization = `Bearer ${oauth}`;
    } else if (apiToken) {
      url += `${path.includes('?') ? '&' : '?'}api_token=${encodeURIComponent(apiToken)}`;
    }
    return { url, headers };
  };

  const search = async (
    resource: 'persons' | 'organizations' | 'deals',
    term: string,
    fields: string,
  ): Promise<Array<{ id: string; result_score?: number }>> => {
    const { url, headers } = authedUrl(
      `/${resource}/search?term=${encodeURIComponent(term)}&fields=${fields}&exact_match=false&limit=${PER_OBJECT_DELETE_CAP}`,
    );
    const res = await http(url, { headers });
    if (!res.ok) throw new Error(`Pipedrive ${resource} search failed: HTTP ${res.status}`);
    const body =
      (await readJson<{ data?: { items?: Array<{ item?: { id?: number | string } }> } }>(res)) ?? {};
    return (body.data?.items ?? [])
      .map((it) => it.item?.id)
      .filter((v): v is number | string => v !== undefined && v !== null)
      .map((v) => ({ id: String(v) }));
  };

  const fetchOne = async (
    resource: 'persons' | 'organizations' | 'deals',
    id: string,
  ): Promise<Record<string, unknown> | null> => {
    const { url, headers } = authedUrl(`/${resource}/${encodeURIComponent(id)}`);
    const res = await http(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Pipedrive ${resource}/${id} fetch failed: HTTP ${res.status}`);
    const body = (await readJson<{ data?: Record<string, unknown> }>(res)) ?? {};
    return body.data ?? null;
  };

  const del = async (
    resource: 'persons' | 'organizations' | 'deals' | 'activities',
    id: string,
  ): Promise<void> => {
    if (DRY_RUN) return;
    const { url, headers } = authedUrl(`/${resource}/${encodeURIComponent(id)}`);
    const res = await http(url, { method: 'DELETE', headers });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Pipedrive ${resource}/${id} delete failed: HTTP ${res.status}`);
    }
  };

  // List activities associated with a parent record. The booking-suite
  // activity's subject is generic ("AI Voice Call" / "Appointment Booked"),
  // so association is the only reliable namespace anchor.
  const listAssociatedActivityIds = async (
    parentField: 'org_id' | 'person_id' | 'deal_id',
    parentId: string,
  ): Promise<string[]> => {
    const { url, headers } = authedUrl(
      `/activities?${parentField}=${encodeURIComponent(parentId)}&limit=${PER_OBJECT_DELETE_CAP}`,
    );
    const res = await http(url, { headers });
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new Error(`Pipedrive activities fetch (${parentField}=${parentId}) failed: HTTP ${res.status}`);
    }
    const body = (await readJson<{ data?: Array<{ id?: number | string }> | null }>(res)) ?? {};
    return (body.data ?? [])
      .map((row) => row?.id)
      .filter((v): v is number | string => v !== undefined && v !== null)
      .map((v) => String(v));
  };

  // Pipedrive's `add_time` looks like `"2026-04-29 23:14:53"` UTC. Parse
  // defensively — empty / unparseable returns undefined and the caller
  // skips the row.
  const parseAddTime = (raw: unknown): number | undefined => {
    if (typeof raw !== 'string' || raw.length === 0) return undefined;
    const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + (raw.endsWith('Z') ? '' : 'Z');
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : undefined;
  };

  try {
    // 1. Find fixture parents (orgs, persons, deals) and collect IDs.
    const fixtureOrgIds: string[] = [];
    const fixturePersonIds: string[] = [];
    const fixtureDealIds: string[] = [];

    const orgHits = await search('organizations', COMPANY_PREFIX, 'name');
    inc(result.scanned, 'companies', orgHits.length);
    for (const hit of orgHits) {
      const row = await fetchOne('organizations', hit.id);
      if (!row) continue;
      const name = (row['name'] as string | undefined) ?? '';
      if (!isFixtureName(name)) continue;
      const created = parseAddTime(row['add_time']);
      if (!isOldEnough(created, CUTOFF_MS)) continue;
      fixtureOrgIds.push(hit.id);
    }

    // Persons — search by EITHER phone OR email and union the IDs so a
    // fixture missing one half (e.g. caller ID without email) is still
    // found. Pipedrive's /itemSearch only takes one field per call.
    const personHitsByPhone = await search('persons', PHONE_PREFIX, 'phone');
    const personHitsByEmail = await search('persons', EMAIL_PREFIX, 'email');
    const personHitMap = new Map<string, { id: string }>();
    for (const h of personHitsByPhone) personHitMap.set(h.id, h);
    for (const h of personHitsByEmail) personHitMap.set(h.id, h);
    const personHits = Array.from(personHitMap.values());
    inc(result.scanned, 'contacts', personHits.length);
    for (const hit of personHits) {
      const row = await fetchOne('persons', hit.id);
      if (!row) continue;
      const phones = row['phone'];
      const phoneList = Array.isArray(phones)
        ? (phones as Array<{ value?: string }>).map((p) => p?.value ?? '')
        : [];
      const matchesPhone = phoneList.some((v) => isFixturePhone(v));
      const emails = row['email'];
      const emailList = Array.isArray(emails)
        ? (emails as Array<{ value?: string }>).map((e) => e?.value ?? '')
        : [];
      const matchesEmail = emailList.some((v) => isFixtureEmail(v));
      if (!matchesPhone && !matchesEmail) continue;
      const created = parseAddTime(row['add_time']);
      if (!isOldEnough(created, CUTOFF_MS)) continue;
      fixturePersonIds.push(hit.id);
    }

    // Deals — by `${company} - QVO Appointment` title pattern.
    const dealHits = await search('deals', COMPANY_PREFIX, 'title');
    inc(result.scanned, 'deals', dealHits.length);
    for (const hit of dealHits) {
      const row = await fetchOne('deals', hit.id);
      if (!row) continue;
      const title = (row['title'] as string | undefined) ?? '';
      if (!isFixtureDealName(title) && !isFixtureName(title)) continue;
      const created = parseAddTime(row['add_time']);
      if (!isOldEnough(created, CUTOFF_MS)) continue;
      fixtureDealIds.push(hit.id);
    }

    // 2. Find activities associated with each fixture parent. Use a
    //    Set because the same activity can be linked to multiple
    //    parents (org + person + deal) and we should only delete once.
    const activityIds = new Set<string>();
    for (const id of fixtureOrgIds) {
      for (const aid of await listAssociatedActivityIds('org_id', id)) activityIds.add(aid);
    }
    for (const id of fixturePersonIds) {
      for (const aid of await listAssociatedActivityIds('person_id', id)) activityIds.add(aid);
    }
    for (const id of fixtureDealIds) {
      for (const aid of await listAssociatedActivityIds('deal_id', id)) activityIds.add(aid);
    }
    inc(result.scanned, 'notes', activityIds.size);

    // 3. Delete activities first.
    let activitiesDeletedSoFar = 0;
    for (const id of activityIds) {
      if (activitiesDeletedSoFar >= PER_OBJECT_DELETE_CAP) break;
      await del('activities', id);
      inc(result.deleted, 'notes');
      activitiesDeletedSoFar++;
    }

    // 4. Delete the fixture parents (deals → persons → orgs so a
    //    deal's references stay valid until the deal itself is gone).
    for (const id of fixtureDealIds) {
      await del('deals', id);
      inc(result.deleted, 'deals');
    }
    for (const id of fixturePersonIds) {
      await del('persons', id);
      inc(result.deleted, 'contacts');
    }
    for (const id of fixtureOrgIds) {
      await del('organizations', id);
      inc(result.deleted, 'companies');
    }

    result.status = 'ok';
  } catch (err) {
    result.status = 'failed';
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Zoho
// ---------------------------------------------------------------------------

async function sweepZoho(): Promise<ProviderResult> {
  const result: ProviderResult = {
    provider: 'zoho',
    status: 'skipped',
    scanned: emptyCounts(),
    deleted: emptyCounts(),
    errors: [],
  };

  const token = process.env.ZOHO_SANDBOX_ACCESS_TOKEN;
  const apiDomain = process.env.ZOHO_SANDBOX_API_DOMAIN;
  if (!token || !apiDomain) {
    result.reason = 'ZOHO_SANDBOX_ACCESS_TOKEN / _API_DOMAIN not set';
    return result;
  }

  const headers: Record<string, string> = {
    Authorization: `Zoho-oauthtoken ${token}`,
    'Content-Type': 'application/json',
  };

  // Zoho COQL: returns Created_Time as ISO with offset, e.g.
  // "2026-04-29T23:14:53+00:00". Date.parse handles it.
  const coql = async <T>(query: string): Promise<T[]> => {
    const res = await http(`${apiDomain}/crm/v6/coql`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ select_query: query }),
    });
    // 204 = no rows — Zoho's normal "empty result" shape.
    if (res.status === 204) return [];
    if (!res.ok) throw new Error(`Zoho COQL failed: HTTP ${res.status} (${query.slice(0, 80)})`);
    const body = (await readJson<{ data?: T[] }>(res)) ?? {};
    return body.data ?? [];
  };

  const del = async (module: 'Contacts' | 'Accounts' | 'Deals' | 'Notes', id: string): Promise<void> => {
    if (DRY_RUN) return;
    // Zoho's bulk DELETE accepts up to 100 IDs per call; we go one-by-one
    // here for simplicity (the per-object cap keeps the request count bounded).
    const res = await http(
      `${apiDomain}/crm/v2/${module}/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Zoho ${module}/${id} delete failed: HTTP ${res.status}`);
    }
  };

  // List Note IDs whose Parent_Id matches the given parent. Zoho's COQL
  // `Parent_Id` lookup returns the parent's id directly. The booking
  // suite always passes `Note_Title: 'Appointment Booked'`, but title
  // alone isn't fixture-distinct, so we anchor by parent association.
  const listAssociatedNoteIds = async (parentId: string): Promise<string[]> => {
    const rows = await coql<{ id: string }>(
      `select id from Notes where Parent_Id = '${parentId}' limit ${PER_OBJECT_DELETE_CAP}`,
    );
    return rows.map((r) => r.id);
  };

  try {
    const cap = PER_OBJECT_DELETE_CAP;

    // 1. Find fixture parents (Accounts, Contacts, Deals) and collect IDs.
    const accounts = await coql<{ id: string; Account_Name: string; Created_Time: string }>(
      `select id, Account_Name, Created_Time from Accounts where Account_Name like '${COMPANY_PREFIX}%' and Created_Time < '${CUTOFF_ISO}' limit ${cap}`,
    );
    inc(result.scanned, 'companies', accounts.length);
    const fixtureAccounts = accounts.filter(
      (r) => isFixtureName(r.Account_Name) && isOldEnough(Date.parse(r.Created_Time), CUTOFF_MS),
    );

    // Email OR Phone OR Mobile — see buildZohoContactQuery.
    const contacts = await coql<{
      id: string; Email: string | null; Phone: string | null; Mobile: string | null; Created_Time: string;
    }>(buildZohoContactQuery(CUTOFF_ISO, cap));
    inc(result.scanned, 'contacts', contacts.length);
    const fixtureContacts = contacts.filter(
      (r) =>
        (isFixtureEmail(r.Email) || isFixturePhone(r.Phone) || isFixturePhone(r.Mobile)) &&
        isOldEnough(Date.parse(r.Created_Time), CUTOFF_MS),
    );

    const deals = await coql<{ id: string; Deal_Name: string; Created_Time: string }>(
      `select id, Deal_Name, Created_Time from Deals where Deal_Name like '${COMPANY_PREFIX}%' and Created_Time < '${CUTOFF_ISO}' limit ${cap}`,
    );
    inc(result.scanned, 'deals', deals.length);
    const fixtureDeals = deals.filter(
      // Some Zoho seats name the deal as just `${company}` (no suffix);
      // accept either pattern as long as the company-name half matches.
      (r) =>
        (isFixtureDealName(r.Deal_Name) || isFixtureName(r.Deal_Name)) &&
        isOldEnough(Date.parse(r.Created_Time), CUTOFF_MS),
    );

    // 2. Collect associated Note IDs from every fixture parent.
    const noteIds = new Set<string>();
    for (const r of fixtureAccounts) {
      for (const id of await listAssociatedNoteIds(r.id)) noteIds.add(id);
    }
    for (const r of fixtureContacts) {
      for (const id of await listAssociatedNoteIds(r.id)) noteIds.add(id);
    }
    for (const r of fixtureDeals) {
      for (const id of await listAssociatedNoteIds(r.id)) noteIds.add(id);
    }
    inc(result.scanned, 'notes', noteIds.size);

    // 3. Delete notes first (children before parents).
    let notesDeletedSoFar = 0;
    for (const id of noteIds) {
      if (notesDeletedSoFar >= cap) break;
      await del('Notes', id);
      inc(result.deleted, 'notes');
      notesDeletedSoFar++;
    }

    // 4. Delete the fixture parents.
    for (const r of fixtureDeals) {
      await del('Deals', r.id);
      inc(result.deleted, 'deals');
    }
    for (const r of fixtureContacts) {
      await del('Contacts', r.id);
      inc(result.deleted, 'contacts');
    }
    for (const r of fixtureAccounts) {
      await del('Accounts', r.id);
      inc(result.deleted, 'companies');
    }

    result.status = 'ok';
  } catch (err) {
    result.status = 'failed';
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function renderTable(results: ProviderResult[]): string {
  const lines: string[] = [];
  lines.push('## CRM sandbox fixture sweep');
  lines.push('');
  lines.push(`Cutoff: ${CUTOFF_ISO} (records older than ${MIN_AGE_MS / 60_000} minutes)`);
  lines.push(`Mode:   ${DRY_RUN ? 'DRY RUN (no deletes)' : 'apply'}`);
  lines.push('');
  lines.push('| Provider   | Status   | Scanned | Deleted | Notes |');
  lines.push('| ---------- | -------- | ------- | ------- | ----- |');
  for (const r of results) {
    const notes = r.status === 'skipped'
      ? r.reason ?? ''
      : r.errors.length > 0
        ? r.errors.join('; ').slice(0, 200)
        : totalDeleted(r) === 0 && r.status === 'ok' ? 'no leftovers' : '';
    lines.push(
      `| ${r.provider.padEnd(10)} | ${r.status.padEnd(8)} | ${String(totalScanned(r)).padStart(7)} | ${String(totalDeleted(r)).padStart(7)} | ${notes} |`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runSweep(): Promise<{ exitCode: number; results: ProviderResult[]; summary: string }> {
  // Run providers sequentially so a 5xx storm on one doesn't compound
  // across the others. Each provider's HTTP traffic is small enough that
  // sequential adds <30s vs. parallel.
  const results: ProviderResult[] = [];
  results.push(await sweepHubSpot());
  results.push(await sweepSalesforce());
  results.push(await sweepPipedrive());
  results.push(await sweepZoho());

  const summary = renderTable(results);
  const failed = results.some((r) => r.status === 'failed');
  return { exitCode: failed ? 1 : 0, results, summary };
}

// Only run when invoked directly (allows the helpers above to be unit
// tested without firing any HTTP).
const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : '';
    return invoked === import.meta.url;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  runSweep()
    .then(({ exitCode, results, summary }) => {
      // Human-readable table on stderr (so it shows up cleanly in the
      // workflow log even when stdout is being captured to a file), JSON
      // on stdout for downstream tooling.
      process.stderr.write(summary + '\n');
      process.stdout.write(
        JSON.stringify(
          {
            cutoff_iso: CUTOFF_ISO,
            cutoff_ms: CUTOFF_MS,
            min_age_ms: MIN_AGE_MS,
            dry_run: DRY_RUN,
            results,
          },
          null,
          2,
        ) + '\n',
      );
      process.exit(exitCode);
    })
    .catch((err) => {
      process.stderr.write(
        `Unexpected sweep failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
