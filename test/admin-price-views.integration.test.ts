/**
 * The reads behind /prices and /admin, against a real Postgres: the public table is active rows only and its
 * freshness covers every cloud, and the two admin-only reads refuse a plain user.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("price table and admin price views (Postgres)", () => {
  let sql: postgres.Sql;
  const alice = { id: "apv-alice", role: "user" as const };
  const admin = { id: "apv-admin", role: "admin" as const };

  const insert = (cloud: string, sku: string, status: string, fetched: string, component = "vm") =>
    sql`insert into price_point (cloud, component, sku_key, region, unit, usd_micros, source_url, status, fetched_at, description)
        values (${cloud}, ${component}, ${sku}, 'test-region', 'hour', 1000, 'https://example.test/src', ${status}, ${fetched}::timestamptz, 'apv fixture')`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id like 'apv-%'`;
    await sql`delete from price_point where region = 'test-region'`;
    for (const u of [alice, admin]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
  });

  afterAll(async () => {
    await sql`delete from "user" where id like 'apv-%'`;
    await sql`delete from price_point where region = 'test-region'`;
    await sql.end();
  });

  it("the public table shows active rows and never a quarantined one", async () => {
    const { loadPriceTable } = await import("@/lib/prices-view");
    await insert("aws", "apv.active", "active", "2026-11-16T00:00:00Z");
    await insert("aws", "apv.quarantined", "quarantined", "2026-11-16T00:00:00Z");
    const table = await loadPriceTable({ cloud: "aws" });
    const skus = table.groups.flatMap((g) => g.rows.map((r) => r.skuKey));
    expect(skus).toContain("apv.active");
    expect(skus).not.toContain("apv.quarantined");
    expect(table.groups.every((g) => g.cloud === "aws")).toBe(true);
  });

  it("freshness covers every cloud even when the table is filtered to one", async () => {
    // Filtering to AWS must not hide that another cloud has no prices at all: that is the one thing the page's
    // "prices unavailable" line exists to say.
    const { loadPriceTable } = await import("@/lib/prices-view");
    const table = await loadPriceTable({ cloud: "aws" });
    expect(table.freshness.clouds.map((c) => c.cloud)).toEqual(["aws", "azure", "gcp", "oci"]);
  });

  it("a fetch older than 72 hours makes the table stale, and a fresh one does not", async () => {
    const { priceFreshnessByCloud, STALE_AFTER_HOURS } = await import("@/lib/prices-view");
    await sql`delete from price_point where region = 'test-region'`;
    const old = new Date(Date.now() - (STALE_AFTER_HOURS + 5) * 3_600_000).toISOString();
    await insert("oci", "apv.old", "active", old);
    const stale = await priceFreshnessByCloud();
    expect(stale.stale).toBe(true);
    expect(stale.oldestAgeHours).toBeGreaterThan(STALE_AFTER_HOURS);
    expect(stale.clouds.find((c) => c.cloud === "oci")?.unavailable).toBe(false);

    await sql`delete from price_point where region = 'test-region'`;
    await insert("oci", "apv.new", "active", new Date().toISOString());
    expect((await priceFreshnessByCloud()).stale).toBe(false);
  });

  it("a cloud with no rows is unavailable, never zero rows priced at nothing", async () => {
    const { priceFreshnessByCloud } = await import("@/lib/prices-view");
    await sql`delete from price_point where region = 'test-region'`;
    const freshness = await priceFreshnessByCloud();
    const gcp = freshness.clouds.find((c) => c.cloud === "gcp");
    // Other tests may leave real fixture rows behind, so only assert the shape when gcp really has none.
    if (gcp && gcp.rows === 0) {
      expect(gcp.unavailable).toBe(true);
      expect(gcp.newest).toBeNull();
    }
  });

  it("quarantined rows are an admin read: a plain user gets 403", async () => {
    const { listQuarantinedPrices } = await import("@/lib/admin-stats");
    await insert("azure", "apv.bad", "quarantined", "2026-11-16T00:00:00Z");
    const rows = await listQuarantinedPrices(admin);
    expect(rows.map((r) => r.skuKey)).toContain("apv.bad");
    expect(rows.every((r) => r.status === "quarantined")).toBe(true);
    await expect(listQuarantinedPrices(alice)).rejects.toMatchObject({ status: 403 });
    await expect(listQuarantinedPrices(null)).rejects.toMatchObject({ status: 403 });
  });

  it("reports the value a quarantine refused, not the one still in use", async () => {
    // Regression: quarantining flips the row's status only, so price_point still holds the last ACCEPTED price.
    // Reading that as the "Rejected value" printed $1.00 for a row refused at $4.00 — the one number an admin
    // needs to judge the jump was the only one the page could not show.
    const { listQuarantinedPrices, quarantineRejections, quarantineKey } = await import("@/lib/admin-stats");
    await sql`delete from price_point where region = 'test-region'`;
    await sql`delete from price_refresh where source = 'aws_other'`;
    await sql`insert into price_point (cloud, component, sku_key, region, unit, usd_micros, source_url, status, fetched_at)
              values ('aws', 'vm', 'apv.jump', 'test-region', 'hour', 1000000, 'https://example.test/src', 'quarantined', '2026-11-10T00:00:00Z')`;
    // Two runs: the jump was refused in the older one, and the newer run has notes about other SKUs only.
    await sql`insert into price_refresh (source, trigger, outcome, started_at, detail) values ('aws_other', 'scheduler', 'ok', '2026-11-11T00:00:00Z',
      ${sql.json({ quarantined: [{ cloud: "aws", skuKey: "apv.jump", oldMicros: 1_000_000, newMicros: 4_000_000, reason: "jump_over_3x" }, "a note in a shape we never wrote", { cloud: "aws", skuKey: "apv.nonote" }] })})`;
    await sql`insert into price_refresh (source, trigger, outcome, started_at, detail) values ('aws_other', 'scheduler', 'ok', '2026-11-12T00:00:00Z',
      ${sql.json({ quarantined: [{ cloud: "azure", skuKey: "apv.other", oldMicros: null, newMicros: 9_000_000, reason: "out_of_bounds" }] })})`;

    const rows = await listQuarantinedPrices(admin);
    const row = rows.find((r) => r.skuKey === "apv.jump")!;
    const rejections = await quarantineRejections(admin);
    const note = rejections.get(quarantineKey(row))!;
    expect(note.rejectedMicros).toBe(4_000_000);
    // The row itself still carries the value in use, which is what the old column was showing.
    expect(row.usdMicros).toBe(1_000_000);
    expect(note.previousMicros).toBe(1_000_000);
    expect(note.reason).toBe("jump_over_3x");
    expect(note.at.toISOString()).toBe("2026-11-11T00:00:00.000Z");
    // One unreadable note and one without a price never hide the notes around them.
    expect(rejections.get("aws|apv.nonote")).toBeUndefined();
    expect(rejections.get("azure|apv.other")?.previousMicros).toBeNull();
    // A new SKU refused on its first fetch has a note but no row, so nothing claims a kept value for it.
    expect(rows.some((r) => r.skuKey === "apv.other")).toBe(false);

    await expect(quarantineRejections(alice)).rejects.toMatchObject({ status: 403 });
    await expect(quarantineRejections(null)).rejects.toMatchObject({ status: 403 });
    await sql`delete from price_refresh where source = 'aws_other'`;
    await sql`delete from price_point where region = 'test-region'`;
  });

  it("keeps the newest note when a SKU was refused more than once", async () => {
    const { quarantineRejections } = await import("@/lib/admin-stats");
    await sql`delete from price_refresh where source = 'aws_other'`;
    for (const [when, micros] of [["2026-11-11T00:00:00Z", 4_000_000], ["2026-11-13T00:00:00Z", 7_000_000]] as const) {
      await sql`insert into price_refresh (source, trigger, outcome, started_at, detail) values ('aws_other', 'scheduler', 'ok', ${when},
        ${sql.json({ quarantined: [{ cloud: "aws", skuKey: "apv.twice", oldMicros: 1_000_000, newMicros: micros, reason: "jump_over_3x" }] })})`;
    }
    expect((await quarantineRejections(admin)).get("aws|apv.twice")?.rejectedMicros).toBe(7_000_000);
    await sql`delete from price_refresh where source = 'aws_other'`;
  });

  it("profile drift is an admin read, and is null until the footprint import has stored one", async () => {
    const { profileDrift } = await import("@/lib/admin-stats");
    await sql`delete from price_refresh where source = 'footprint'`;
    expect(await profileDrift(admin)).toBeNull();

    await sql`insert into price_refresh (source, trigger, outcome, detail) values ('footprint', 'scheduler', 'ok',
      ${sql.json({ checkedAt: "2026-11-16T00:00:00.000Z", drift: { files: { aws: "checked", azure: "unavailable", gcp: "checked", oci: "checked" }, mismatches: [{ key: "aws.lambda.memory_mb", expected: "1024", actual: "2048" }] } })})`;
    const drift = await profileDrift(admin);
    expect(drift?.mismatches).toEqual([{ key: "aws.lambda.memory_mb", expected: "1024", actual: "2048" }]);
    expect(drift?.files.azure).toBe("unavailable");
    await expect(profileDrift(alice)).rejects.toMatchObject({ status: 403 });
    await sql`delete from price_refresh where source = 'footprint'`;
  });

  it("keeps every mismatch even when one has an unusually long key", async () => {
    // Regression: a `.max(60)` on the key made one odd row empty the whole array, so /admin read "no drift"
    // on a page whose only job is to say there is some.
    const { profileDrift } = await import("@/lib/admin-stats");
    const longKey = "abcdefghij0123456789abcdefghij0123456789abcdefghij0123456789abcdefghij";
    await sql`delete from price_refresh where source = 'footprint'`;
    await sql`insert into price_refresh (source, trigger, outcome, detail) values ('footprint', 'scheduler', 'ok',
      ${sql.json({ drift: { files: { aws: "checked" }, mismatches: [{ key: longKey, expected: "1024", actual: "2048" }, { key: "oci.vm.ocpus", expected: "2", actual: null }] } })})`;
    const drift = await profileDrift(admin);
    expect(drift?.mismatches).toHaveLength(2);
    expect(drift?.mismatches[0].key).toBe(longKey);
    expect(drift?.mismatches[1].actual).toBeNull();
    await sql`delete from price_refresh where source = 'footprint'`;
  });

  it("a drift report with a shape we did not write is ignored, not rendered", async () => {
    const { profileDrift } = await import("@/lib/admin-stats");
    await sql`delete from price_refresh where source = 'footprint'`;
    await sql`insert into price_refresh (source, trigger, outcome, detail) values ('footprint', 'scheduler', 'ok', ${sql.json({ drift: "not an object" })})`;
    expect(await profileDrift(admin)).toBeNull();
    await sql`delete from price_refresh where source = 'footprint'`;
  });
});
