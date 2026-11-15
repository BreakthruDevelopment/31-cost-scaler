/**
 * POST /api/price and GET /api/move over the route handlers (session mocked, real Postgres, synthetic price rows and
 * footprint apps that the file inserts and removes). Covers the access rules: price needs a signed-in user (admin
 * included); move is public at the 10x preset, and with `scenario` only its owner may ask (everyone else, admin
 * included, gets the same 404 as a missing id).
 * Writes price_point rows, so run it against the scratch TEST_DATABASE_URL only.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fixturePriceRows, fixtureRowsWithIds } from "./fixtures/pricing-table";
import { priceScenario } from "@/lib/pricing/scenario";
import { BASE_SPEC } from "@/lib/pricing/spec";
import { buildPriceTable } from "@/lib/pricing/table";
import { CLOUD_ORDER } from "@/lib/pricing/types";

const url = process.env.TEST_DATABASE_URL;

let current: { id: string; role: "user" | "admin"; name: string; email: string } | null = null;
vi.mock("@/lib/auth/session", async () => {
  const { ForbiddenError, UnauthorizedError } = await import("@/lib/auth/rbac");
  const requireUser = async () => {
    if (!current) throw new UnauthorizedError();
    return current;
  };
  return {
    requireUser,
    requireRole: async (role: string) => {
      const u = await requireUser();
      if (role === "admin" && u.role !== "admin") throw new ForbiddenError();
      return u;
    },
  };
});

const ORIGIN = "http://localhost:3000";
const REGION = { aws: "us-east-2", azure: "eastus", gcp: "us-central1", oci: "global" } as const;
const post = (path: string, body: unknown, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
const getMove = (qs: string, ip = "203.0.113.7") => new Request(`${ORIGIN}/api/move?${qs}`, { headers: { "x-forwarded-for": ip } });

describe.skipIf(!url)("pricing routes (Postgres)", () => {
  let sql: postgres.Sql;
  const mk = (id: string, role: "user" | "admin" = "user") => ({ id, role, name: id, email: `${id}@test.local` });
  const A = mk("pr-a");
  const B = mk("pr-b");
  const C = mk("pr-c");
  const ADMIN = mk("pr-admin", "admin");
  let price: typeof import("@/app/api/price/route");
  let move: typeof import("@/app/api/move/route");
  let scenarios: typeof import("@/app/api/scenarios/route");
  let sid: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = ORIGIN;
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id like 'pr-%'`;
    for (const u of [A, B, C, ADMIN]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.email}, ${u.role})`;
    await sql`delete from price_point where sku_key not like 'pa.%'`;
    for (const r of fixturePriceRows()) {
      await sql`insert into price_point (cloud, component, sku_key, region, unit, usd_micros, tier_start, source_url, fetched_at)
        values (${r.cloud}, ${r.component}, ${r.skuKey}, ${REGION[r.cloud]}, ${r.unit}, ${r.usdMicros}, ${r.tierStart}, ${r.sourceUrl}, ${r.fetchedAt})`;
    }
    await sql`delete from footprint_app where name like 'pr-%'`;
    await sql`insert into footprint_app (name, title, clouds, domain, storage, secret_count, ai, source_commit) values
      ('pr-plain', 'Plain', '{aws}', null, false, 0, 'demo', 'test'),
      ('pr-files', 'Files', '{aws}', null, true, 2, 'demo', 'test'),
      ('pr-everywhere', 'Everywhere', '{aws,azure,gcp,oci}', null, false, 0, 'demo', 'test')`;
    price = await import("@/app/api/price/route");
    move = await import("@/app/api/move/route");
    scenarios = await import("@/app/api/scenarios/route");
    current = A;
    const made = await scenarios.POST(post("/api/scenarios", { name: "CANARY-SCENARIO", spec: BASE_SPEC }));
    sid = ((await made.json()) as { scenario: { id: string } }).scenario.id;
  });
  afterAll(async () => {
    await sql`delete from price_point where source_url like 'https://example.test/fixture/%'`;
    await sql`delete from footprint_app where name like 'pr-%'`;
    await sql`delete from "user" where id like 'pr-%'`;
    await sql.end();
  });

  type Priced = { result: { cheapest: string | null; cheapestIsComplete: boolean; clouds: Record<string, { totalMicros: number; netMicros: number; lines: { id: string; status: string; priceIds: string[] }[] }> } };
  type Moved = { result: { verdict: string; basis: string; from: string; to: string; blockers: { code: string }[]; effort: { micros: number } } };
  const priceBody = async (res: Response) => (await res.json()) as Priced;

  describe("POST /api/price", () => {
    it("signed out is 401; a signed-in user and an admin get four totals and a cheapest cloud", async () => {
      current = null;
      expect((await price.POST(post("/api/price", { spec: BASE_SPEC }))).status).toBe(401);
      for (const who of [A, ADMIN]) {
        current = who;
        const res = await price.POST(post("/api/price", { spec: BASE_SPEC }));
        expect(res.status).toBe(200);
        const { result } = await priceBody(res);
        expect(Object.keys(result.clouds)).toEqual([...CLOUD_ORDER]);
        expect(result.cheapest).not.toBeNull();
        // the route reads the same numbers the pure engine computes from the same rows
        const local = priceScenario(BASE_SPEC, buildPriceTable(fixtureRowsWithIds()));
        for (const c of CLOUD_ORDER) {
          expect(result.clouds[c].totalMicros).toBe(local.clouds[c].totalMicros);
          expect(result.clouds[c].netMicros).toBe(local.clouds[c].netMicros);
        }
        expect(result.cheapest).toBe(local.cheapest);
        const priced = result.clouds.gcp.lines.filter((l) => l.status === "priced");
        expect(priced.every((l) => l.priceIds.length > 0)).toBe(true);
      }
    });

    it("refuses cross-origin, missing-origin, malformed, oversized, unknown-key, out-of-range and NUL bodies without a 500", async () => {
      current = A;
      expect((await price.POST(post("/api/price", { spec: BASE_SPEC }, "https://evil.example"))).status).toBe(403);
      expect((await price.POST(post("/api/price", { spec: BASE_SPEC }, null))).status).toBe(403);
      expect((await price.POST(new Request(`${ORIGIN}/api/price`, { method: "POST", headers: { origin: ORIGIN }, body: "{nope" }))).status).toBe(400);
      expect((await price.POST(new Request(`${ORIGIN}/api/price`, { method: "POST", headers: { origin: ORIGIN }, body: "x".repeat(40_000) }))).status).toBe(413);
      expect((await price.POST(post("/api/price", { spec: BASE_SPEC, extra: 1 }))).status).toBe(400);
      expect((await price.POST(post("/api/price", { spec: { ...BASE_SPEC, users: { mau: 99_999_999, requestsPerUser: 1 } } }))).status).toBe(400);
      expect((await price.POST(post("/api/price", { spec: { ...BASE_SPEC, baseApp: "a\u0000b" } }))).status).toBe(400);
      const raw = new Request(`${ORIGIN}/api/price`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: '{"spec":{"baseApp":"x\\u0000y"}}' });
      expect((await price.POST(raw)).status).toBe(400);
    });

    it("reads active prices only: a quarantined row is 'not listed', never zero", async () => {
      current = A;
      await sql`update price_point set status = 'quarantined' where cloud = 'gcp' and sku_key = 'object_storage.gb'`;
      try {
        const { result } = await priceBody(await price.POST(post("/api/price", { spec: BASE_SPEC })));
        const l = result.clouds.gcp.lines.find((x) => x.id === "object_storage")!;
        expect(l.status).toBe("not_listed");
        expect(l.priceIds).toEqual([]);
      } finally {
        await sql`update price_point set status = 'active' where cloud = 'gcp' and sku_key = 'object_storage.gb'`;
      }
    });

    it("reads only each cloud's reference region: a stray row from another region is never priced", async () => {
      current = A;
      await sql`insert into price_point (cloud, component, sku_key, region, unit, usd_micros, tier_start, source_url, fetched_at)
        values ('gcp', 'object_storage', 'object_storage.gb', 'europe-west1', 'gb_month', 1, 0, 'https://example.test/fixture/stray', now())`;
      try {
        const { result } = await priceBody(await price.POST(post("/api/price", { spec: BASE_SPEC })));
        const l = result.clouds.gcp.lines.find((x) => x.id === "object_storage")!;
        expect(l.status).toBe("priced");
        expect(l.priceIds).toHaveLength(1);
        expect(l.priceIds[0]).not.toBe("");
        const [stray] = await sql`select id from price_point where region = 'europe-west1' and cloud = 'gcp'`;
        expect(l.priceIds).not.toContain(stray.id);
      } finally {
        await sql`delete from price_point where region = 'europe-west1' and cloud = 'gcp'`;
      }
    });

    it("allows 120 pricing runs per user per hour, then 429; another user is unaffected", async () => {
      current = C;
      await sql`insert into rate_event (user_id, kind) select ${C.id}, 'price_run' from generate_series(1, 120)`;
      expect((await price.POST(post("/api/price", { spec: BASE_SPEC }))).status).toBe(429);
      current = B;
      expect((await price.POST(post("/api/price", { spec: BASE_SPEC }))).status).toBe(200);
    });
  });

  describe("GET /api/move", () => {
    it("is public and prices the 10x preset", async () => {
      current = null;
      const res = await move.GET(getMove("app=pr-plain&to=gcp"));
      expect(res.status).toBe(200);
      const { result } = (await res.json()) as Moved;
      expect(result).toMatchObject({ basis: "scenario", from: "aws", to: "gcp" });
      expect(["move", "consider", "stay", "not_enough_data"]).toContain(result.verdict);
      const rated = (await (await move.GET(getMove("app=pr-plain&to=gcp&rate=200"))).json()) as Moved;
      expect(rated.result.effort.micros).toBe(result.effort.micros * 2);
    });

    it("blocks storage apps off Google Cloud and returns the reason", async () => {
      current = null;
      const { result } = (await (await move.GET(getMove("app=pr-files&to=azure"))).json()) as Moved;
      expect(result.verdict).toBe("blocked");
      expect(result.blockers.map((b) => b.code)).toEqual(["object_storage_gcp_only"]);
    });

    it("validates its query: unknown app 404; bad cloud, same cloud, unknown parameter, NUL, bad rate 400", async () => {
      current = null;
      expect((await move.GET(getMove("app=nope&to=gcp"))).status).toBe(404);
      expect((await move.GET(getMove("app=pr-plain&to=mars"))).status).toBe(400);
      expect((await move.GET(getMove("app=pr-plain&to=aws"))).status).toBe(400);
      expect((await move.GET(getMove("app=pr-everywhere&to=gcp"))).status).toBe(400);
      expect((await move.GET(getMove("app=pr-plain&to=gcp&from=azure"))).status).toBe(400);
      expect((await move.GET(getMove("app=pr-plain&to=gcp&x=1"))).status).toBe(400);
      expect((await move.GET(getMove("app=pr-plain&to=gcp&rate=-5"))).status).toBe(400);
      expect((await move.GET(getMove("app=pr-plain&to=gcp&rate=abc"))).status).toBe(400);
      expect((await move.GET(getMove("app=pr%00x&to=gcp"))).status).toBe(400);
    });

    it("with a scenario: signed out 401; the owner gets the scenario basis; another user, an admin and bad ids all get the same 404", async () => {
      current = null;
      expect((await move.GET(getMove(`app=pr-plain&to=gcp&scenario=${sid}`))).status).toBe(401);
      current = A;
      const mine = await move.GET(getMove(`app=pr-plain&to=gcp&scenario=${sid}`));
      expect(mine.status).toBe(200);
      expect(((await mine.json()) as Moved).result.basis).toBe("scenario");
      const bodies = new Set<string>();
      for (const who of [B, ADMIN]) {
        current = who;
        for (const id of [sid, crypto.randomUUID(), "not-a-uuid"]) {
          const res = await move.GET(getMove(`app=pr-plain&to=gcp&scenario=${id}`));
          expect(res.status).toBe(404);
          bodies.add(await res.text());
        }
      }
      expect(bodies).toEqual(new Set(['{"error":"Not found"}']));
    });

    it("limits public requests to 60 a minute per IP", async () => {
      current = null;
      const ip = "198.51.100.99";
      let last = 200;
      for (let i = 0; i < 61; i++) last = (await move.GET(getMove("app=pr-plain&to=gcp", ip))).status;
      expect(last).toBe(429);
    });
  });
});
