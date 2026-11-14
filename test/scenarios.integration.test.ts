/**
 * Scenario and result access rules against a real Postgres (TEST_DATABASE_URL): owner allowed, another user and
 * an admin get 404 (ids can't be probed), admin allowed on their own rows, idempotent create, versioned update,
 * caps and write limits, NUL rejection.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_SPEC } from "@/lib/pricing/spec";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("scenarios (Postgres)", () => {
  let sql: postgres.Sql;
  let s: typeof import("@/lib/scenarios");
  const alice = { id: "sc-alice", role: "user" as const };
  const bob = { id: "sc-bob", role: "user" as const };
  const admin = { id: "sc-admin", role: "admin" as const };
  const input = (name: string, extra: Record<string, unknown> = {}) => ({ name, spec: BASE_SPEC, ...extra });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id like 'sc-%'`;
    for (const u of [alice, bob, admin]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    s = await import("@/lib/scenarios");
  });
  afterAll(async () => {
    await sql`delete from "user" where id like 'sc-%'`;
    await sql.end();
  });

  const rejects404 = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ status: 404 });

  it("owner: create, read, list, update, delete", async () => {
    const { scenario, created } = await s.createScenario(alice, input("mine", { clientOpId: crypto.randomUUID() }));
    expect(created).toBe(true);
    expect(scenario).toMatchObject({ ownerId: alice.id, name: "mine", version: 1 });
    expect((await s.getScenario(alice, scenario.id)).id).toBe(scenario.id);
    expect((await s.listScenarios(alice)).map((r) => r.id)).toContain(scenario.id);
    const updated = await s.updateScenario(alice, scenario.id, { version: 1, name: "renamed" });
    expect(updated).toMatchObject({ name: "renamed", version: 2 });
    await s.deleteScenario(alice, scenario.id);
    await rejects404(s.getScenario(alice, scenario.id));
  });

  it("another user: 404 on read, update and delete, and the row is untouched", async () => {
    const { scenario } = await s.createScenario(alice, input("alice private"));
    await rejects404(s.getScenario(bob, scenario.id));
    await rejects404(s.updateScenario(bob, scenario.id, { version: 1, name: "hijack" }));
    await rejects404(s.deleteScenario(bob, scenario.id));
    const [row] = await sql`select name, version from scenario where id = ${scenario.id}`;
    expect(row).toMatchObject({ name: "alice private", version: 1 });
    expect((await s.listScenarios(bob)).some((r) => r.id === scenario.id)).toBe(false);
  });

  it("admin: 404 on someone else's scenario (counts only), but allowed on their own", async () => {
    const { scenario } = await s.createScenario(alice, input("admin must not read"));
    await rejects404(s.getScenario(admin, scenario.id));
    await rejects404(s.updateScenario(admin, scenario.id, { version: 1, name: "x" }));
    await rejects404(s.deleteScenario(admin, scenario.id));
    expect((await s.listScenarios(admin)).some((r) => r.id === scenario.id)).toBe(false);
    const own = await s.createScenario(admin, input("admin's own"));
    expect((await s.getScenario(admin, own.scenario.id)).name).toBe("admin's own");
    expect((await s.updateScenario(admin, own.scenario.id, { version: 1, name: "still mine" })).version).toBe(2);
    await s.deleteScenario(admin, own.scenario.id);
  });

  it("guessing ids: unknown, malformed and another user's id all answer the same 404", async () => {
    const { scenario } = await s.createScenario(alice, input("guess me"));
    const answers = await Promise.all(
      [crypto.randomUUID(), "not-a-uuid", "", scenario.id].map((id) => s.getScenario(bob, id).then(() => "ok", (e: { status: number; message: string }) => `${e.status} ${e.message}`)),
    );
    expect(new Set(answers)).toEqual(new Set(["404 Not found"]));
  });

  it("a replayed client op id returns the first row: one row, even in parallel; another user gets their own", async () => {
    const clientOpId = crypto.randomUUID();
    const first = await s.createScenario(alice, input("once", { clientOpId }));
    const again = await s.createScenario(alice, input("once", { clientOpId }));
    const parallel = await Promise.all([1, 2, 3, 4].map(() => s.createScenario(alice, input("once", { clientOpId }))));
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, scenario: { id: first.scenario.id } });
    expect(parallel.every((r) => r.scenario.id === first.scenario.id)).toBe(true);
    expect(parallel.filter((r) => r.created)).toHaveLength(0);
    const [{ n }] = await sql`select count(*)::int as n from scenario where owner_id = ${alice.id} and client_op_id = ${clientOpId}`;
    expect(n).toBe(1);
    const bobs = await s.createScenario(bob, input("once", { clientOpId }));
    expect(bobs.scenario.id).not.toBe(first.scenario.id);
    expect(bobs.scenario.ownerId).toBe(bob.id);
    await expect(s.createScenario(alice, input("x", { clientOpId: "not-a-uuid" }))).rejects.toThrow();
  });

  it("racing creates with one new op id make one row and don't spend extra writes", async () => {
    await sql`delete from rate_event where user_id = ${bob.id}`;
    const clientOpId = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => s.createScenario(bob, input("race", { clientOpId }))));
    expect(new Set(results.map((r) => r.scenario.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const [{ n }] = await sql`select count(*)::int as n from rate_event where user_id = ${bob.id} and kind = 'scenario_write'`;
    expect(n).toBe(1);
  });

  it("a stale version is 409 and changes nothing; the current version succeeds", async () => {
    const { scenario } = await s.createScenario(alice, input("versioned"));
    const v2 = await s.updateScenario(alice, scenario.id, { version: 1, name: "v2" });
    expect(v2.version).toBe(2);
    await expect(s.updateScenario(alice, scenario.id, { version: 1, name: "stale" })).rejects.toMatchObject({ status: 409 });
    expect((await s.getScenario(alice, scenario.id)).name).toBe("v2");
    // Two writers with the same version: one wins, one gets the 409.
    const race = await Promise.allSettled([
      s.updateScenario(alice, scenario.id, { version: 2, name: "a" }),
      s.updateScenario(alice, scenario.id, { version: 2, name: "b" }),
    ]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(race.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect((await s.getScenario(alice, scenario.id)).version).toBe(3);
  });

  it("an update needs a version and something to change", async () => {
    const { scenario } = await s.createScenario(alice, input("shape"));
    await expect(s.updateScenario(alice, scenario.id, { name: "x" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(s.updateScenario(alice, scenario.id, { version: 1 })).rejects.toMatchObject({ name: "ZodError" });
  });

  it("changing the spec drops the saved result (it no longer matches); renaming keeps it", async () => {
    const { scenario } = await s.createScenario(alice, input("results"));
    await s.saveScenarioResult(alice, scenario.id, { pricesAsOf: new Date(), result: { totals: [1, 2] } });
    const renamed = await s.updateScenario(alice, scenario.id, { version: 1, name: "renamed" });
    expect(await s.getScenarioResult(alice, scenario.id)).not.toBeNull();
    await s.updateScenario(alice, scenario.id, { version: renamed.version, spec: { ...BASE_SPEC, loadBalancers: 2 } });
    expect(await s.getScenarioResult(alice, scenario.id)).toBeNull();
  });

  it("rejects NUL bytes with a validation error (400), never a database error", async () => {
    const { errorInfo } = await import("@/lib/http");
    const err = await s.createScenario(alice, input("bad\0name")).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ name: "ZodError" });
    expect(errorInfo(err).status).toBe(400);
    await expect(s.createScenario(alice, input("ok", { spec: { ...BASE_SPEC, baseApp: "a\0b" } }))).rejects.toMatchObject({ name: "ZodError" });
    const { scenario } = await s.createScenario(alice, input("nul update"));
    await expect(s.updateScenario(alice, scenario.id, { version: 1, name: "x\0y" })).rejects.toMatchObject({ name: "ZodError" });
    // jsonHasNul guards the saved result, which the engine builds.
    const nulResult = await s.saveScenarioResult(alice, scenario.id, { pricesAsOf: new Date(), result: { note: "a\0b" } }).then(() => null, (e: unknown) => e);
    expect(errorInfo(nulResult).status).toBe(400);
  });

  it("names are 1 to 80 characters", async () => {
    await expect(s.createScenario(alice, input("   "))).rejects.toMatchObject({ name: "ZodError" });
    await expect(s.createScenario(alice, input("x".repeat(81)))).rejects.toMatchObject({ name: "ZodError" });
    expect((await s.createScenario(alice, input("x".repeat(80)))).scenario.name).toHaveLength(80);
    expect((await s.createScenario(alice, input("  trimmed  "))).scenario.name).toBe("trimmed");
  });

  it("at most 50 scenarios per user (409), and deleting one makes room", async () => {
    const owner = { id: "sc-cap", role: "user" as const };
    await sql`insert into "user" (id, name, email) values (${owner.id}, 'cap', 'sc-cap@test.local')`;
    for (let i = 0; i < 50; i++) await sql`insert into scenario (owner_id, name, spec) values (${owner.id}, ${"n" + i}, '{}'::jsonb)`;
    await expect(s.createScenario(owner, input("one too many"))).rejects.toMatchObject({ status: 409 });
    expect((await sql`select count(*)::int as n from rate_event where user_id = ${owner.id}`)[0].n).toBe(0); // a refused create isn't charged
    const [first] = await s.listScenarios(owner);
    await s.deleteScenario(owner, first.id);
    expect((await s.createScenario(owner, input("fits now"))).created).toBe(true);
  });

  it("parallel duplicates of a saved op id succeed with one row and one write charged, even at 49 scenarios", async () => {
    const owner = { id: "sc-edge49", role: "user" as const };
    await sql`insert into "user" (id, name, email) values (${owner.id}, 'e', 'sc-edge49@test.local')`;
    for (let i = 0; i < 48; i++) await sql`insert into scenario (owner_id, name, spec) values (${owner.id}, ${"n" + i}, '{}'::jsonb)`;
    const clientOpId = crypto.randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => s.createScenario(owner, input("edge", { clientOpId }))));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.scenario.id)).size).toBe(1);
    expect((await sql`select count(*)::int as n from scenario where owner_id = ${owner.id}`)[0].n).toBe(49);
    expect((await sql`select count(*)::int as n from rate_event where user_id = ${owner.id}`)[0].n).toBe(1);
    // Now at 49 the last slot is still free, and a replay after that is still a replay at the cap.
    await s.createScenario(owner, input("fiftieth"));
    expect((await s.createScenario(owner, input("edge", { clientOpId }))).created).toBe(false);
    await expect(s.createScenario(owner, input("fifty-first"))).rejects.toMatchObject({ status: 409 });
  });

  it("parallel duplicates of a saved op id succeed with one row and one write charged, even at 59 writes", async () => {
    const owner = { id: "sc-edge59", role: "user" as const };
    await sql`insert into "user" (id, name, email) values (${owner.id}, 'e', 'sc-edge59@test.local')`;
    await sql`insert into rate_event (user_id, kind) select ${owner.id}, 'scenario_write' from generate_series(1, 58)`;
    const clientOpId = crypto.randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => s.createScenario(owner, input("edge", { clientOpId }))));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.scenario.id)).size).toBe(1);
    expect((await sql`select count(*)::int as n from scenario where owner_id = ${owner.id}`)[0].n).toBe(1);
    expect((await sql`select count(*)::int as n from rate_event where user_id = ${owner.id}`)[0].n).toBe(59);
    // At the limit a different new create is refused, the replay still answers.
    await s.createScenario(owner, input("sixtieth"));
    await expect(s.createScenario(owner, input("sixty-first"))).rejects.toMatchObject({ status: 429 });
    expect((await s.createScenario(owner, input("edge", { clientOpId }))).created).toBe(false);
  });

  it("saving a result while the scenario is being deleted is a 404, never a database error", async () => {
    for (let i = 0; i < 5; i++) {
      const { scenario } = await s.createScenario(alice, input("race delete"));
      const settled = await Promise.allSettled([
        s.saveScenarioResult(alice, scenario.id, { pricesAsOf: new Date(), result: { n: i } }),
        s.deleteScenario(alice, scenario.id),
      ]);
      const failure = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      if (failure) expect(failure.reason).toMatchObject({ status: 404 });
      expect((await sql`select count(*)::int as n from scenario_result where scenario_id = ${scenario.id}`)[0].n).toBe(0);
    }
  });

  it("60 writes per user per hour (429): creates, updates and deletes all count; replays don't", async () => {
    const owner = { id: "sc-rate", role: "user" as const };
    await sql`insert into "user" (id, name, email) values (${owner.id}, 'rate', 'sc-rate@test.local')`;
    const { scenario } = await s.createScenario(owner, input("rate", { clientOpId: crypto.randomUUID() }));
    const opId = crypto.randomUUID();
    await s.createScenario(owner, input("rate again", { clientOpId: opId }));
    // 2 used; add 58 to reach the limit.
    await sql`insert into rate_event (user_id, kind) select ${owner.id}, 'scenario_write' from generate_series(1, 58)`;
    await expect(s.createScenario(owner, input("blocked"))).rejects.toMatchObject({ status: 429 });
    await expect(s.updateScenario(owner, scenario.id, { version: 1, name: "blocked" })).rejects.toMatchObject({ status: 429 });
    await expect(s.deleteScenario(owner, scenario.id)).rejects.toMatchObject({ status: 429 });
    // A replay returns the stored row without spending a write.
    expect((await s.createScenario(owner, input("rate again", { clientOpId: opId }))).created).toBe(false);
    // Another user is unaffected.
    expect((await s.createScenario(alice, input("unaffected"))).created).toBe(true);
  });

  describe("saved results", () => {
    it("owner stores and reads the latest result; a second save replaces it", async () => {
      const { scenario } = await s.createScenario(alice, input("with result"));
      expect(await s.getScenarioResult(alice, scenario.id)).toBeNull();
      const asOf = new Date("2026-11-14T07:00:00Z");
      await s.saveScenarioResult(alice, scenario.id, { pricesAsOf: asOf, result: { v: 1 } });
      await s.saveScenarioResult(alice, scenario.id, { pricesAsOf: asOf, result: { v: 2 } });
      const got = await s.getScenarioResult(alice, scenario.id);
      expect(got).toMatchObject({ scenarioId: scenario.id, ownerId: alice.id, result: { v: 2 } });
      expect(got!.pricesAsOf.toISOString()).toBe(asOf.toISOString());
      expect((await sql`select count(*)::int as n from scenario_result where scenario_id = ${scenario.id}`)[0].n).toBe(1);
    });

    it("another user and an admin get 404 on read and write, and nothing is stored", async () => {
      const { scenario } = await s.createScenario(alice, input("result private"));
      await s.saveScenarioResult(alice, scenario.id, { pricesAsOf: new Date(), result: { secret: "CANARY" } });
      for (const stranger of [bob, admin]) {
        await rejects404(s.getScenarioResult(stranger, scenario.id));
        await rejects404(s.saveScenarioResult(stranger, scenario.id, { pricesAsOf: new Date(), result: { overwritten: true } }));
      }
      expect((await s.getScenarioResult(alice, scenario.id))!.result).toEqual({ secret: "CANARY" });
    });

    it("the database itself refuses a result owned by someone else (composite foreign key)", async () => {
      const { scenario } = await s.createScenario(alice, input("fk"));
      await expect(
        sql`insert into scenario_result (scenario_id, owner_id, prices_as_of, result) values (${scenario.id}, ${bob.id}, now(), '{}'::jsonb)`,
      ).rejects.toMatchObject({ code: "23503" });
    });

    it("results go when the scenario goes", async () => {
      const { scenario } = await s.createScenario(alice, input("cascade"));
      await s.saveScenarioResult(alice, scenario.id, { pricesAsOf: new Date(), result: {} });
      await s.deleteScenario(alice, scenario.id);
      expect((await sql`select count(*)::int as n from scenario_result where scenario_id = ${scenario.id}`)[0].n).toBe(0);
    });

    it("refuses an oversized result", async () => {
      const { scenario } = await s.createScenario(alice, input("big"));
      await expect(s.saveScenarioResult(alice, scenario.id, { pricesAsOf: new Date(), result: { blob: "x".repeat(300_000) } })).rejects.toMatchObject({ status: 400 });
    });
  });
});
