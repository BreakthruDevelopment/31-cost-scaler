/** The demo seed: one marked demo user and 3 scenarios, repeatable, and it never replaces an unrelated account. */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scenarioSpec } from "@/lib/pricing/spec";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("demo workspace (Postgres)", () => {
  let sql: postgres.Sql;
  let w: typeof import("@/lib/demo-workspace");

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    Object.assign(process.env, { DEMO_SEED: "yes", APP_URL: "http://localhost:3000", DEMO_PASSWORD: "demo-password-123" });
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    w = await import("@/lib/demo-workspace");
    await sql`delete from "user" where email = ${w.DEMO_EMAIL}`;
  });
  afterAll(async () => {
    await sql`delete from "user" where email = ${w.DEMO_EMAIL}`;
    await sql.end();
  });

  it("every demo scenario is a valid spec", () => {
    expect(w.DEMO_SCENARIOS).toHaveLength(3);
    for (const s of w.DEMO_SCENARIOS) expect(scenarioSpec.safeParse(s.spec).success).toBe(true);
  });

  it("loads 3 scenarios for one marked demo user, and a reload replaces rather than duplicates", async () => {
    expect(await w.loadDemoWorkspace()).toEqual({ users: 1, scenarios: 3 });
    expect(await w.loadDemoWorkspace()).toEqual({ users: 1, scenarios: 3 });
    const users = await sql`select id, image from "user" where email = ${w.DEMO_EMAIL}`;
    expect(users).toHaveLength(1);
    expect(users[0].image).toBe("urn:breakthru:cost-scaler-demo:v1");
    const rows = await sql`select name, base_app from scenario where owner_id = ${users[0].id} order by name`;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.base_app === "helpdesk")).toBe(true);
  });

  it("refuses to adopt an unrelated account that holds the demo email", async () => {
    await sql`delete from "user" where email = ${w.DEMO_EMAIL}`;
    await sql`insert into "user" (id, name, email) values ('dw-real', 'Real', ${w.DEMO_EMAIL})`;
    await expect(w.loadDemoWorkspace()).rejects.toMatchObject({ status: 409 });
    expect((await sql`select count(*)::int as n from scenario where owner_id = 'dw-real'`)[0].n).toBe(0);
    await sql`delete from "user" where id = 'dw-real'`;
  });
});
