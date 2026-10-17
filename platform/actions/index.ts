import { businessActions } from './business';
import {
  runAction as runNamedAction,
  type ActionContext,
  type ActionResult,
  type ActionRuntime,
  type AnyActionDefinition,
} from './core';
import { callsActions } from './calls';
import { dispatchActions } from './dispatch';
import { ordersActions } from './orders';
import { schedulingActions } from './scheduling';
import { smsActions } from './sms';
import { ticketsActions } from './tickets';

export const ACTION_REGISTRY: AnyActionDefinition[] = [
  ...schedulingActions,
  ...smsActions,
  ...ticketsActions,
  ...businessActions,
  ...callsActions,
  ...dispatchActions,
  ...ordersActions,
];

const byName = new Map(ACTION_REGISTRY.map((def) => [def.name, def]));

export function getAction(name: string): AnyActionDefinition | undefined {
  return byName.get(name);
}

export function listActions(): AnyActionDefinition[] {
  return ACTION_REGISTRY.slice();
}

export async function runAction(
  name: string,
  ctx: ActionContext,
  input: unknown,
  runtime: ActionRuntime = {},
): Promise<ActionResult> {
  return runNamedAction(name, ctx, input, {
    ...runtime,
    registry: runtime.registry ?? byName,
  });
}

export * from './core';
