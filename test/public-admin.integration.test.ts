/** Public price table (active rows only), admin stats (counts only; users 403), against a real Postgres. */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_SPEC } from "@/lib/pricing/spec";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("public data and admin stats (Postgres)", () => {
  let sql: postgres.Sql;
  const alice = { id: "pa-alice", role: "user" as const };
  const admin = { id: "pa-admin", role: "admin" as const };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id like 'pa-%'`;
    await sql`delete from price_point where sku_key like 'pa.%'`;
    for (const u of [alice, admin]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
  });
  afterAll(async () => {
    await sql`delete from "user" where id like 'pa-%'`;
    await sql`delete from price_point where sku_key like 'pa.%'`;
    await sql.end();
  });

  it("price_point: the public reads active rows; quarantined rows stay hidden; filters validate", async () => {
    const { listPricePoints } = await import("@/lib/prices");
    const row = (sku: string, status: string) =>
      sql`insert into price_point (cloud, component, sku_key, region, unit, usd_micros, source_url, status)
          values ('aws', 'vm', ${sku}, 'us-east-2', 'hour', 1000, 'https://example.test/src', ${status})`;
    await row("pa.active", "active");
    await row("pa.quarantined", "quarantined");
    const rows = await listPricePoints({ cloud: "aws", component: "vm" });
    const skus = rows.map((p) => p.skuKey);
    expect(skus).toContain("pa.active");
    expect(skus).not.toContain("pa.quarantined");
    expect(rows.every((p) => p.status === "active")).toBe(true);
    await expect(listPricePoints({ cloud: "mars" })).rejects.toMatchObject({ name: "ZodError" });
    // Same (cloud, sku, region, tier) twice is refused by the unique index.
    await expect(row("pa.active", "active")).rejects.toMatchObject({ code: "23505" });
  });

  it("admin stats: counts only, and a user or a stranger gets 403", async () => {
    const { adminStats } = await import("@/lib/admin-stats");
    const { createScenario } = await import("@/lib/scenarios");
    await createScenario(alice, { name: "CANARY-SCENARIO-NAME", spec: BASE_SPEC });
    await sql`insert into advice (owner_id, question, output, trace, checks, provider) values (${alice.id}, 'CANARY-QUESTION', '{"headline":"CANARY-OUTPUT"}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'demo')`;
    const stats = await adminStats(admin);
    expect(stats.scenarios).toBeGreaterThanOrEqual(1);
    expect(stats.advice).toBeGreaterThanOrEqual(1);
    expect(stats.users).toBeGreaterThanOrEqual(2);
    expect(stats.advisor.dailyCap).toBeGreaterThan(0);
    expect(typeof stats.prices.active).toBe("number");
    const json = JSON.stringify(stats);
    expect(json).not.toContain("CANARY");
    expect(json).not.toContain("pa-alice");
    await expect(adminStats(alice)).rejects.toMatchObject({ status: 403 });
  });

  it("admin stats include the latest refresh per source, status only", async () => {
    const { adminStats } = await import("@/lib/admin-stats");
    await sql`delete from price_refresh where source = 'oci'`;
    await sql`insert into price_refresh (source, trigger, outcome, rows_upserted, started_at, finished_at) values ('oci', 'scheduler', 'failed', 0, now() - interval '2 hours', now())`;
    await sql`insert into price_refresh (source, trigger, outcome, rows_upserted, error_code) values ('oci', 'admin', 'ok', 12, null)`;
    const stats = await adminStats(admin);
    const oci = stats.refresh.filter((x) => x.source === "oci");
    expect(oci).toHaveLength(1);
    expect(oci[0]).toMatchObject({ outcome: "ok", rowsUpserted: 12 });
    await sql`delete from price_refresh where source = 'oci'`;
  });
});
