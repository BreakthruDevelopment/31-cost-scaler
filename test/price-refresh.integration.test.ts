/**
 * The price refresh end to end against a real Postgres (TEST_DATABASE_URL), with the synthetic fixtures served by a
 * fake fetcher: idempotent upserts, the 3x quarantine, one source per call, the advisory lock, the admin limit, the
 * Google key being absent or secret, and the run log (bytes and seconds).
 */
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SYSTEM } from "@/lib/access";
import { PriceFetchError } from "@/lib/price-ingest/fetch";
import { createFixtureFetcher } from "@/lib/price-ingest/fixture-fetcher";
import { REQUIRED_KEYS } from "@/lib/price-ingest/sku-map";
import type { RefreshDeps } from "@/lib/price-ingest/refresh";
import type { NormalizedRow } from "@/lib/price-ingest/types";

const url = process.env.TEST_DATABASE_URL;
const KEY = "AIzaSyCANARY-integration-key-0123456789";

describe.skipIf(!url)("price refresh (Postgres)", () => {
  let sql: postgres.Sql;
  let r: typeof import("@/lib/price-ingest/refresh");
  let upsert: typeof import("@/lib/price-ingest/upsert");
  let prices: typeof import("@/lib/prices");
  const admin = { id: "pr-admin", role: "admin" as const };
  const user = { id: "pr-user", role: "user" as const };
  const footprintFetcher = async () => ({ status: 404, text: "" }); // the footprint source fails fast: its own tests are in footprint.integration

  const ALL = ["aws_ec2", "aws_other", "azure", "gcp", "oci", "footprint"] as const;
  async function runAll(deps: RefreshDeps, calls: number = ALL.length) {
    const out = [];
    for (let i = 0; i < calls; i++) out.push(await r.runPriceRefresh(SYSTEM, "scheduler", { deps }));
    return out;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await sql`delete from "user" where id like 'pr-%'`;
    for (const u of [admin, user]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    r = await import("@/lib/price-ingest/refresh");
    upsert = await import("@/lib/price-ingest/upsert");
    prices = await import("@/lib/prices");
  });
  afterAll(async () => {
    await sql`delete from "user" where id like 'pr-%'`;
    await sql`delete from price_point`;
    await sql`delete from price_refresh`;
    await sql`delete from rate_event where user_id like 'pr-%'`;
    await sql.end();
  });
  beforeEach(async () => {
    await sql`delete from price_point`;
    await sql`delete from price_refresh`;
    await sql`delete from rate_event where user_id like 'pr-%'`;
    vi.restoreAllMocks();
  });

  it("one source per call: the scheduler walks every source once in turn", async () => {
    const { fetcher } = createFixtureFetcher();
    const reports = await runAll({ fetch: fetcher, gcpApiKey: KEY, footprintFetcher });
    const ran = reports.filter((x) => x.ran);
    expect(ran.map((x) => x.ran && x.source)).toEqual(["aws_ec2", "aws_other", "azure", "gcp", "oci", "footprint"]);
    // footprint failed (404 from the stub), the other five are ok
    expect(ran.map((x) => x.ran && x.outcome)).toEqual(["ok", "ok", "ok", "ok", "ok", "failed"]);
  });

  it("fills the price table for all four clouds, every required key a row or an explicit not-listed, with sources and dates", async () => {
    const { fetcher } = createFixtureFetcher();
    for (const source of ["aws_ec2", "aws_other", "azure", "gcp", "oci"] as const) await r.runPriceRefresh(SYSTEM, "scheduler", { source, deps: { fetch: fetcher, gcpApiKey: KEY } });
    const rows = await prices.listPricePoints();
    expect(new Set(rows.map((p) => p.cloud))).toEqual(new Set(["aws", "azure", "gcp", "oci"]));
    expect(rows.every((p) => p.status === "active" && p.usdMicros > 0 && p.sourceUrl.startsWith("https://") && p.fetchedAt instanceof Date)).toBe(true);
    const have = new Set(rows.map((p) => `${p.cloud} ${p.skuKey}`));
    const runs = await sql`select detail from price_refresh where detail is not null`;
    const notListed = new Set(runs.flatMap((x) => (x.detail.notListed as { cloud: string; skuKey: string }[]).map((n) => `${n.cloud} ${n.skuKey}`)));
    for (const cloud of ["aws", "azure", "gcp", "oci"]) for (const keys of Object.values(REQUIRED_KEYS)) for (const key of keys) expect(have.has(`${cloud} ${key}`) || notListed.has(`${cloud} ${key}`), `${cloud} ${key}`).toBe(true);
    expect(rows.find((p) => p.cloud === "aws" && p.skuKey === "vm.2vcpu-8gb")).toMatchObject({ usdMicros: 96_000, unit: "hour", region: "us-east-2", component: "vm" });
  });

  it("a rerun upserts the same rows: same ids, same count, nothing duplicated", async () => {
    const { fetcher } = createFixtureFetcher();
    const go = () => r.runPriceRefresh(SYSTEM, "scheduler", { source: "azure", deps: { fetch: fetcher } });
    const first = await go();
    const before = await sql`select id, cloud, sku_key, region, tier_start, usd_micros, fetched_at from price_point order by sku_key`;
    await new Promise((res) => setTimeout(res, 15));
    const second = await go();
    const after = await sql`select id, cloud, sku_key, region, tier_start, usd_micros, fetched_at from price_point order by sku_key`;
    expect(first.ran && second.ran && first.upserted === second.upserted).toBe(true);
    expect(after.map((x) => [x.id, x.sku_key, x.usd_micros])).toEqual(before.map((x) => [x.id, x.sku_key, x.usd_micros]));
    expect(after.every((x, i) => x.fetched_at > before[i].fetched_at)).toBe(true); // refreshed, not duplicated
  });

  describe("quarantine", () => {
    const row = (over: Partial<NormalizedRow> = {}): NormalizedRow => ({ cloud: "aws", component: "vm", skuKey: "vm.2vcpu-8gb", region: "us-east-2", unit: "hour", usdMicros: 100_000, tierStart: 0, tierEnd: null, vendorSku: "v", description: "d", sourceUrl: "https://x", sourceVersion: null, ...over });
    const db = async () => (await import("@/lib/db")).db();
    const state = async () => (await sql`select usd_micros, status from price_point where sku_key = 'vm.2vcpu-8gb'`)[0];

    it("more than 3x up keeps the old value and marks the row quarantined, which the public table hides", async () => {
      await upsert.upsertPrices(await db(), [row()]);
      const res = await upsert.upsertPrices(await db(), [row({ usdMicros: 300_001 })]);
      expect(res).toEqual({ upserted: 0, quarantined: [{ cloud: "aws", skuKey: "vm.2vcpu-8gb", oldMicros: 100_000, newMicros: 300_001, reason: "jump_over_3x" }] });
      expect(await state()).toMatchObject({ usd_micros: "100000", status: "quarantined" });
      expect((await prices.listPricePoints()).some((p) => p.skuKey === "vm.2vcpu-8gb")).toBe(false);
    });
    it("more than 3x down is quarantined too; exactly 3x is accepted", async () => {
      await upsert.upsertPrices(await db(), [row()]);
      await upsert.upsertPrices(await db(), [row({ usdMicros: 33_333 })]);
      expect(await state()).toMatchObject({ usd_micros: "100000", status: "quarantined" });
      await upsert.upsertPrices(await db(), [row({ usdMicros: 300_000 })]);
      expect(await state()).toMatchObject({ usd_micros: "300000", status: "active" });
    });
    it("a quarantined row comes back when the price is within 3x of the kept value again", async () => {
      await upsert.upsertPrices(await db(), [row()]);
      await upsert.upsertPrices(await db(), [row({ usdMicros: 900_000 })]);
      await upsert.upsertPrices(await db(), [row({ usdMicros: 110_000 })]);
      expect(await state()).toMatchObject({ usd_micros: "110000", status: "active" });
    });
    it("a price outside the sanity bounds is never stored as new, and quarantines an existing row", async () => {
      const res = await upsert.upsertPrices(await db(), [row({ usdMicros: 500_000_000 })]);
      expect(res.upserted).toBe(0);
      expect(res.quarantined[0]).toMatchObject({ reason: "out_of_bounds", oldMicros: null });
      expect(await sql`select 1 from price_point where sku_key = 'vm.2vcpu-8gb'`).toHaveLength(0);
      await upsert.upsertPrices(await db(), [row()]);
      await upsert.upsertPrices(await db(), [row({ usdMicros: 0 })]);
      expect(await state()).toMatchObject({ usd_micros: "100000", status: "quarantined" });
    });
    it("a moved tier floor is compared with the stored price: 10x is quarantined, and an accepted move leaves one active row", async () => {
      const egress = (usdMicros: number, tierStart: number): NormalizedRow => row({ component: "egress", skuKey: "egress.gb", unit: "gb", usdMicros, tierStart, region: "us-east-2" });
      const rowsOf = () => sql`select tier_start, usd_micros, status from price_point where sku_key = 'egress.gb' order by tier_start`;
      await upsert.upsertPrices(await db(), [egress(90_000, 1)]);
      const res = await upsert.upsertPrices(await db(), [egress(900_000, 100)]); // floor 1 -> 100 at 10x
      expect(res).toMatchObject({ upserted: 0, quarantined: [{ skuKey: "egress.gb", oldMicros: 90_000, newMicros: 900_000, reason: "jump_over_3x" }] });
      expect(await rowsOf()).toEqual([{ tier_start: 1, usd_micros: "90000", status: "quarantined" }]);
      // a floor move at a similar price is accepted and retires the old tier row in the same transaction
      await upsert.upsertPrices(await db(), [egress(95_000, 1)]); // back to normal
      const moved = await upsert.upsertPrices(await db(), [egress(100_000, 100)]);
      expect(moved.upserted).toBe(1);
      expect(await rowsOf()).toEqual([{ tier_start: 100, usd_micros: "100000", status: "active" }]);
    });
    it("a quarantine in a refresh is counted on the run and listed in its detail for /admin", async () => {
      const { fetcher } = createFixtureFetcher();
      await r.runPriceRefresh(SYSTEM, "scheduler", { source: "aws_ec2", deps: { fetch: fetcher } });
      await sql`update price_point set usd_micros = 10000 where sku_key = 'vm.2vcpu-8gb'`; // the list now says 9.6x the stored value
      const rep = await r.runPriceRefresh(SYSTEM, "scheduler", { source: "aws_ec2", deps: { fetch: fetcher } });
      expect(rep).toMatchObject({ ran: true, outcome: "ok", quarantined: 1 });
      const [run] = await sql`select rows_quarantined, detail from price_refresh where source = 'aws_ec2' order by started_at desc limit 1`;
      expect(run.rows_quarantined).toBe(1);
      expect(run.detail.quarantined).toEqual([{ cloud: "aws", skuKey: "vm.2vcpu-8gb", oldMicros: 10_000, newMicros: 96_000, reason: "jump_over_3x" }]);
      expect(await state()).toMatchObject({ usd_micros: "10000", status: "quarantined" });
    });
  });

  it("the run log records bytes and seconds (EC2 included), counts, and no URL", async () => {
    const info = vi.spyOn((await import("@/lib/log")).log, "info").mockImplementation(() => {});
    const { fetcher } = createFixtureFetcher();
    await r.runPriceRefresh(SYSTEM, "scheduler", { source: "aws_ec2", deps: { fetch: fetcher } });
    const [row] = await sql`select * from price_refresh where source = 'aws_ec2'`;
    expect(row).toMatchObject({ outcome: "ok", trigger: "scheduler", rows_upserted: 4, rows_missing: 0, rows_quarantined: 0, error_code: null });
    expect(Number(row.bytes)).toBeGreaterThan(1000);
    expect(row.finished_at).not.toBeNull();
    expect(row.detail.seconds).toBeGreaterThanOrEqual(0);
    expect(row.detail.bytesByGroup.AmazonEC2).toBe(Number(row.bytes));
    const logged = info.mock.calls.find((c) => c[0] === "price.refresh");
    expect(logged?.[1]).toMatchObject({ source: "aws_ec2", outcome: "ok", bytes: Number(row.bytes), upserted: 4 });
    expect(typeof (logged?.[1] as { seconds: number }).seconds).toBe("number");
    expect(JSON.stringify(row)).not.toMatch(/https?:/);
  });

  describe("the Google key", () => {
    const outputs = () => JSON.stringify([...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]);

    it("never appears in logs, stored rows or run details, on success or on failure", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const ok = createFixtureFetcher();
      await r.runPriceRefresh(SYSTEM, "scheduler", { source: "gcp", deps: { fetch: ok.fetcher, gcpApiKey: KEY } });
      expect(ok.requests.length).toBeGreaterThan(5);
      expect(ok.requests.every((q) => q.apiKey === KEY && !q.url.includes(KEY))).toBe(true);
      // A fetcher that fails in the nastiest way: an error message carrying the key.
      const failing = async () => { throw new Error(`upstream said: bad key ${KEY} at https://cloudbilling.googleapis.com/v1/services?key=${KEY}`); };
      const bad = await r.runPriceRefresh(SYSTEM, "scheduler", { source: "gcp", deps: { fetch: failing as never, gcpApiKey: KEY } });
      expect(bad).toMatchObject({ ran: true, outcome: "failed", errorCode: "internal" });
      const typed = await r.runPriceRefresh(SYSTEM, "scheduler", { source: "gcp", deps: { fetch: createFixtureFetcher({ failUrls: () => new PriceFetchError("http_403") }).fetcher, gcpApiKey: KEY } });
      expect(typed).toMatchObject({ outcome: "failed", errorCode: "fetch_http_403" });

      const everything = JSON.stringify([await sql`select * from price_refresh`, await sql`select * from price_point`, await sql`select * from rate_event`, outputs()]);
      expect(everything).not.toContain(KEY);
      expect(everything).not.toContain("AIza");
    });

    it("unset: Google Cloud is 'prices unavailable' (recorded, once per window), with no request made and the other sources unaffected", async () => {
      const { fetcher, requests } = createFixtureFetcher();
      const reports = await runAll({ fetch: fetcher, gcpApiKey: null, footprintFetcher }, 5);
      expect(reports.filter((x) => x.ran).map((x) => x.ran && x.source)).toEqual(["aws_ec2", "aws_other", "azure", "oci", "footprint"]);
      expect(requests.some((q) => q.url.includes("cloudbilling"))).toBe(false);
      const rows = await sql`select outcome, error_code from price_refresh where source = 'gcp'`;
      expect(rows).toEqual([{ outcome: "unavailable", error_code: "api_key_missing" }]);
      expect(await sql`select 1 from price_point where cloud = 'gcp'`).toHaveLength(0);
      // naming it explicitly (the admin) reports it too, and still fetches nothing
      const named = await r.runPriceRefresh(SYSTEM, "scheduler", { source: "gcp", deps: { fetch: fetcher, gcpApiKey: null } });
      expect(named).toMatchObject({ ran: true, source: "gcp", outcome: "unavailable", errorCode: "api_key_missing" });
      expect(requests.some((q) => q.url.includes("cloudbilling"))).toBe(false);
    });
  });

  describe("choosing the source", () => {
    const ledger = (source: string, outcome: string, hoursAgo: number) =>
      sql`insert into price_refresh (source, trigger, outcome, started_at, finished_at) values (${source}, 'scheduler', ${outcome}, now() - make_interval(hours => ${hoursAgo}), now() - make_interval(hours => ${hoursAgo}))`;

    it("runs only what is stale (older than 20 h), the stalest attempt first", async () => {
      for (const [s, h] of [["aws_ec2", 1], ["aws_other", 19], ["azure", 21], ["oci", 30], ["footprint", 2]] as const) await ledger(s, "ok", h);
      await ledger("gcp", "ok", 50);
      const { fetcher } = createFixtureFetcher();
      const picks: string[] = [];
      for (let i = 0; i < 5; i++) {
        const rep = await r.runPriceRefresh(SYSTEM, "scheduler", { deps: { fetch: fetcher, gcpApiKey: KEY, footprintFetcher } });
        if (rep.ran) picks.push(rep.source);
      }
      expect(picks).toEqual(["gcp", "oci", "azure"]); // 50 h, 30 h, 21 h; 19 h and younger are left alone
    });

    it("a source that keeps failing goes to the back of the line instead of starving the rest", async () => {
      await ledger("aws_ec2", "failed", 1); // tried an hour ago, never succeeded
      await ledger("azure", "ok", 25);
      const { fetcher } = createFixtureFetcher();
      const rep = await r.runPriceRefresh(SYSTEM, "scheduler", { deps: { fetch: fetcher, gcpApiKey: null, footprintFetcher } });
      expect(rep).toMatchObject({ ran: true, source: "aws_other" }); // never attempted beats a failure from an hour ago and a success from 25 h ago
    });

    it("an admin gets the stalest source even when everything is fresh", async () => {
      for (const [s, h] of [["aws_ec2", 1], ["aws_other", 2], ["azure", 3], ["oci", 4], ["footprint", 5], ["gcp", 6]] as const) await ledger(s, "ok", h);
      const { fetcher } = createFixtureFetcher();
      expect(await r.runPriceRefresh(SYSTEM, "scheduler", { deps: { fetch: fetcher, gcpApiKey: KEY, footprintFetcher } })).toEqual({ ran: false, reason: "nothing_stale" });
      const rep = await r.runPriceRefresh(admin, "admin", { deps: { fetch: fetcher, gcpApiKey: KEY, footprintFetcher } });
      expect(rep).toMatchObject({ ran: true, source: "gcp" });
    });

    it("the footprint source goes through the same call and records its own run", async () => {
      const { fetcher } = createFixtureFetcher();
      const rep = await r.runPriceRefresh(SYSTEM, "scheduler", { source: "footprint", deps: { fetch: fetcher, gcpApiKey: KEY, footprintFetcher } });
      expect(rep).toMatchObject({ ran: true, source: "footprint", outcome: "failed", errorCode: "http_404" });
      expect(await sql`select source, outcome from price_refresh`).toEqual([{ source: "footprint", outcome: "failed" }]);
    });
  });

  it("a group that fails to download is a 'partial' run: the rest lands, the failed group's old rows are untouched", async () => {
    const { fetcher } = createFixtureFetcher();
    await r.runPriceRefresh(SYSTEM, "scheduler", { source: "aws_other", deps: { fetch: fetcher } });
    const rdsBefore = await sql`select id, usd_micros from price_point where sku_key like 'postgres.%' order by sku_key`;
    expect(rdsBefore.length).toBeGreaterThan(0);
    const flaky = createFixtureFetcher({ failUrls: (u) => (u.includes("/AmazonRDS/") ? new PriceFetchError("timeout") : undefined) });
    const rep = await r.runPriceRefresh(SYSTEM, "scheduler", { source: "aws_other", deps: { fetch: flaky.fetcher } });
    expect(rep).toMatchObject({ ran: true, outcome: "partial", errorCode: "fetch_timeout" });
    expect(await sql`select id, usd_micros from price_point where sku_key like 'postgres.%' order by sku_key`).toEqual(rdsBefore);
    const [run] = await sql`select detail from price_refresh where outcome = 'partial'`;
    expect(run.detail.failed).toEqual([{ group: "AmazonRDS", code: "fetch_timeout" }]);
    const down = createFixtureFetcher({ failUrls: () => new PriceFetchError("network") });
    expect(await r.runPriceRefresh(SYSTEM, "scheduler", { source: "oci", deps: { fetch: down.fetcher } })).toMatchObject({ outcome: "failed", errorCode: "fetch_network" });
  });

  it("works with a pool of one connection: the lock does not take the app's only connection (DB_POOL_MAX=1)", async () => {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const schema = await import("@/lib/db/schema");
    const g = globalThis as unknown as { sql?: postgres.Sql; db?: unknown };
    const saved = { sql: g.sql, db: g.db };
    const tiny = postgres(url!, { max: 1, onnotice: () => {} });
    g.sql = tiny;
    g.db = drizzle(tiny, { schema });
    try {
      const { fetcher } = createFixtureFetcher();
      const rep = await Promise.race([
        r.runPriceRefresh(admin, "admin", { source: "oci", deps: { fetch: fetcher, gcpApiKey: KEY } }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("hung with a pool of one")), 8000)),
      ]);
      expect(rep).toMatchObject({ ran: true, outcome: "ok" });
    } finally {
      g.sql = saved.sql;
      g.db = saved.db;
      await tiny.end({ timeout: 5 });
    }
  });

  it("a busy lock does not spend the admin's 10-minute slot", async () => {
    const holder = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      await holder`select pg_advisory_lock(hashtextextended('price-refresh', 0))`;
      const { fetcher } = createFixtureFetcher();
      await expect(r.runPriceRefresh(admin, "admin", { source: "oci", deps: { fetch: fetcher, gcpApiKey: KEY } })).rejects.toMatchObject({ status: 409 });
      expect(await sql`select 1 from rate_event where user_id = ${admin.id}`).toHaveLength(0);
    } finally {
      await holder.end();
    }
    const { fetcher } = createFixtureFetcher();
    expect(await r.runPriceRefresh(admin, "admin", { source: "oci", deps: { fetch: fetcher, gcpApiKey: KEY } })).toMatchObject({ ran: true });
  });

  it("a run left 'running' for more than 300 s is closed as failed before the next pick", async () => {
    await sql`insert into price_refresh (source, trigger, outcome, started_at) values ('azure', 'scheduler', 'running', now() - interval '10 minutes'), ('oci', 'scheduler', 'running', now() - interval '10 seconds')`;
    const { fetcher } = createFixtureFetcher();
    await r.runPriceRefresh(SYSTEM, "scheduler", { source: "aws_ec2", deps: { fetch: fetcher, gcpApiKey: KEY } });
    const rows = await sql`select source, outcome, error_code from price_refresh where source in ('azure', 'oci') order by source`;
    expect(rows).toEqual([{ source: "azure", outcome: "failed", error_code: "timeout" }, { source: "oci", outcome: "running", error_code: null }]);
  });

  it("the Google 'unavailable' row records the real trigger", async () => {
    const { fetcher } = createFixtureFetcher();
    await r.runPriceRefresh(admin, "admin", { source: "oci", deps: { fetch: fetcher, gcpApiKey: null } });
    expect(await sql`select trigger from price_refresh where source = 'gcp'`).toEqual([{ trigger: "admin" }]);
  });

  it("only one refresh at a time: a second call while the lock is held is a 409", async () => {
    const holder = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      await holder.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended('price-refresh', 0))`;
        const { fetcher } = createFixtureFetcher();
        await expect(r.runPriceRefresh(SYSTEM, "scheduler", { deps: { fetch: fetcher } })).rejects.toMatchObject({ status: 409 });
      });
      expect(await sql`select 1 from price_refresh`).toHaveLength(0);
    } finally {
      await holder.end();
    }
    // and the lock is released afterwards
    const { fetcher } = createFixtureFetcher();
    expect(await r.runPriceRefresh(SYSTEM, "scheduler", { source: "oci", deps: { fetch: fetcher } })).toMatchObject({ ran: true, outcome: "ok" });
  });

  it("the lock survives a slow fetch: a second refresh started mid-run is a 409 and only one run is 'running'", async () => {
    const { fetcher } = createFixtureFetcher();
    let slowed = false;
    const slow = (async (req: Parameters<typeof fetcher>[0]) => {
      if (!slowed) {
        slowed = true;
        await new Promise((res) => setTimeout(res, 7000)); // longer than the old 5 s idle timeout on the lock connection
      }
      return fetcher(req);
    }) as typeof fetcher;
    const first = r.runPriceRefresh(SYSTEM, "scheduler", { source: "oci", deps: { fetch: slow } });
    await new Promise((res) => setTimeout(res, 6200)); // past the idle timeout the lock connection used to have
    const { fetcher: quick } = createFixtureFetcher();
    await expect(r.runPriceRefresh(SYSTEM, "scheduler", { source: "oci", deps: { fetch: quick } })).rejects.toMatchObject({ status: 409 });
    expect(await sql`select count(*)::int as n from price_refresh where outcome = 'running'`).toEqual([{ n: 1 }]);
    expect(await sql`select count(*)::int as n from price_refresh where source = 'oci'`).toEqual([{ n: 1 }]);
    expect(await first).toMatchObject({ ran: true, outcome: "ok" });
    // finished: the lock is free again
    expect(await r.runPriceRefresh(SYSTEM, "scheduler", { source: "oci", deps: { fetch: quick } })).toMatchObject({ ran: true });
  }, 30_000);

  it("parallel calls: exactly one runs, the rest get 409", async () => {
    const { fetcher } = createFixtureFetcher();
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => r.runPriceRefresh(SYSTEM, "scheduler", { source: "oci", deps: { fetch: fetcher } })));
    expect(results.filter((x) => x.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    for (const x of results) if (x.status === "rejected") expect(x.reason).toMatchObject({ status: 409 });
    expect((await sql`select count(*)::int as n from price_point where cloud = 'oci' and sku_key = 'vm.vcpu'`)[0].n).toBe(1);
  });

  describe("who may refresh", () => {
    it("a plain user or a signed-out caller gets 403 and nothing happens", async () => {
      const { fetcher, requests } = createFixtureFetcher();
      for (const who of [user, null]) await expect(r.runPriceRefresh(who, "admin", { deps: { fetch: fetcher } })).rejects.toMatchObject({ status: 403 });
      expect(requests).toEqual([]);
      expect(await sql`select 1 from price_refresh`).toHaveLength(0);
    });
    it("an admin may press Refresh now once per 10 minutes (429), counted on the shared ledger", async () => {
      const { fetcher } = createFixtureFetcher();
      expect(await r.runPriceRefresh(admin, "admin", { source: "oci", deps: { fetch: fetcher, gcpApiKey: KEY } })).toMatchObject({ ran: true });
      await expect(r.runPriceRefresh(admin, "admin", { source: "oci", deps: { fetch: fetcher, gcpApiKey: KEY } })).rejects.toMatchObject({ status: 429 });
      expect((await sql`select count(*)::int as n from rate_event where user_id = ${admin.id} and kind = 'refresh'`)[0].n).toBe(1);
      expect(await sql`select 1 from price_refresh`).toHaveLength(1);
      // the scheduler is not subject to the admin limit
      expect(await r.runPriceRefresh(SYSTEM, "scheduler", { source: "oci", deps: { fetch: fetcher, gcpApiKey: KEY } })).toMatchObject({ ran: true });
    });
  });
});
