import type { ActionDefinition } from './types';

export function defineAction<I, O>(def: ActionDefinition<I, O>): ActionDefinition<I, O> {
  return def;
}
