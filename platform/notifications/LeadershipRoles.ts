/**
 * Single source of truth for the on-call tenant leadership role list and
 * the SQL fragments that gate dispatch queries to that audience.
 *
 * Background: tasks #410 and #420 introduced a recipient model where a
 * user qualifies as on-call leadership through *either* the legacy
 * `users.role` column *or* the canonical `user_roles` RBAC table. After
 * those tasks the same role literals and the LEFT JOIN against
 * `user_roles` were duplicated as inline SQL across five recipient
 * queries (connector email/phone helpers, the connector-auth alert
 * dispatcher, the human-escalation dispatcher, and the on-call roster
 * panel). Renaming or adding a leadership role inevitably missed one of
 * the copies — exactly the bug task #420 was created to fix.
 *
 * Every dispatch path should opt into the constants and SQL fragments
 * exported from this module instead of repeating the literals so a
 * future role rename or addition is a single-file change.
 */

/**
 * The full set of role values that count as on-call tenant leadership
 * for paging purposes. Includes both legacy values from `users.role`
 * (`admin`, `owner`) and canonical RBAC values from `user_roles`
 * (`tenant_owner`, `operations_manager`).
 */
export const LEADERSHIP_ROLES = [
  'admin',
  'owner',
  'tenant_owner',
  'operations_manager',
] as const;

export type LeadershipRole = (typeof LEADERSHIP_ROLES)[number];

/**
 * Subset of leadership roles tracked in the canonical `user_roles`
 * RBAC table. Legacy `admin` / `owner` only ever lived on the
 * `users.role` column so they are intentionally excluded from the
 * `ur.role IN (...)` half of the audience query.
 */
export const LEADERSHIP_RBAC_ROLES = [
  'tenant_owner',
  'operations_manager',
] as const;

export type LeadershipRbacRole = (typeof LEADERSHIP_RBAC_ROLES)[number];

const LEADERSHIP_ROLE_SET: ReadonlySet<LeadershipRole> = new Set(LEADERSHIP_ROLES);
const LEADERSHIP_RBAC_ROLE_SET: ReadonlySet<LeadershipRbacRole> = new Set(LEADERSHIP_RBAC_ROLES);

export function isLeadershipRole(value: string | null | undefined): value is LeadershipRole {
  return !!value && LEADERSHIP_ROLE_SET.has(value as LeadershipRole);
}

export function isLeadershipRbacRole(
  value: string | null | undefined,
): value is LeadershipRbacRole {
  return !!value && LEADERSHIP_RBAC_ROLE_SET.has(value as LeadershipRbacRole);
}

function quoteSqlIdentList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}

/**
 * Inline SQL `IN (...)` literal of the leadership values that may
 * appear on `users.role` (legacy `admin` / `owner` plus the canonical
 * values that may also be denormalised into the legacy column).
 *
 * Kept as inline literals (not parameterised arrays) so the SQL stays
 * grep-able — production audits and the dispatch tests both inspect
 * recipient queries verbatim to make sure the gating doesn't silently
 * regress.
 */
export const LEADERSHIP_ROLES_SQL_LIST = quoteSqlIdentList(LEADERSHIP_ROLES);

/**
 * Inline SQL `IN (...)` literal of the leadership values surfaced by
 * the canonical `user_roles` table. Combine with
 * {@link LEADERSHIP_USER_ROLES_LEFT_JOIN} so teammates whose role only
 * lives on the RBAC table are still paged.
 */
export const LEADERSHIP_RBAC_ROLES_SQL_LIST = quoteSqlIdentList(LEADERSHIP_RBAC_ROLES);

/**
 * `LEFT JOIN` clause that brings the canonical `user_roles` table onto
 * a tenant-scoped `users u` query so the WHERE clause can union legacy
 * `users.role` leadership with RBAC-granted leadership without
 * dropping rows that hold the role on only one side.
 *
 * Always combine with {@link LEADERSHIP_RECIPIENT_WHERE_CLAUSE} (or
 * the matching `IN` literals) to keep the audience consistent across
 * dispatch paths.
 */
export const LEADERSHIP_USER_ROLES_LEFT_JOIN =
  `LEFT JOIN user_roles ur
           ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id`;

/**
 * Boolean predicate fragment that gates a
 * `users u LEFT JOIN user_roles ur ...` query down to the on-call
 * leadership audience. Drop into the WHERE clause:
 *
 *     WHERE u.tenant_id = $1
 *       AND COALESCE(u.is_active, TRUE) = TRUE
 *       AND ${LEADERSHIP_RECIPIENT_WHERE_CLAUSE}
 *
 * Mirrors the legacy + RBAC union the connector helpers established in
 * task #410 so renames stay in lock-step.
 */
export const LEADERSHIP_RECIPIENT_WHERE_CLAUSE =
  `(
            ur.role IN (${LEADERSHIP_RBAC_ROLES_SQL_LIST})
            OR u.role IN (${LEADERSHIP_ROLES_SQL_LIST})
          )`;

/**
 * Highest-priority leadership values used by recipient queries to
 * sort owners/tenant owners ahead of other leadership roles in
 * dispatch order (so the on-call roster preview and the actual page-out
 * agree on who is paged first). Centralised here so this priority
 * subset stays in lock-step with {@link LEADERSHIP_ROLES} as the role
 * vocabulary evolves.
 */
export const LEADERSHIP_PRIORITY_ROLES = ['owner', 'tenant_owner'] as const;
export type LeadershipPriorityRole = (typeof LEADERSHIP_PRIORITY_ROLES)[number];

export const LEADERSHIP_PRIORITY_ROLES_SQL_LIST = quoteSqlIdentList(
  LEADERSHIP_PRIORITY_ROLES,
);

/**
 * `ORDER BY` fragment that sorts {@link LEADERSHIP_PRIORITY_ROLES}
 * (owners) before any other leadership role. Drop into an ORDER BY
 * clause as the first sort key, e.g.
 *
 *     ORDER BY ${LEADERSHIP_PRIORITY_ORDER_BY},
 *              LOWER(u.email) ASC
 */
export const LEADERSHIP_PRIORITY_ORDER_BY =
  `CASE WHEN u.role IN (${LEADERSHIP_PRIORITY_ROLES_SQL_LIST}) THEN 0 ELSE 1 END`;
