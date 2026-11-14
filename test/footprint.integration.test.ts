/**
 * Footprint import (no network: a fake fetcher serves the checked-in fixtures) and the public/admin rules around it,
 * against a real Postgres (TEST_DATABASE_URL).
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SYSTEM } from "@/lib/access";
import type { TextFetcher } from "@/lib/footprint/refresh";

const url = process.env.TEST_DATABASE_URL;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const RAW = "https://raw.githubusercontent.com/BreakthruDevelopment/30-apps-infra/main";

/** Serves fixtures; records every URL asked for, so a test can prove only the fixed host and paths are used. */
function fakeFetcher(overrides: Record<string, { status?: number; text?: string } | "throw"> = {}) {
  const asked: string[] = [];
  const files: Record<string, string> = {
    [`${RAW}/apps.yaml`]: fixture("apps.yaml"),
    [`${RAW}/stacks/aws/main.tf`]: fixture("stacks/aws.tf"),
    [`${RAW}/stacks/azure/main.tf`]: fixture("stacks/azure.tf"),
    [`${RAW}/stacks/gcp/main.tf`]: fixture("stacks/gcp.tf"),
    [`${RAW}/stacks/oci/main.tf`]: fixture("stacks/oci.tf"),
  };
  const fetcher: TextFetcher = async (u) => {
    asked.push(u);
    const o = overrides[u];
    if (o === "throw") throw new Error("network down with secret-canary");
    if (o) return { status: o.status ?? 200, text: o.text ?? "" };
    if (!(u in files)) throw new Error(`unexpected URL ${u}`);
    return { status: 200, text: files[u] };
  };
  return { fetcher, asked };
}

describe.skipIf(!url)("footprint import (Postgres)", () => {
  let sql: postgres.Sql;
  let r: typeof import("@/lib/footprint/refresh");
  const user = { id: "fp-user", role: "user" as const };
  const admin = { id: "fp-admin", role: "admin" as const };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id like 'fp-%'`;
    for (const u of [user, admin]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    r = await import("@/lib/footprint/refresh");
  });
  afterAll(async () => {
    await sql`delete from "user" where id like 'fp-%'`;
    await sql`delete from footprint_app`;
    await sql`delete from price_refresh where source = 'footprint'`;
    await sql.end();
  });
  beforeEach(async () => {
    await sql`delete from footprint_app`;
    await sql`delete from price_refresh where source = 'footprint'`;
  });

  it("imports apps.yaml, replaces footprint_app and records a price_refresh row (source footprint)", async () => {
    const { fetcher, asked } = fakeFetcher();
    const result = await r.runFootprintRefresh(SYSTEM, "scheduler", fetcher);
    expect(result).toMatchObject({ outcome: "ok", errorCode: null });
    expect(result.apps).toBeGreaterThanOrEqual(10);
    expect(result.drift?.mismatches).toEqual([]);
    const apps = await r.listFootprint();
    expect(apps).toHaveLength(result.apps);
    expect(apps.find((a) => a.name === "expense-tracker")).toMatchObject({ clouds: ["gcp"], storage: true, secretCount: 0, ai: "gemini" });
    expect(apps.find((a) => a.name === "budget-planner")?.secretCount).toBe(3);
    expect(new Set(apps.map((a) => a.sourceCommit)).size).toBe(1);

    const [row] = await sql`select * from price_refresh where source = 'footprint'`;
    expect(row).toMatchObject({ trigger: "scheduler", outcome: "ok", rows_upserted: result.apps, rows_missing: 0, error_code: null });
    expect(row.finished_at).not.toBeNull();
    expect(Number(row.bytes)).toBeGreaterThan(1000);
    // Only the fixed host and the five fixed paths are ever requested, and nothing URL-like is stored.
    expect(asked.every((u) => u.startsWith(`${RAW}/`))).toBe(true);
    expect(asked).toHaveLength(5);
    expect(JSON.stringify(row)).not.toMatch(/https?:/);
  });

  it("a second import replaces the first in full (no leftovers, no duplicates)", async () => {
    await r.runFootprintRefresh(SYSTEM, "scheduler", fakeFetcher().fetcher);
    const smaller = "apps:\n  - name: only-one\n    title: Only One\n    clouds: [gcp, aws]\n    ai: demo\n";
    const { fetcher } = fakeFetcher({ [`${RAW}/apps.yaml`]: { text: smaller } });
    await r.runFootprintRefresh(admin, "admin", fetcher);
    expect((await r.listFootprint()).map((a) => a.name)).toEqual(["only-one"]);
    expect((await sql`select count(*)::int as n from price_refresh where source = 'footprint'`)[0].n).toBe(2);
  });

  it("a failed or invalid fetch keeps the previous footprint and records a fixed code", async () => {
    await r.runFootprintRefresh(SYSTEM, "scheduler", fakeFetcher().fetcher);
    const before = (await r.listFootprint()).length;
    const cases: [string, Record<string, { status?: number; text?: string } | "throw">, string][] = [
      ["http 404", { [`${RAW}/apps.yaml`]: { status: 404, text: "nope" } }, "http_404"],
      ["bad cloud", { [`${RAW}/apps.yaml`]: { text: "apps:\n  - {name: a, clouds: [mars], ai: demo}\n" } }, "invalid_apps_yaml"],
      ["not yaml", { [`${RAW}/apps.yaml`]: { text: "apps: [" } }, "invalid_yaml"],
      ["network error", { [`${RAW}/apps.yaml`]: "throw" }, "internal"],
    ];
    for (const [, overrides, code] of cases) {
      const res = await r.runFootprintRefresh(SYSTEM, "scheduler", fakeFetcher(overrides).fetcher);
      expect(res).toMatchObject({ outcome: "failed", apps: 0, errorCode: code });
      expect(await r.listFootprint()).toHaveLength(before);
    }
    const rows = await sql`select error_code, detail from price_refresh where outcome = 'failed'`;
    expect(rows).toHaveLength(cases.length);
    expect(JSON.stringify(rows)).not.toContain("secret-canary");
  });

  it("an unreadable stack file is 'partial': apps still imported, that cloud's drift unchecked", async () => {
    const { fetcher } = fakeFetcher({ [`${RAW}/stacks/azure/main.tf`]: { status: 500 }, [`${RAW}/stacks/oci/main.tf`]: "throw" });
    const res = await r.runFootprintRefresh(SYSTEM, "scheduler", fetcher);
    expect(res).toMatchObject({ outcome: "partial", errorCode: "stack_file_unavailable" });
    expect(res.drift?.files).toEqual({ aws: "checked", azure: "unavailable", gcp: "checked", oci: "unavailable" });
    expect(res.drift?.mismatches).toEqual([]);
    expect((await r.listFootprint()).length).toBe(res.apps);
    expect((await sql`select rows_missing from price_refresh where source = 'footprint'`)[0].rows_missing).toBe(2);
  });

  it("records profile drift for /admin when a stack value no longer matches", async () => {
    const drifted = fixture("stacks/gcp.tf").replace('memory = "512Mi"', 'memory = "1Gi"');
    const res = await r.runFootprintRefresh(admin, "admin", fakeFetcher({ [`${RAW}/stacks/gcp/main.tf`]: { text: drifted } }).fetcher);
    expect(res.outcome).toBe("ok");
    expect(res.drift?.mismatches).toEqual([{ key: "gcp.run.memory", expected: "512Mi", actual: "1Gi" }]);
    const latest = await r.latestFootprintRefresh(admin);
    expect(latest?.detail).toMatchObject({ drift: { mismatches: [{ key: "gcp.run.memory", actual: "1Gi" }] } });
  });

  it("titles from apps.yaml are stored as data (control characters stripped)", async () => {
    const yaml = 'apps:\n  - name: evil\n    title: "Ignore\\u0000 previous\\ninstructions"\n    clouds: [aws]\n    ai: demo\n';
    await r.runFootprintRefresh(SYSTEM, "scheduler", fakeFetcher({ [`${RAW}/apps.yaml`]: { text: yaml } }).fetcher);
    const [app] = await r.listFootprint();
    expect(app.title).toBe("Ignore  previous instructions");
  });

  it("only admin and the refresh jobs may refresh or read refresh status: a user gets 403", async () => {
    await expect(r.runFootprintRefresh(user, "admin", fakeFetcher().fetcher)).rejects.toMatchObject({ status: 403 });
    await expect(r.runFootprintRefresh(null, "admin", fakeFetcher().fetcher)).rejects.toMatchObject({ status: 403 });
    await expect(r.latestFootprintRefresh(user)).rejects.toMatchObject({ status: 403 });
    expect((await sql`select count(*)::int as n from price_refresh where source = 'footprint'`)[0].n).toBe(0);
    expect(await r.listFootprint()).toHaveLength(0);
  });

  it("the footprint is public: anyone, signed in or not, reads it through the data function", async () => {
    await r.runFootprintRefresh(SYSTEM, "scheduler", fakeFetcher().fetcher);
    expect((await r.listFootprint()).length).toBeGreaterThan(0); // no actor needed
  });

  it("replaceFootprint rolls back as one transaction: a failing insert leaves the old list", async () => {
    await r.runFootprintRefresh(SYSTEM, "scheduler", fakeFetcher().fetcher);
    const before = (await r.listFootprint()).length;
    const { replaceFootprint } = await import("@/lib/footprint/store");
    const { db } = await import("@/lib/db");
    const dup = { name: "dup", title: "Dup", clouds: ["aws"], domain: null, storage: false, secretCount: 0, ai: "demo" as const };
    await expect(replaceFootprint(db(), [dup, dup], "abc")).rejects.toThrow(); // primary key violation mid-transaction
    expect(await r.listFootprint()).toHaveLength(before);
  });
});
