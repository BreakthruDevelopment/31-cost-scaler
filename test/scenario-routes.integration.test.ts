/**
 * The scenario routes end to end over the route handlers (session mocked, real Postgres): status codes, the
 * origin check, idempotent create, versioned PATCH, 404 for another user's id, 400 for NUL, admin stats 403.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BASE_SPEC } from "@/lib/pricing/spec";

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
const post = (path: string, body: unknown, method = "POST", origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
const get = (path: string) => new Request(`${ORIGIN}${path}`);

describe.skipIf(!url)("scenario routes (Postgres)", () => {
  let sql: postgres.Sql;
  const mk = (id: string, role: "user" | "admin" = "user") => ({ id, role, name: id, email: `${id}@test.local` });
  const A = mk("rt-a");
  const B = mk("rt-b");
  const ADMIN = mk("rt-admin", "admin");
  let list: typeof import("@/app/api/scenarios/route");
  let one: typeof import("@/app/api/scenarios/[id]/route");
  let stats: typeof import("@/app/api/admin/stats/route");
  let footprint: typeof import("@/app/api/footprint/route");

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = ORIGIN;
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id like 'rt-%'`;
    for (const u of [A, B, ADMIN]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.email}, ${u.role})`;
    list = await import("@/app/api/scenarios/route");
    one = await import("@/app/api/scenarios/[id]/route");
    stats = await import("@/app/api/admin/stats/route");
    footprint = await import("@/app/api/footprint/route");
  });
  afterAll(async () => {
    await sql`delete from "user" where id like 'rt-%'`;
    await sql.end();
  });

  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  type Body = { scenario: { id: string; name: string; version: number }; scenarios: { id: string }[]; apps: { name: string }[]; result: unknown; [key: string]: unknown };
  const json = async (res: Response) => (await res.json()) as Body;

  it("signed out: 401 on every scenario route", async () => {
    current = null;
    expect((await list.GET()).status).toBe(401);
    expect((await list.POST(post("/api/scenarios", { name: "x", spec: BASE_SPEC }))).status).toBe(401);
    expect((await one.GET(get("/api/scenarios/x"), ctx(crypto.randomUUID()))).status).toBe(401);
  });

  it("create is 201, a replay of the same clientOpId is 200 with the same row; PATCH needs the version; DELETE is 204", async () => {
    current = A;
    const clientOpId = crypto.randomUUID();
    const body = { name: "route scenario", spec: BASE_SPEC, clientOpId };
    const first = await list.POST(post("/api/scenarios", body));
    const again = await list.POST(post("/api/scenarios", body));
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    const created = (await json(first)).scenario;
    expect((await json(again)).scenario.id).toBe(created.id);
    expect((await json(await list.GET())).scenarios.filter((s: { id: string }) => s.id === created.id)).toHaveLength(1);

    const got = await json(await one.GET(get(`/api/scenarios/${created.id}`), ctx(created.id)));
    expect(got).toMatchObject({ scenario: { id: created.id, version: 1 }, result: null });

    const ok = await one.PATCH(post(`/api/scenarios/${created.id}`, { version: 1, name: "renamed" }, "PATCH"), ctx(created.id));
    expect(ok.status).toBe(200);
    expect((await json(ok)).scenario).toMatchObject({ name: "renamed", version: 2 });
    const stale = await one.PATCH(post(`/api/scenarios/${created.id}`, { version: 1, name: "late" }, "PATCH"), ctx(created.id));
    expect(stale.status).toBe(409);
    expect((await one.PATCH(post(`/api/scenarios/${created.id}`, { name: "no version" }, "PATCH"), ctx(created.id))).status).toBe(400);

    const del = await one.DELETE(post(`/api/scenarios/${created.id}`, {}, "DELETE"), ctx(created.id));
    expect(del.status).toBe(204);
    expect((await one.GET(get(`/api/scenarios/${created.id}`), ctx(created.id))).status).toBe(404);
  });

  it("another user and an admin get 404 on GET, PATCH and DELETE of A's scenario, with no hint it exists", async () => {
    current = A;
    const created = (await json(await list.POST(post("/api/scenarios", { name: "CANARY-NAME", spec: BASE_SPEC })))).scenario;
    const stranger404 = [] as string[];
    for (const who of [B, ADMIN]) {
      current = who;
      for (const res of [
        await one.GET(get(`/api/scenarios/${created.id}`), ctx(created.id)),
        await one.PATCH(post(`/api/scenarios/${created.id}`, { version: 1, name: "hijack" }, "PATCH"), ctx(created.id)),
        await one.DELETE(post(`/api/scenarios/${created.id}`, {}, "DELETE"), ctx(created.id)),
        await one.GET(get("/api/scenarios/not-a-uuid"), ctx("not-a-uuid")),
      ]) {
        expect(res.status).toBe(404);
        stranger404.push(await res.text());
      }
      expect(JSON.stringify((await json(await list.GET())).scenarios)).not.toContain("CANARY-NAME");
    }
    expect(new Set(stranger404)).toEqual(new Set(['{"error":"Not found"}']));
    current = A;
    expect((await json(await one.GET(get(`/api/scenarios/${created.id}`), ctx(created.id)))).scenario.name).toBe("CANARY-NAME");
  });

  it("a NUL byte is 400 (name, and anywhere in the spec), not 500", async () => {
    current = A;
    expect((await list.POST(post("/api/scenarios", { name: "a\u0000b", spec: BASE_SPEC }))).status).toBe(400);
    expect((await list.POST(post("/api/scenarios", { name: "ok", spec: { ...BASE_SPEC, baseApp: "a\u0000b" } }))).status).toBe(400);
    const raw = new Request(`${ORIGIN}/api/scenarios`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: '{"name":"x\\u0000y","spec":{}}' });
    expect((await list.POST(raw)).status).toBe(400);
  });

  it("malformed, oversized, cross-origin and missing-origin writes are refused", async () => {
    current = A;
    const bad = new Request(`${ORIGIN}/api/scenarios`, { method: "POST", headers: { origin: ORIGIN }, body: "{nope" });
    expect((await list.POST(bad)).status).toBe(400);
    const big = new Request(`${ORIGIN}/api/scenarios`, { method: "POST", headers: { origin: ORIGIN }, body: "x".repeat(40_000) });
    expect((await list.POST(big)).status).toBe(413);
    expect((await list.POST(post("/api/scenarios", { name: "x", spec: BASE_SPEC }, "POST", "https://evil.example"))).status).toBe(403);
    expect((await list.POST(post("/api/scenarios", { name: "x", spec: BASE_SPEC }, "POST", null))).status).toBe(403);
    const created = (await json(await list.POST(post("/api/scenarios", { name: "origin", spec: BASE_SPEC })))).scenario;
    expect((await one.DELETE(post(`/api/scenarios/${created.id}`, {}, "DELETE", "https://evil.example"), ctx(created.id))).status).toBe(403);
  });

  it("an out-of-range spec is 400 with the failing path, never stored", async () => {
    current = A;
    const res = await list.POST(post("/api/scenarios", { name: "range", spec: { ...BASE_SPEC, users: { mau: 11_000_000, requestsPerUser: 1 } } }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await json(res))).toContain("mau");
  });

  it("GET /api/admin/stats: 401 signed out, 403 for a user, counts for an admin", async () => {
    current = null;
    expect((await stats.GET()).status).toBe(401);
    current = A;
    expect((await stats.GET()).status).toBe(403);
    current = ADMIN;
    const res = await stats.GET();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.scenarios as unknown as number).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("CANARY-NAME");
  });

  it("GET /api/footprint is public and rate limited per IP", async () => {
    current = null;
    const { resetPublicLimiter } = await import("@/lib/ip-limit");
    resetPublicLimiter();
    await sql`delete from footprint_app`;
    await sql`insert into footprint_app (name, title, clouds, ai, source_commit) values ('rt-app', 'RT', ${["aws"]}, 'demo', 'abc')`;
    const res = await footprint.GET(new Request(`${ORIGIN}/api/footprint`, { headers: { "x-forwarded-for": "203.0.113.9" } }));
    expect(res.status).toBe(200);
    expect((await json(res)).apps.map((a: { name: string }) => a.name)).toEqual(["rt-app"]);
    let last = 200;
    for (let i = 0; i < 70; i++) last = (await footprint.GET(new Request(`${ORIGIN}/api/footprint`, { headers: { "x-forwarded-for": "203.0.113.9" } }))).status;
    expect(last).toBe(429);
    await sql`delete from footprint_app`;
    resetPublicLimiter();
  });
});
