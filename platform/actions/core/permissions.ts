import { actionFail } from './errors';
import type { ActionDefinition, ActionResult, Actor } from './types';

export function checkPermission(
  def: Pick<ActionDefinition, 'permissions'>,
  actor: Actor,
): ActionResult<never> | null {
  switch (actor.type) {
    case 'system':
      return null;
    case 'user': {
      const roles = def.permissions.roles;
      if (roles && (roles.length === 0 || !actor.role || !roles.includes(actor.role))) {
        return actionFail('FORBIDDEN', `Role ${actor.role ?? '(none)'} cannot run this action`);
      }
      return null;
    }
    case 'agent':
      if (!def.permissions.agent) {
        return actionFail('FORBIDDEN', 'Agent is not permitted to run this action');
      }
      return null;
    case 'mcp': {
      const scope = def.permissions.mcpScope;
      if (!scope || !actor.scopes?.includes(scope)) {
        return actionFail('FORBIDDEN', 'MCP caller is missing the required scope');
      }
      return null;
    }
    default:
      return actionFail('FORBIDDEN', 'Unknown actor type');
  }
}
