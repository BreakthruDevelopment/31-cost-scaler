import { describe, expect, it } from "vitest";
import { ACCESS_RULES, type ResourceName, SYSTEM, assertCan, can } from "@/lib/access";

const user = { id: "u1", role: "user" as const };
const other = { id: "u2", role: "user" as const };
const admin = { id: "a1", role: "admin" as const };
const mine = { ownerId: "u1" };

describe("access rules", () => {
  const privateTables: ResourceName[] = ["scenario", "scenario_result", "advice"];

  it.each(privateTables)("%s: the owner is allowed, everyone else (admin included) gets a 404", (resource) => {
    for (const action of ACCESS_RULES[resource].actions.filter((a) => a !== "list" && a !== "create")) {
      expect(can(user, action, resource, mine)).toBe(true);
      expect(() => assertCan(other, action, resource, mine)).toThrow(expect.objectContaining({ status: 404 }));
      expect(() => assertCan(admin, action, resource, mine)).toThrow(expect.objectContaining({ status: 404 }));
      expect(() => assertCan(null, action, resource, mine)).toThrow(expect.objectContaining({ status: 404 }));
      expect(() => assertCan(SYSTEM, action, resource, mine)).toThrow(expect.objectContaining({ status: 404 }));
      // A private row can't be judged without its owner.
      expect(can(user, action, resource)).toBe(false);
    }
  });

  it("an admin owning a row may use it like anyone else", () => {
    expect(can(admin, "read", "scenario", { ownerId: "a1" })).toBe(true);
  });

  it("public tables: anyone reads, only the refresh jobs and admin write", () => {
    for (const resource of ["price_point", "footprint_app"] as const) {
      expect(can(null, "read", resource)).toBe(true);
      expect(can(user, "read", resource)).toBe(true);
      expect(can(null, "write", resource)).toBe(false);
      expect(can(user, "write", resource)).toBe(false);
      expect(can(admin, "write", resource)).toBe(true);
      expect(can(SYSTEM, "write", resource)).toBe(true);
      expect(can(user, "delete", resource)).toBe(false); // not a listed action
    }
  });

  it("price_point: a quarantined row is not public", () => {
    expect(can(null, "read", "price_point", undefined, { active: false })).toBe(false);
    expect(() => assertCan(user, "read", "price_point", undefined, { active: false })).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("admin-only tables: 403 for users and the signed-out, allowed for admin and the refresh jobs", () => {
    for (const resource of ["price_refresh", "admin_stats"] as const) {
      expect(() => assertCan(user, "read", resource)).toThrow(expect.objectContaining({ status: 403 }));
      expect(() => assertCan(null, "read", resource)).toThrow(expect.objectContaining({ status: 403 }));
      expect(can(admin, "read", resource)).toBe(true);
    }
    expect(can(SYSTEM, "write", "price_refresh")).toBe(true);
    expect(can(user, "write", "price_refresh")).toBe(false);
    expect(can(SYSTEM, "read", "admin_stats")).toBe(true);
    expect(can(admin, "write", "admin_stats")).toBe(false); // not a listed action
  });

  it("list and create need a signed-in user on private tables", () => {
    expect(can(user, "list", "scenario")).toBe(true);
    expect(can(user, "create", "scenario")).toBe(true);
    expect(can(null, "list", "scenario")).toBe(false);
    expect(can(SYSTEM, "create", "scenario")).toBe(false);
  });
});
