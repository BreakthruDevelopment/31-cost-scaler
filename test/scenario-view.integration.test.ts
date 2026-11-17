/**
 * What the scenario screens load, against a real Postgres (TEST_DATABASE_URL): the list, the builder and the
 * comparison all go through the owner-scoped data functions, so another user's id is "not found" here too, and a
 * comparison reads the result stored at save time or prices the scenario itself when there is none.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_SPEC } from "@/lib/pricing/spec";
import { REGIONS } from "@/lib/price-ingest/types";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("scenario screens (Postgres)", () => {
  let sql: postgres.Sql;
  let view: typeof import("@/lib/scenario-view");
  let store: typeof import("@/lib/scenarios");
  const alice = { id: "sv-alice", role: "user" as const };
  const bob = { id: "sv-bob", role: "user" as const };
  const SOURCE = "https://example.test/prices";

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id like 'sv-%'`;
    for (const u of [alice, bob]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    // A tiny price table: enough for a complete AWS total on the base spec is not the point here, only that
    // pricing runs against real rows and that a cloud with no rows is never turned into a number.
    await sql`delete from price_point where source_url = ${SOURCE}`;
    const rows: [string, string, string, string, number][] = [
      ["aws", "serverless", "serverless.vcpu", "vcpu_hour", 40_480],
      ["aws", "serverless", "serverless.gb", "gb_hour", 4_445],
      ["aws", "postgres", "postgres.1vcpu-1gb", "hour", 20_000],
      ["aws", "postgres", "postgres.storage", "gb_month", 115_000],
      ["aws", "object_storage", "object_storage.gb", "gb_month", 23_000],
      ["aws", "egress", "egress.gb", "gb", 90_000],
      ["aws", "identity", "identity.mau", "mau", 5_500],
    ];
    for (const [cloud, component, skuKey, unit, micros] of rows) {
      await sql`insert into price_point (cloud, component, sku_key, region, unit, usd_micros, source_url)
                values (${cloud}, ${component}, ${skuKey}, ${REGIONS.aws}, ${unit}, ${micros}, ${SOURCE})
                on conflict do nothing`;
    }
    view = await import("@/lib/scenario-view");
    store = await import("@/lib/scenarios");
  });

  afterAll(async () => {
    await sql`delete from price_point where source_url = ${SOURCE}`;
    await sql`delete from "user" where id like 'sv-%'`;
    await sql.end();
  });

  const create = (owner: typeof alice, name: string) => store.createScenario(owner, { name, spec: BASE_SPEC });

  it("lists only the caller's own scenarios, with the cap", async () => {
    const mine = await create(alice, "alice list");
    await create(bob, "bob list");
    const list = await view.loadScenarioList(alice);
    expect(list.rows.map((r) => r.id)).toContain(mine.scenario.id);
    expect(list.rows.every((r) => r.ownerId === alice.id)).toBe(true);
    expect(list.max).toBe(store.MAX_SCENARIOS_PER_USER);
    expect(list.atCap).toBe(false);
  });

  it("builds a new scenario from the base spec and prices it on all four clouds", async () => {
    const built = await view.loadBuilder(alice, null);
    expect(built.scenario).toBeNull();
    expect(built.draft.name).toBe("");
    expect(built.draft.users.mau).toBe(String(BASE_SPEC.users.mau));
    expect(Object.keys(built.result.clouds).sort()).toEqual(["aws", "azure", "gcp", "oci"]);
    // Only AWS has rows here: the other three are left incomplete, never totalled as zero.
    expect(built.result.clouds.gcp.complete).toBe(false);
  });

  it("opens the caller's own scenario, and answers 404 for anyone else's", async () => {
    const { scenario } = await create(alice, "alice builder");
    const built = await view.loadBuilder(alice, scenario.id);
    expect(built.scenario).toEqual({ id: scenario.id, version: scenario.version });
    expect(built.draft.name).toBe("alice builder");
    await expect(view.loadBuilder(bob, scenario.id)).rejects.toMatchObject({ status: 404 });
    await expect(view.loadBuilder(alice, "not-a-uuid")).rejects.toMatchObject({ status: 404 });
  });

  it("refuses to compare fewer than two or more than three", async () => {
    const a = await create(alice, "cmp a");
    expect(await view.loadComparison(alice, [])).toMatchObject({ ok: false, reason: "too_few" });
    expect(await view.loadComparison(alice, [a.scenario.id])).toMatchObject({ ok: false, reason: "too_few" });
    const ids = await Promise.all([1, 2, 3, 4].map(async (n) => (await create(alice, `cmp many ${n}`)).scenario.id));
    expect(await view.loadComparison(alice, ids)).toMatchObject({ ok: false, reason: "too_many" });
  });

  it("will not compare another user's scenario, and says the same as for a deleted one", async () => {
    const mine = await create(alice, "cmp mine");
    const other = await create(bob, "cmp bob");
    const gone = await create(alice, "cmp gone");
    await store.deleteScenario(alice, gone.scenario.id);
    const borrowed = await view.loadComparison(alice, [mine.scenario.id, other.scenario.id]);
    const deleted = await view.loadComparison(alice, [mine.scenario.id, gone.scenario.id]);
    expect(borrowed).toMatchObject({ ok: false, reason: "missing" });
    expect(deleted).toMatchObject({ ok: false, reason: "missing" });
    if (!borrowed.ok && !deleted.ok) expect(borrowed.message).toBe(deleted.message);
  });

  it("prices a scenario with no saved result, and reuses the saved one when there is one", async () => {
    const a = await create(alice, "cmp saved");
    const b = await create(alice, "cmp unsaved");
    await view.storeScenarioResult(alice, a.scenario);

    const compared = await view.loadComparison(alice, [a.scenario.id, b.scenario.id]);
    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    const [first, second] = compared.comparison.scenarios;
    expect(first.source).toBe("saved");
    expect(second.source).toBe("computed");
    // Same spec and the same price rows: the stored numbers must equal the freshly computed ones.
    expect(first.price.clouds.aws.totalMicros).toBe(second.price.clouds.aws.totalMicros);
    expect(compared.comparison.rows.map((r) => r.cloud)).toEqual(["aws", "azure", "gcp", "oci"]);
  });

  it("re-prices instead of trusting a stored result written in another shape", async () => {
    const a = await create(alice, "cmp stale shape");
    const b = await create(alice, "cmp plain");
    await store.saveScenarioResult(alice, a.scenario.id, { version: a.scenario.version, pricesAsOf: new Date(), result: { v: 99, price: { nonsense: true } } });
    const compared = await view.loadComparison(alice, [a.scenario.id, b.scenario.id]);
    expect(compared.ok).toBe(true);
    if (compared.ok) expect(compared.comparison.scenarios[0].source).toBe("computed");
  });

  /**
   * Two saves overlapping on one scenario, interleaved on purpose: save A commits version 2 and pauses where the
   * real code pauses (between pricing and the write), save B commits version 3 and stores its own result, then A
   * resumes and tries to write. A's numbers are for a spec that no longer exists, so the write must not land —
   * otherwise `loadComparison` reads them back and shows an admin the cost of the wrong spec.
   */
  it("discards a priced result whose scenario moved on while it was being priced", async () => {
    const pricing = await import("@/lib/pricing/scenario");
    const data = await import("@/lib/pricing/data");
    const compare = await import("@/lib/scenario-compare");

    const { scenario } = await create(alice, "race save");
    // Two specs the price table tells apart: 20 GB of egress against 2000 GB.
    const specA = { ...BASE_SPEC, storage: { objectGb: 10, egressGb: 20 } };
    const specB = { ...BASE_SPEC, storage: { objectGb: 10, egressGb: 2_000 } };
    const v2 = await store.updateScenario(alice, scenario.id, { version: scenario.version, spec: specA });

    const table = await data.loadPriceTable(alice);
    const pricedA = pricing.priceScenario(specA, table);
    const pricedB = pricing.priceScenario(specB, table);
    expect(pricedA.clouds.aws.totalMicros).not.toBe(pricedB.clouds.aws.totalMicros);

    // Save A: priced version 2, now paused in flight, holding the row it read.
    let resumeA = () => {};
    const pausedA = new Promise<void>((resolve) => {
      resumeA = resolve;
    });
    const saveA = (async () => {
      await pausedA;
      return store.saveScenarioResult(alice, scenario.id, { version: v2.version, pricesAsOf: new Date(), result: compare.toStoredResult(pricedA) });
    })();

    // Save B, while A is still paused: version 3, and its result stored.
    const v3 = await store.updateScenario(alice, scenario.id, { version: v2.version, spec: specB });
    expect(v3.version).toBe(v2.version + 1);
    expect(await store.saveScenarioResult(alice, scenario.id, { version: v3.version, pricesAsOf: new Date(), result: compare.toStoredResult(pricedB) })).not.toBeNull();

    // A resumes last and is told its write was dropped, rather than being told it saved.
    resumeA();
    expect(await saveA).toBeNull();

    // What a comparison will read back is version 3's numbers.
    const saved = compare.readStoredResult((await store.getScenarioResult(alice, scenario.id))?.result);
    expect(saved?.clouds.aws.totalMicros).toBe(pricedB.clouds.aws.totalMicros);
    const other = await create(alice, "race other");
    const compared = await view.loadComparison(alice, [scenario.id, other.scenario.id]);
    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    expect(compared.comparison.scenarios[0]).toMatchObject({ id: scenario.id, source: "saved" });
    expect(compared.comparison.scenarios[0].price.clouds.aws.totalMicros).toBe(pricedB.clouds.aws.totalMicros);
  });

  it("stores a result a later comparison can read back", async () => {
    const { scenario } = await create(alice, "cmp store");
    await view.storeScenarioResult(alice, scenario);
    const [row] = await sql<{ result: { v: number } }[]>`select result from scenario_result where scenario_id = ${scenario.id}`;
    expect(row.result.v).toBe(1);
    const saved = await store.getScenarioResult(alice, scenario.id);
    expect(saved?.ownerId).toBe(alice.id);
    // Another user can never read it, even knowing the id.
    await expect(store.getScenarioResult(bob, scenario.id)).rejects.toMatchObject({ status: 404 });
  });
});
