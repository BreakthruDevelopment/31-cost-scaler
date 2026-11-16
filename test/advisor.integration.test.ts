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
import { FailingLlm, ScriptedLlm, TeamScriptedLlm, reportText } from "./ai-stub-llm";
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
  const D = mk("ad4-day");
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
    for (const u of [A, B, R, D, ADMIN]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.email}, ${u.role})`;
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
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetEnvCache();
    setEnv();
    // The hourly limit is 4 and many tests ask as the same users: start each test with an empty hourly ledger.
    await sql`delete from rate_event where user_id like 'ad4-%' and kind = 'advice'`;
  });

  type Row = { id: string; ownerId: string; demo: boolean; provider: string; question: string; output: import("@/lib/advice-checks").AdviceOutput; trace: { id: string; name: string; agent?: string; args: Record<string, unknown>; error: string | null }[]; checks: { droppedFigures: unknown[]; engine: string; fallbackReason: string | null; fixedAnswer: boolean } };
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
      // the team demo: two delegations, every call and every shown figure attributed to its specialist, by the server
      expect(advice.checks).toMatchObject({
        delegations: [
          { agent: "pricing", callIds: ["c1", "c2"], llmCalls: 0, outcome: "ok" },
          { agent: "migration", callIds: ["c3"], llmCalls: 0, outcome: "ok" },
        ],
        requestsSent: 0,
        notice: null,
      });
      expect(advice.trace.map((c) => c.agent)).toEqual(["pricing", "pricing", "migration"]);
      const attribution = (advice.checks as unknown as { figureAgents: Record<string, string> }).figureAgents;
      expect(advice.output.figures.every((f) => attribution[f.call])).toBe(true);
      expect(new Set(Object.values(attribution))).toEqual(new Set(["pricing", "migration"]));
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
    const rateCount = async (id: string) => Number((await sql`select count(*) from rate_event where user_id = ${id} and kind = 'advice'`)[0].count);
    const dailyRow = async () => (await sql`select count from daily_usage where kind = 'ai' and day = (now() at time zone 'utc')::date`)[0]?.count as number | undefined;
    const dailySum = async () => Number((await sql`select coalesce(sum(count), 0) as n from daily_usage where kind = 'ai'`)[0].n);
    const resetDay = async (userId = A.id) => {
      await sql`delete from daily_usage where kind = 'ai'`;
      await sql`delete from rate_event where user_id = ${userId} and kind = 'advice'`;
    };
    const limitsFor = (userId: string, cap: number) => ({ userId, rate: { kind: "advice" as const, limit: 10, message: "m" }, daily: { kind: "ai" as const, cap } });
    const reqFor = (userId: string, cap: number, extra: Record<string, unknown> = {}) => ({
      task: "scaling-advice",
      system: "s",
      schema: checks.adviceOutput,
      input: "q",
      tools: tools.advisorTools({ id: userId, role: "user" }),
      demoContext: { app: "ad4-plain" },
      limits: limitsFor(userId, cap),
      ...extra,
    });

    it("4 questions an hour per user, then 429 with the hourly message and nothing stored; other users are unaffected", async () => {
      for (let i = 0; i < 4; i++) expect((await ask(R, { question: `q${i}`, app: "ad4-plain" })).status).toBe(201);
      const res = await ask(R, { question: "one more", app: "ad4-plain" });
      expect(res.status).toBe(429);
      expect(await res.text()).toContain("You've asked 4 questions this hour; try again later.");
      expect(Number((await sql`select count(*) from advice where owner_id = ${R.id}`)[0].count)).toBe(4);
      expect((await ask(B, { question: "me too", app: "ad4-plain" })).status).toBe(201);
    });

    it("parallel questions from one user: exactly 4 get through the hourly limit", async () => {
      await sql`delete from advice where owner_id = ${D.id}`;
      current = D;
      const results = await Promise.all(Array.from({ length: 7 }, (_, i) => route.POST(post({ question: `p${i}`, app: "ad4-plain" }))));
      expect(results.filter((r) => r.status === 201)).toHaveLength(4);
      expect(results.filter((r) => r.status === 429)).toHaveLength(3);
    });

    it("12 questions in the last 24 hours, counted from the advice rows: the 13th is a 429 with the daily message and no charge", async () => {
      await sql`delete from advice where owner_id = ${D.id}`;
      await sql`insert into advice (owner_id, question, output, trace, checks, provider, demo, created_at)
        select ${D.id}, 'old', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'demo', true, now() - (g || ' hours')::interval from generate_series(1, 12) g`;
      // 12 rows, the oldest 12 hours back: the day is full
      expect(await rateCount(D.id)).toBe(0);
      const res = await ask(D, { question: "one more", app: "ad4-plain" });
      expect(res.status).toBe(429);
      expect(await res.text()).toContain("You've asked 12 questions today; try again tomorrow.");
      expect(await rateCount(D.id)).toBe(0); // the refusal took nothing from the hourly allowance either
      expect(Number((await sql`select count(*) from advice where owner_id = ${D.id}`)[0].count)).toBe(12);
      // rows older than 24 h no longer count: age the three oldest out and one more question fits
      await sql`update advice set created_at = now() - interval '25 hours' where owner_id = ${D.id} and created_at < now() - interval '9 hours'`;
      expect((await ask(D, { question: "now it fits", app: "ad4-plain" })).status).toBe(201);
      // other users are unaffected by D's day
      expect((await ask(B, { question: "me too", app: "ad4-plain" })).status).toBe(201);
    });

    it("at the app's daily allowance a request makes no model call and shows the try-again-tomorrow text (demo answer, nothing reserved)", async () => {
      await resetDay(B.id);
      // GEMINI_DAILY_REQUESTS 20 x share 0.25 = 5 calls a day; 1 used leaves 4, under the 5 a question needs
      await sql`insert into daily_usage (day, kind, count) values ((now() at time zone 'utc')::date, 'ai', 1)`;
      setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", GEMINI_DAILY_REQUESTS: "20" });
      const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);
      const res = await ask(B, { question: "Should ad4-plain move?", app: "ad4-plain" });
      expect(res.status).toBe(201);
      const { advice } = (await res.json()) as { advice: Row };
      expect(fetchMock).not.toHaveBeenCalled();
      expect(advice).toMatchObject({ demo: true, provider: "demo" });
      expect(advice.output.caveats[0]).toBe("The live advisor has used today's free allowance; try again tomorrow (after 00:00 UTC). This answer is the recorded demo built from real prices.");
      expect(advice.checks).toMatchObject({ engine: "demo", fallbackReason: "daily_cap", requestsSent: 0, droppedFigures: [] });
      expect(await dailyRow()).toBe(1); // untouched
    });

    it("a run that delivers nothing gives the attempt back; the model requests it already sent stay counted", async () => {
      await resetDay();
      setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", AI_FALLBACK_TO_DEMO: "false" });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
      const failing = new FailingLlm();
      await expect(agent.runAgent(reqFor(A.id, 50), { innerLlm: failing })).rejects.toMatchObject({ name: "AiError" });
      expect(await rateCount(A.id)).toBe(0);
      // one ADK request and one generate() request went out, answered or not: 2 of the 14 reserved are used, 12 go back
      expect(await dailySum()).toBe(2);
    });

    it("units settle on requests sent: a live model that answered unusably costs its requests; the attempt itself is still given back", async () => {
      await resetDay();
      setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", AI_FALLBACK_TO_DEMO: "false" });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
      await expect(agent.runAgent(reqFor(A.id, 50), { innerLlm: new ScriptedLlm([], () => "not json") })).rejects.toMatchObject({ name: "AiError" });
      expect(await rateCount(A.id)).toBe(0);
      expect(await dailySum()).toBe(2);
    });

    it("units for generate(): a live reply and then a failure count both requests, whether it fell back to its own demo or threw", async () => {
      const reply = () => new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "getFootprint", args: { app: "ad4-plain" } } }] } }] }), { status: 200 });
      for (const fallback of ["true", "false"]) {
        await resetDay();
        setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", AI_FALLBACK_TO_DEMO: fallback });
        let n = 0;
        vi.stubGlobal("fetch", vi.fn(async () => (n++ === 0 ? reply() : new Response("{}", { status: 400 }))));
        const run = agent.runAgent(reqFor(A.id, 50), { innerLlm: new FailingLlm() });
        if (fallback === "true") expect(await run).toMatchObject({ engine: "demo", demo: true, requestsSent: 3 });
        else await expect(run).rejects.toMatchObject({ name: "AiError" });
        // the failing ADK request, generate()'s answered reply and its failed one
        expect(await dailySum()).toBe(3);
      }
    });

    it("a pure demo costs nothing, and a live answer costs its requests: at the allowance the next question is the demo", async () => {
      await resetDay();
      setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key" });
      const run = (llm: InstanceType<typeof ScriptedLlm>) => agent.runAgent(reqFor(A.id, 5), { innerLlm: llm });
      const answer = { headline: "x", recommendation: "not_enough_data", targetCloud: null, figures: [], explanation: "e", caveats: [] };
      // cap 5: the first question reserves all 5, sends 1 request and gives 4 back; 4 left is under the 5 a question needs
      const first = await run(new ScriptedLlm([], () => answer));
      expect(first).toMatchObject({ engine: "adk", requestsSent: 1 });
      expect(await dailyRow()).toBe(1);
      const second = await run(new ScriptedLlm([], () => answer));
      expect(second).toMatchObject({ engine: "demo", demo: true, fallbackReason: "daily_cap", requestsSent: 0 });
      expect(await dailyRow()).toBe(1);
    });

    it("with 5 questions in parallel the day's units never pass the budget; settled units equal the requests sent", async () => {
      await resetDay();
      await sql`delete from rate_event where user_id in (${A.id}, ${B.id}, ${R.id}, ${D.id}, ${ADMIN.id})`;
      setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key" });
      const CAP = 30;
      const users = [A, B, R, D, ADMIN];
      const toolset = (id: string) => tools.advisorToolset({ id, role: "user" });
      const team = (id: string) => {
        const t = toolset(id);
        return { ...advisor.advisorTeam(t), all: t.all };
      };
      const stub = () =>
        new TeamScriptedLlm(
          {
            coordinator: [
              { call: { name: "pricing", args: { question: "Price it.", app: "ad4-plain" } } },
              { say: { headline: "Plain", recommendation: "not_enough_data", targetCloud: null, figures: [], explanation: "Checked.", caveats: [] } },
            ],
            pricing: [{ call: { name: "getFootprint", args: { app: "ad4-plain" } } }, { say: reportText([{ call: "c1", path: "/monthlyListUsd/aws" }]) }],
          },
          15,
        );
      let peak = 0;
      const poll = setInterval(() => void dailyRow().then((n) => (peak = Math.max(peak, n ?? 0))), 5);
      const runs = await Promise.all(
        users.map(async (u) => {
          const t = team(u.id);
          return agent.runAgent({ ...reqFor(u.id, CAP, { tools: t.all }), team: t }, { innerLlm: stub() });
        }),
      );
      clearInterval(poll);
      expect(peak).toBeLessThanOrEqual(CAP);
      // 30 calls: two questions reserve 14 each (28); 2 are left, under the 5 a question needs, so the other three are demos
      const live = runs.filter((r) => !r.demo);
      const demos = runs.filter((r) => r.demo);
      expect(live).toHaveLength(2);
      expect(demos).toHaveLength(3);
      expect(demos.every((r) => r.fallbackReason === "daily_cap" && r.requestsSent === 0)).toBe(true);
      const sent = live.reduce((n, r) => n + r.requestsSent, 0);
      expect(sent).toBe(2 * 4); // coordinator 2 + pricing 2 each
      expect(await dailyRow()).toBe(sent); // settled on requests sent, the rest released
    });

    it("units are released against the reservation's own UTC day, never today's", async () => {
      await sql`delete from daily_usage where kind = 'ai'`;
      const yesterday = (await sql`select ((now() at time zone 'utc')::date - 1)::text as d`)[0].d as string;
      await sql`insert into daily_usage (day, kind, count) values (${yesterday}::date, 'ai', 14), ((now() at time zone 'utc')::date, 'ai', 6)`;
      const { releaseDailyUnits } = await import("@/lib/usage");
      const { db } = await import("@/lib/db");
      await db().transaction((tx) => releaseDailyUnits(tx, "ai", yesterday, 9));
      expect(Number((await sql`select count from daily_usage where kind = 'ai' and day = ${yesterday}::date`)[0].count)).toBe(5);
      expect(await dailyRow()).toBe(6);
      await db().transaction((tx) => releaseDailyUnits(tx, "ai", yesterday, 99)); // never below zero
      expect(Number((await sql`select count from daily_usage where kind = 'ai' and day = ${yesterday}::date`)[0].count)).toBe(0);
      await sql`delete from daily_usage where kind = 'ai'`;
    });

    it("reserveDailyUnits: min(14, remaining), only when at least 5 remain, and never past the cap", async () => {
      await sql`delete from daily_usage where kind = 'ai'`;
      const { reserveDailyUnits } = await import("@/lib/usage");
      const { db } = await import("@/lib/db");
      const reserve = (cap: number) => db().transaction((tx) => reserveDailyUnits(tx, "ai", cap, 14, 5));
      const today = (await sql`select (now() at time zone 'utc')::date::text as d`)[0].d as string;
      expect(await reserve(20)).toEqual({ day: today, units: 14 });
      expect(await reserve(20)).toEqual({ day: today, units: 6 }); // 6 remain: still at least 5
      expect(await reserve(20)).toBeNull(); // 0 remain
      await sql`update daily_usage set count = 16 where kind = 'ai'`;
      expect(await reserve(20)).toBeNull(); // 4 remain: under the minimum, nothing changes
      expect(await dailyRow()).toBe(16);
      expect(await reserve(0)).toBeNull();
      await sql`delete from daily_usage where kind = 'ai'`;
    });
  });
});
