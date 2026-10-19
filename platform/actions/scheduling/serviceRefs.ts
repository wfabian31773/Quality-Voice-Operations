// Service refs in tool input → the tenant's catalog services, for every
// scheduling action that takes a serviceId or serviceIds (list_staff,
// check_availability, book.prepare). The agent may send the service's exact
// name or alias instead of its id; resolveServiceRef (serviceMatch.ts) decides.
// Failures carry the candidate services in `alternatives` as { serviceId, name }
// (serviceId becomes the model's handle on the way out), so the agent can pick
// or ask without a separate list_services call.

import { actionFail, type ActionResult } from '../core';
import type { Catalog, CatalogService } from './availability';
import { callerMessage, type ReadbackLang } from './readback';
import { resolveServiceRef } from './serviceMatch';

export interface ServiceRefOptions {
  /** Input field named in a failure ('serviceId', 'serviceIds'). */
  field: string;
  lang: ReadbackLang;
  /** Code for a ref nothing matches: reads say NOT_FOUND, book.prepare keeps VALIDATION_FAILED. */
  unknownCode: 'NOT_FOUND' | 'VALIDATION_FAILED';
  /** Start of the failure message for an unknown ref (default "Unknown service"). */
  unknownLabel?: string;
}

function choices(services: CatalogService[]): { serviceId: string; name: string }[] {
  return services.map((s) => ({ serviceId: s.id, name: s.name }));
}

/** Each ref → its catalog service, in order; or the failure for the first ref that doesn't resolve to exactly one. */
export function resolveServiceRefs(
  catalog: Pick<Catalog, 'services'>,
  refs: string[],
  opts: ServiceRefOptions,
): CatalogService[] | ActionResult<never> {
  const services: CatalogService[] = [];
  for (const ref of refs) {
    const found = resolveServiceRef(catalog, ref);
    if (found.status === 'ambiguous') {
      return actionFail('VALIDATION_FAILED', `"${ref}" matches more than one service. Ask the caller which one, then send its serviceId from alternatives.`, {
        field: opts.field,
        alternatives: choices(found.candidates),
        callerSafeMessage: callerMessage('ambiguousService', opts.lang),
      });
    }
    if (found.status === 'unknown') {
      return actionFail(opts.unknownCode, `${opts.unknownLabel ?? 'Unknown service'}: ${ref}. The closest services are in alternatives; send one's serviceId only if it is what the caller asked for.`, {
        field: opts.field,
        alternatives: choices(found.suggestions),
        callerSafeMessage: callerMessage('unknownService', opts.lang),
      });
    }
    services.push(found.service);
  }
  // A name and an id (or two names) for the same service.
  if (new Set(services.map((s) => s.id)).size !== services.length) {
    return actionFail('VALIDATION_FAILED', 'Each service may appear once', { field: opts.field });
  }
  return services;
}
