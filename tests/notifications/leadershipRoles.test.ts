import { describe, it, expect } from 'vitest';
import {
  isLeadershipRbacRole,
  isLeadershipRole,
  LEADERSHIP_PRIORITY_ORDER_BY,
  LEADERSHIP_PRIORITY_ROLES,
  LEADERSHIP_PRIORITY_ROLES_SQL_LIST,
  LEADERSHIP_RBAC_ROLES,
  LEADERSHIP_RBAC_ROLES_SQL_LIST,
  LEADERSHIP_RECIPIENT_WHERE_CLAUSE,
  LEADERSHIP_ROLES,
  LEADERSHIP_ROLES_SQL_LIST,
  LEADERSHIP_USER_ROLES_LEFT_JOIN,
} from '../../platform/notifications/LeadershipRoles';

// Pin the role lists so any rename/addition is an intentional, reviewable
// change. Five recipient queries (connector email/phone helpers, the
// connector-auth alert dispatcher, the human-escalation dispatcher's
// admin lookup, and the on-call roster panel) all derive their audience
// from these constants. If a future role is added or renamed without
// updating every consumer, this test should fail first so the change is
// recognised as an audience change.
describe('LeadershipRoles', () => {
  it('pins the on-call leadership role list', () => {
    expect([...LEADERSHIP_ROLES]).toEqual([
      'admin',
      'owner',
      'tenant_owner',
      'operations_manager',
    ]);
  });

  it('pins the canonical RBAC subset (user_roles join half)', () => {
    // Legacy `admin` / `owner` only ever lived on `users.role` so they
    // are intentionally excluded from the RBAC join half.
    expect([...LEADERSHIP_RBAC_ROLES]).toEqual([
      'tenant_owner',
      'operations_manager',
    ]);
  });

  it('renders inline SQL `IN (...)` literals that match the dispatch query verbatim', () => {
    // Recipient queries inline these literals (not parameterised
    // arrays) so production audits and the dispatcher tests can grep
    // the SQL and confirm the gating hasn't silently regressed.
    expect(LEADERSHIP_ROLES_SQL_LIST).toBe(
      "'admin', 'owner', 'tenant_owner', 'operations_manager'",
    );
    expect(LEADERSHIP_RBAC_ROLES_SQL_LIST).toBe(
      "'tenant_owner', 'operations_manager'",
    );
  });

  it('exposes a LEFT JOIN that brings user_roles onto a tenant-scoped users query', () => {
    expect(LEADERSHIP_USER_ROLES_LEFT_JOIN).toContain('LEFT JOIN user_roles ur');
    expect(LEADERSHIP_USER_ROLES_LEFT_JOIN).toContain(
      'ur.user_id = u.id AND ur.tenant_id = u.tenant_id',
    );
  });

  it('exposes a WHERE fragment that unions legacy users.role and user_roles audiences', () => {
    // The dispatch tests assert these substrings verbatim.
    expect(LEADERSHIP_RECIPIENT_WHERE_CLAUSE).toContain(
      "ur.role IN ('tenant_owner', 'operations_manager')",
    );
    expect(LEADERSHIP_RECIPIENT_WHERE_CLAUSE).toContain(
      "u.role IN ('admin', 'owner', 'tenant_owner', 'operations_manager')",
    );
  });

  it('isLeadershipRole accepts every leadership value and rejects others', () => {
    for (const role of LEADERSHIP_ROLES) {
      expect(isLeadershipRole(role)).toBe(true);
    }
    expect(isLeadershipRole('member')).toBe(false);
    expect(isLeadershipRole('dispatcher')).toBe(false);
    expect(isLeadershipRole(null)).toBe(false);
    expect(isLeadershipRole(undefined)).toBe(false);
    expect(isLeadershipRole('')).toBe(false);
  });

  it('pins the priority-ordering subset (owners sort first)', () => {
    // Used by the on-call roster + escalation dispatch ORDER BY so the
    // preview and the actual page-out agree on who is paged first.
    expect([...LEADERSHIP_PRIORITY_ROLES]).toEqual(['owner', 'tenant_owner']);
    expect(LEADERSHIP_PRIORITY_ROLES_SQL_LIST).toBe("'owner', 'tenant_owner'");
    // Existing dispatch tests assert this exact ORDER BY substring.
    expect(LEADERSHIP_PRIORITY_ORDER_BY).toBe(
      "CASE WHEN u.role IN ('owner', 'tenant_owner') THEN 0 ELSE 1 END",
    );
  });

  it('isLeadershipRbacRole accepts only the user_roles-tracked subset', () => {
    for (const role of LEADERSHIP_RBAC_ROLES) {
      expect(isLeadershipRbacRole(role)).toBe(true);
    }
    // Legacy values are *not* RBAC roles even though they qualify as
    // leadership overall.
    expect(isLeadershipRbacRole('admin')).toBe(false);
    expect(isLeadershipRbacRole('owner')).toBe(false);
    expect(isLeadershipRbacRole('member')).toBe(false);
    expect(isLeadershipRbacRole(null)).toBe(false);
  });
});
