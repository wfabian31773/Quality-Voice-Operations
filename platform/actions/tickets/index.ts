import type { AnyActionDefinition } from '../core';
import { createTicketsActions } from './actions';

export const ticketsActions: AnyActionDefinition[] = createTicketsActions();

export { createTicketsActions, OPEN_COMMIT, OPEN_PREPARE, type TicketsActionDeps } from './actions';
export { sqlTicketsRepo, type TicketsRepo, type TicketsRepoFactory, type TicketRecord } from './repo';
export * from './schemas';
