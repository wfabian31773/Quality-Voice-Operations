// Staff refs in tool input → the tenant's active staff, for every scheduling
// action that takes a staffId (check_availability, book.prepare,
// reschedule.prepare). Mirrors serviceRefs.ts: an id is preferred, but the
// agent may send the staff member's exact name ("Dee") where the id goes
// (live call 2026-10-22). Case, accents and spacing are ignored; nothing looser
// (a first name of "Dee Brown", a nickname) resolves. Failures carry the
// candidates in `alternatives` as { staffId, name }, so the agent can pick or
// ask without a separate list_staff call.

import { actionFail, type ActionResult } from '../core';
import type { Catalog, CatalogStaff } from './availability';
import { callerMessage, type ReadbackLang } from './readback';

function normalizeStaffName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function choices(staff: CatalogStaff[]): { staffId: string; name: string }[] {
  return staff.map((s) => ({ staffId: s.id, name: s.name }));
}

/** A staff ref → its active staff member; or the failure when it isn't exactly one. */
export function resolveStaffRef(
  catalog: Pick<Catalog, 'staff'>,
  ref: string,
  lang: ReadbackLang,
): CatalogStaff | ActionResult<never> {
  const byId = catalog.staff.find((s) => s.id === ref);
  if (byId) return byId;
  const name = normalizeStaffName(ref);
  const matches = name ? catalog.staff.filter((s) => normalizeStaffName(s.name) === name) : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    return actionFail('VALIDATION_FAILED', `"${ref}" matches more than one staff member. Ask the caller which one, then send its staffId from alternatives.`, {
      field: 'staffId',
      alternatives: choices(matches),
      callerSafeMessage: callerMessage('ambiguousStaff', lang),
    });
  }
  return actionFail('NOT_FOUND', `Unknown staff member: ${ref}. The shop's staff are in alternatives; send one's staffId only if it is who the caller asked for.`, {
    field: 'staffId',
    alternatives: choices(catalog.staff),
    callerSafeMessage: callerMessage('unknownStaff', lang),
  });
}
