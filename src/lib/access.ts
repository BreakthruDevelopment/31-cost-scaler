import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";

/**
 * Who may do what, one row per table. Data functions call `assertCan()` before touching a table, and the
 * integration tests walk `ACCESS_RULES`, so a new rule can't ship without a test.
 *
 *  - `private`: rows belong to `owner_id`. Only the owner may touch them; everyone else, admin included, gets a 404
 *    (so an id can't be probed). Queries add `ownedBy()` as well, so SQL enforces the same rule. Admin sees counts
 *    only (`admin_stats`).
 *  - `public`: anyone, signed in or not, may read; nobody may write through a request. Only the refresh jobs
 *    (the `SYSTEM` subject, or an admin pressing "Refresh now") write.
 *  - `admin`: admin and the refresh jobs only; a user gets a 403.
 */
export type ResourceName = "scenario" | "scenario_result" | "advice" | "price_point" | "footprint_app" | "price_refresh" | "admin_stats";
export type AccessAction = "list" | "read" | "create" | "update" | "delete" | "write";

/** The scheduler or a trusted local script. Never built from request data. */
export const SYSTEM = { id: "system", role: "system" } as const;
export type Subject = Actor | typeof SYSTEM | null;

type Rule = { kind: "private" | "public" | "admin"; actions: readonly AccessAction[] };

export const ACCESS_RULES: Record<ResourceName, Rule> = {
  scenario: { kind: "private", actions: ["list", "read", "create", "update", "delete"] },
  scenario_result: { kind: "private", actions: ["read", "write"] },
  advice: { kind: "private", actions: ["list", "read", "create"] },
  price_point: { kind: "public", actions: ["read", "write"] },
  footprint_app: { kind: "public", actions: ["read", "write"] },
  price_refresh: { kind: "admin", actions: ["read", "write"] },
  admin_stats: { kind: "admin", actions: ["read"] },
};

/** A row with an owner, as the private tables have. */
export type OwnedRow = { ownerId: string };

const isSystem = (s: Subject): s is typeof SYSTEM => s !== null && s.role === "system";
const isActor = (s: Subject): s is Actor => s !== null && s.role !== "system";

export function can(subject: Subject, action: AccessAction, resource: ResourceName, row?: OwnedRow, opts: { active?: boolean } = {}): boolean {
  const rule = ACCESS_RULES[resource];
  if (!rule.actions.includes(action)) return false;
  switch (rule.kind) {
    case "private":
      if (!isActor(subject)) return false;
      // "list" and "create" have no row yet: the function scopes the query or sets the owner to the actor.
      if (action === "list" || action === "create") return true;
      return row !== undefined && row.ownerId === subject.id;
    case "public":
      if (action === "read") return resource !== "price_point" || opts.active !== false;
      return isSystem(subject) || (isActor(subject) && subject.role === "admin");
    case "admin":
      return isSystem(subject) || (isActor(subject) && subject.role === "admin");
  }
}

/**
 * Throws when the subject may not do this. Private tables answer `NotFoundError` (404, never "forbidden") so a
 * stranger can't tell someone else's row from a missing one; the others answer `ForbiddenError` (403).
 * `opts.active: false` marks a price row that is not active (quarantined): the public may not read it.
 */
export function assertCan(subject: Subject, action: AccessAction, resource: ResourceName, row?: OwnedRow, opts: { active?: boolean } = {}): void {
  if (can(subject, action, resource, row, opts)) return;
  if (ACCESS_RULES[resource].kind === "private" || (resource === "price_point" && action === "read")) throw new NotFoundError();
  throw new ForbiddenError();
}
