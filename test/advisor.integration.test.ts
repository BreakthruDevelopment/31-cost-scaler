/**
 * The scaling advisor against Postgres: access (another user's scenario is a 404, even as a tool argument), stored
 * answers owner-only, the per-user and daily limits and their refunds, and the routes. No real model: demo mode (a
 * scripted run of the real tools) and a stub ADK model. Writes price_point and footprint_app rows, so run it against the
 * scratch TEST_DATABASE_URL only.
 */
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { fixturePriceRows } from "./fixtures/pricing-table";
import { FailingLlm, ScriptedLlm } from "./ai-stub-llm";
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
const REGION = { aws: "us-east-2", azure: "eastus", gcp: "us-central1", oci: "global" } as const;
const post = (body: unknown, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}/api/advice`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });

function setEnv(extra: Record<string, string> = {}) {
  vi.stubEnv("AI_PROVIDER", "demo");
  vi.stubEnv("AI_FALLBACK_TO_DEMO", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("LOG_LEVEL", "error");
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
  resetEnvCache();
}

describe.skipIf(!url)("scaling advisor (Postgres)", () => {
  let sql: postgres.Sql;
  const mk = (id: string, role: "user" | "admin" = "user") => ({ id, role, name: id, email: `${id}@test.local` });
  const A = mk("ad4-a");
  const B = mk("ad4-b");
  const R = mk("ad4-rate");
  const ADMIN = mk("ad4-admin", "admin");
  const CANARY_MAU = 3_141_592;
  let route: typeof import("@/app/api/advice/route");
  let store: typeof import("@/lib/advice-store");
  let tools: typeof import("@/lib/advice-tools");
  let advisor: typeof import("@/lib/advisor");
  let agent: typeof import("@/lib/ai/agent");
  let checks: typeof import("@/lib/advice-checks");
  let sidA: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = ORIGIN;
    setEnv();
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id like 'ad4-%'`;
    for (const u of [A, B, R, ADMIN]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.email}, ${u.role})`;
    await sql`delete from price_point where sku_key not like 'pa.%'`;
    for (const r of fixturePriceRows()) {
      await sql`insert into price_point (cloud, component, sku_key, region, unit, usd_micros, tier_start, source_url, fetched_at)
        values (${r.cloud}, ${r.component}, ${r.skuKey}, ${REGION[r.cloud]}, ${r.unit}, ${r.usdMicros}, ${r.tierStart}, ${r.sourceUrl}, ${r.fetchedAt})`;
    }
    await sql`delete from footprint_app where name like 'ad4-%'`;
    await sql`insert into footprint_app (name, title, clouds, domain, storage, secret_count, ai, source_commit) values
      ('ad4-plain', 'Plain', '{aws}', null, false, 0, 'demo', 'test'),
      ('ad4-files', 'Files', '{aws}', null, true, 2, 'demo', 'test')`;
    const spec = { ...BASE_SPEC, users: { ...BASE_SPEC.users, mau: CANARY_MAU } };
    [{ id: sidA }] = await sql`insert into scenario (owner_id, name, spec) values (${A.id}, 'CANARY-SCENARIO-NAME', ${sql.json(spec)}) returning id`;
    route = await import("@/app/api/advice/route");
    advisor = await import("@/lib/advisor");
    store = await import("@/lib/advice-store");
    tools = await import("@/lib/advice-tools");
    agent = await import("@/lib/ai/agent");
    checks = await import("@/lib/advice-checks");
  });
  afterAll(async () => {
    await sql`delete from price_point where source_url like 'https://example.test/fixture/%'`;
    await sql`delete from footprint_app where name like 'ad4-%'`;
    await sql`delete from "user" where id like 'ad4-%'`;
    await sql`delete from daily_usage where kind = 'ai'`;
    await sql.end();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetEnvCache();
    setEnv();
  });

  type Row = { id: string; ownerId: string; demo: boolean; provider: string; question: string; output: import("@/lib/advice-checks").AdviceOutput; trace: { id: string; name: string; args: Record<string, unknown>; error: string | null }[]; checks: { droppedFigures: unknown[]; engine: string; fallbackReason: string | null; fixedAnswer: boolean } };
  const ask = async (who: typeof A, body: unknown) => {
    current = who;
    return route.POST(post(body));
  };

  describe("demo mode answers from the real tools and stores the row for its owner", () => {
    it("passes its own checks: three traced figures at least, none dropped", async () => {
      const res = await ask(A, { question: "Should ad4-plain move?", app: "ad4-plain" });
      expect(res.status).toBe(201);
      const { advice } = (await res.json()) as { advice: Row };
      expect(advice).toMatchObject({ ownerId: A.id, demo: true, provider: "demo", question: "Should ad4-plain move?" });
      expect(advice.trace.map((c) => c.name)).toEqual(["getFootprint", "priceScenario", "migrationBreakEven"]);
      expect(advice.checks).toMatchObject({ droppedFigures: [], engine: "demo", fixedAnswer: false });
      expect(advice.output.figures.length).toBeGreaterThanOrEqual(3);
      expect(advice.output.headline).toBe("Recorded demo answer: ad4-plain at ten times the users");
      // every shown number is the tool's own
      for (const f of advice.output.figures) {
        const call = advice.trace.find((c) => c.id === f.call) as unknown as { result: unknown };
        expect(checks.resolvePointer(call.result, f.path)).toBeCloseTo(f.valueUsd, 2);
      }
    });

    it("uses the user's own scenario when they choose one", async () => {
      const res = await ask(A, { question: "And on my scenario?", app: "ad4-plain", scenarioId: sidA });
      const { advice } = (await res.json()) as { advice: Row };
      expect(advice.trace[1].args).toEqual({ scenarioId: sidA });
      expect(advice.trace[2].args).toMatchObject({ scenarioId: sidA });
      expect(advice.output.headline).toBe("Recorded demo answer: ad4-plain on your scenario");
      expect(advice.checks.droppedFigures).toEqual([]);
    });

    it("an app on object storage is blocked by code, with the blocker as a caveat", async () => {
      const res = await ask(A, { question: "Move ad4-files to Azure?", app: "ad4-files" });
      const { advice } = (await res.json()) as { advice: Row };
      // the demo asks about the cheapest cloud the app is not on; object storage runs only on Google Cloud, so a move is blocked
      expect(["blocked"]).toContain(advice.output.recommendation);
      expect(advice.output.targetCloud).toBeNull();
      expect(advice.output.caveats.join(" ")).toMatch(/object storage.*Google Cloud/);
    });
  });

  describe("access", () => {
    it("another user's scenario id is a 404 before anything runs: no row, no rate used, nothing of it in the reply", async () => {
      const before = Number((await sql`select count(*) from advice where owner_id = ${B.id}`)[0].count);
      const res = await ask(B, { question: "What about this?", scenarioId: sidA });
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toMatch(/CANARY|3141592/);
      expect(Number((await sql`select count(*) from advice where owner_id = ${B.id}`)[0].count)).toBe(before);
      expect(Number((await sql`select count(*) from rate_event where user_id = ${B.id} and kind = 'advice'`)[0].count)).toBe(0);
      // a missing id and a malformed one look the same
      for (const id of [crypto.randomUUID(), "not-a-uuid"]) {
        const other = await ask(B, { question: "q", scenarioId: id });
        expect(other.status).toBe(404);
        expect(await other.text()).toBe(text);
      }
      // so does an admin
      expect((await ask(ADMIN, { question: "q", scenarioId: sidA })).status).toBe(404);
    });

    it("a scenario id passed to a tool is checked the same way: not found, with nothing of the scenario in the trace or the answer", async () => {
      const who = { id: B.id, role: "user" as const };
      const set = tools.advisorTools(who);
      const priceScenario = set.find((t) => t.name === "priceScenario")!;
      const move = set.find((t) => t.name === "migrationBreakEven")!;
      const ctx = { signal: new AbortController().signal };
      for (const id of [sidA, crypto.randomUUID(), "x".repeat(40)]) {
        await expect(priceScenario.run({ scenarioId: id }, ctx)).rejects.toMatchObject({ name: "ToolError", message: "not found" });
        await expect(move.run({ app: "ad4-plain", to: "azure", scenarioId: id }, ctx)).rejects.toMatchObject({ name: "ToolError", message: "not found" });
      }
      // The owner gets a result from the same tool (control).
      const own = tools.advisorTools({ id: A.id, role: "user" }).find((t) => t.name === "priceScenario")!;
      expect(await own.run({ scenarioId: sidA }, ctx)).toMatchObject({ source: "scenario" });

      // And through a whole agent run: a model that asks for another user's scenario learns nothing.
      setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key" });
      const llm = new ScriptedLlm(
        [{ name: "priceScenario", args: { scenarioId: sidA } }, { name: "migrationBreakEven", args: { app: "ad4-plain", to: "azure", scenarioId: sidA } }],
        () => ({
          headline: "Done", recommendation: "move", targetCloud: "azure", explanation: "Looked at it.", caveats: [],
          figures: [{ label: "Monthly", valueUsd: 100, unit: "per_month", call: "c1", path: "/clouds/aws/listUsd" }],
        }),
      );
      const result = await agent.runAgent(
        { task: "scaling-advice", system: "s", schema: checks.adviceOutput, input: "Price scenario " + sidA, tools: tools.advisorTools(who) },
        { innerLlm: llm },
      );
      expect(result.calls.map((c) => [c.name, c.result, c.error])).toEqual([["priceScenario", null, "not found"], ["migrationBreakEven", null, "not found"]]);
      const { output, checks: c } = checks.checkAdvice(result.data, result.calls);
      expect(JSON.stringify([result.calls, output, c])).not.toMatch(/CANARY|3141592/);
      expect(c.droppedFigures).toHaveLength(1);
      expect(output.recommendation).toBe("not_enough_data");
    });

    it("saved answers are the owner's alone: others, an admin included, get 404 and empty lists", async () => {
      current = A;
      const mine = (await (await route.GET()).json()) as { advice: Row[] };
      expect(mine.advice.length).toBeGreaterThan(0);
      expect(mine.advice.every((r) => r.ownerId === A.id)).toBe(true);
      for (const stranger of [B, ADMIN]) {
        current = stranger;
        const theirs = (await (await route.GET()).json()) as { advice: Row[] };
        expect(theirs.advice.map((r) => r.id)).not.toContain(mine.advice[0].id);
        await expect(store.getAdvice(stranger, mine.advice[0].id)).rejects.toMatchObject({ status: 404 });
      }
    });

    it("the owner column is always the actor, and the database refuses a scenario that is not theirs", async () => {
      const { advice: row } = await store.createAdvice(B, { question: "q", appName: null, scenarioId: null, output: {}, trace: [], checks: {}, provider: "demo", demo: true });
      expect(row.ownerId).toBe(B.id);
      await expect(store.createAdvice(B, { question: "q", appName: null, scenarioId: sidA, output: {}, trace: [], checks: {}, provider: "demo", demo: true })).rejects.toThrow();
    });

    it("NUL bytes in model text are dropped, not a 500", async () => {
      const { advice: row } = await store.createAdvice(A, { question: "q", appName: null, scenarioId: null, output: { headline: "a\0b", list: ["c\0"] }, trace: [{ "k\0": "v\0" }], checks: {}, provider: "demo", demo: true });
      expect(row.output).toEqual({ headline: "ab", list: ["c"] });
    });
  });

  describe("idempotent retries (clientOpId)", () => {
    const rateCount = async (id: string) => Number((await sql`select count(*) from rate_event where user_id = ${id} and kind = 'advice'`)[0].count);
    const rows = async (op: string) => Number((await sql`select count(*) from advice where client_op_id = ${op}`)[0].count);

    it("a replay returns the first answer (200), runs nothing and is not charged", async () => {
      const op = crypto.randomUUID();
      const before = await rateCount(B.id);
      const first = await ask(B, { question: "Should ad4-plain move?", app: "ad4-plain", clientOpId: op });
      expect(first.status).toBe(201);
      const { advice: a } = (await first.json()) as { advice: Row };
      expect(await rateCount(B.id)).toBe(before + 1);
      const again = await ask(B, { question: "Should ad4-plain move?", app: "ad4-plain", clientOpId: op });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { advice: Row }).advice.id).toBe(a.id);
      expect(await rateCount(B.id)).toBe(before + 1);
      expect(await rows(op)).toBe(1);
    });

    it("parallel duplicates make one row and one charge", async () => {
      const op = crypto.randomUUID();
      const before = await rateCount(B.id);
      current = B;
      const body = { question: "Twice at once", app: "ad4-plain", clientOpId: op };
      const results = await Promise.all([advisor.askAdvisor(B, body), advisor.askAdvisor(B, body), advisor.askAdvisor(B, body)]);
      expect(new Set(results.map((r) => r.advice.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await rows(op)).toBe(1);
      expect(await rateCount(B.id)).toBe(before + 1);
    });

    it("the database keeps one row even when two writers race past the lookup", async () => {
      const op = crypto.randomUUID();
      const make = () => store.createAdvice(B, { question: "q", appName: null, scenarioId: null, output: {}, trace: [], checks: {}, provider: "demo", demo: true, clientOpId: op });
      const [x, y] = await Promise.all([make(), make()]);
      expect(x.advice.id).toBe(y.advice.id);
      expect([x.created, y.created].sort()).toEqual([false, true]);
      expect(await rows(op)).toBe(1);
    });

    it("an op id is per user: another user's replay of the same id is their own question", async () => {
      const op = crypto.randomUUID();
      const a = await advisor.askAdvisor(A, { question: "q", app: "ad4-plain", clientOpId: op });
      const b = await advisor.askAdvisor(B, { question: "q", app: "ad4-plain", clientOpId: op });
      expect(a.advice.id).not.toBe(b.advice.id);
      expect(b.created).toBe(true);
    });

    it("rejects a malformed op id", async () => {
      expect((await ask(B, { question: "q", clientOpId: "nope" })).status).toBe(400);
    });
  });

  describe("input and routes", () => {
    it("signed out is 401, a cross-origin post is refused, and bad input is a 400", async () => {
      current = null;
      expect((await route.POST(post({ question: "q" }))).status).toBe(401);
      current = A;
      expect((await route.POST(post({ question: "q" }, "https://evil.example"))).status).toBe(403);
      for (const body of [{}, { question: "" }, { question: "x".repeat(501) }, { question: "a\0b" }, { question: "q", app: "Not A Name" }, { question: "q", extra: 1 }, { question: "q", scenarioId: "a\0" }]) {
        expect((await ask(A, body)).status).toBe(400);
      }
      expect((await ask(A, { question: "q", app: "ad4-nope" })).status).toBe(404);
    });
  });

  describe("limits", () => {
    it("10 questions an hour per user, then 429 with nothing stored; other users are unaffected", async () => {
      for (let i = 0; i < 10; i++) expect((await ask(R, { question: `q${i}`, app: "ad4-plain" })).status).toBe(201);
      const res = await ask(R, { question: "one more", app: "ad4-plain" });
      expect(res.status).toBe(429);
      expect(Number((await sql`select count(*) from advice where owner_id = ${R.id}`)[0].count)).toBe(10);
      expect((await ask(B, { question: "me too", app: "ad4-plain" })).status).toBe(201);
    });

    it("a run that delivers nothing gives the attempt and the day's budget back", async () => {
      await sql`delete from daily_usage where kind = 'ai'`;
      await sql`delete from rate_event where user_id = ${A.id} and kind = 'advice'`;
      setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", AI_FALLBACK_TO_DEMO: "false" });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
      const limits = { userId: A.id, rate: { kind: "advice" as const, limit: 10, message: "m" }, daily: { kind: "ai" as const, cap: 5 } };
      const req = { task: "scaling-advice", system: "s", schema: checks.adviceOutput, input: "q", tools: tools.advisorTools({ id: A.id, role: "user" }), limits };
      await expect(agent.runAgent(req, { innerLlm: new FailingLlm() })).rejects.toMatchObject({ name: "AiError" });
      expect(Number((await sql`select count(*) from rate_event where user_id = ${A.id} and kind = 'advice'`)[0].count)).toBe(0);
      expect(Number((await sql`select coalesce(sum(count), 0) as n from daily_usage where kind = 'ai'`)[0].n)).toBe(0);
    });

    it("keeps the day's charge once a live model answered, even if that answer was unusable; the attempt itself is still given back", async () => {
      await sql`delete from daily_usage where kind = 'ai'`;
      await sql`delete from rate_event where user_id = ${A.id} and kind = 'advice'`;
      setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", AI_FALLBACK_TO_DEMO: "false" });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
      const limits = { userId: A.id, rate: { kind: "advice" as const, limit: 10, message: "m" }, daily: { kind: "ai" as const, cap: 5 } };
      const req = { task: "scaling-advice", system: "s", schema: checks.adviceOutput, input: "q", tools: tools.advisorTools({ id: A.id, role: "user" }), limits };
      await expect(agent.runAgent(req, { innerLlm: new ScriptedLlm([], () => "not json") })).rejects.toMatchObject({ name: "AiError" });
      expect(Number((await sql`select count(*) from rate_event where user_id = ${A.id} and kind = 'advice'`)[0].count)).toBe(0);
      expect(Number((await sql`select count from daily_usage where kind = 'ai' and day = (now() at time zone 'utc')::date`)[0].count)).toBe(1);
    });

    it("at the daily budget the answer is the demo script (a live run counts, a demo run does not)", async () => {
      await sql`delete from daily_usage where kind = 'ai'`;
      await sql`delete from rate_event where user_id = ${A.id} and kind = 'advice'`;
      setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key" });
      const limits = { userId: A.id, rate: { kind: "advice" as const, limit: 10, message: "m" }, daily: { kind: "ai" as const, cap: 1 } };
      const run = (llm: InstanceType<typeof ScriptedLlm>) =>
        agent.runAgent({ task: "scaling-advice", system: "s", schema: checks.adviceOutput, input: "q", tools: tools.advisorTools({ id: A.id, role: "user" }), demoContext: { app: "ad4-plain" }, limits }, { innerLlm: llm });
      const answer = { headline: "x", recommendation: "not_enough_data", targetCloud: null, figures: [], explanation: "e", caveats: [] };
      const first = await run(new ScriptedLlm([], () => answer));
      expect(first.engine).toBe("adk");
      const second = await run(new ScriptedLlm([], () => answer));
      expect(second).toMatchObject({ engine: "demo", demo: true, fallbackReason: "daily_cap" });
      expect(Number((await sql`select count from daily_usage where kind = 'ai' and day = (now() at time zone 'utc')::date`)[0].count)).toBe(1);
    });
  });
});
