/**
 * The scaling advisor's eval cases (test/advice-eval-cases.ts), run with a stub model so CI checks the plumbing: the
 * tools, the recorded trace and the server checks. `pnpm eval:advice` runs the same cases against the live model.
 * Needs Postgres (the tools read the footprint and the price table): runs against the scratch TEST_DATABASE_URL.
 */
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { BASE_SPEC } from "@/lib/pricing/spec";
import { type EvalOutcome, evalCases } from "./advice-eval-cases";
import { ScriptedLlm } from "./ai-stub-llm";
import { fixturePriceRows } from "./fixtures/pricing-table";

const url = process.env.TEST_DATABASE_URL;
const REGION = { aws: "us-east-2", azure: "eastus", gcp: "us-central1", oci: "global" } as const;
const ACTOR = { id: "ev-actor", role: "user" as const };
const OTHER = { id: "ev-other", role: "user" as const };

describe.skipIf(!url)("scaling advisor evals (stub model)", () => {
  let sql: postgres.Sql;
  let foreignScenarioId: string;
  let mods: { agent: typeof import("@/lib/ai/agent"); checks: typeof import("@/lib/advice-checks"); tools: typeof import("@/lib/advice-tools"); advisor: typeof import("@/lib/advisor") };
  const canaries = ["EVAL-CANARY-NAME", "2718281"];

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id like 'ev-%'`;
    for (const u of [ACTOR, OTHER]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    await sql`delete from price_point where sku_key not like 'pa.%'`;
    for (const r of fixturePriceRows()) {
      await sql`insert into price_point (cloud, component, sku_key, region, unit, usd_micros, tier_start, source_url, fetched_at)
        values (${r.cloud}, ${r.component}, ${r.skuKey}, ${REGION[r.cloud]}, ${r.unit}, ${r.usdMicros}, ${r.tierStart}, ${r.sourceUrl}, ${r.fetchedAt})`;
    }
    await sql`delete from footprint_app where name in ('helpdesk', 'expense-tracker')`;
    await sql`insert into footprint_app (name, title, clouds, domain, storage, secret_count, ai, source_commit) values
      ('helpdesk', 'Helpdesk Ticketing', '{gcp}', null, false, 0, 'gemini', 'test'),
      ('expense-tracker', 'Expense Tracker', '{gcp}', null, true, 1, 'gemini', 'test')`;
    const spec = { ...BASE_SPEC, users: { ...BASE_SPEC.users, mau: 2_718_281 } };
    [{ id: foreignScenarioId }] = await sql`insert into scenario (owner_id, name, spec) values (${OTHER.id}, ${canaries[0]}, ${sql.json(spec)}) returning id`;
    mods = {
      agent: await import("@/lib/ai/agent"),
      checks: await import("@/lib/advice-checks"),
      tools: await import("@/lib/advice-tools"),
      advisor: await import("@/lib/advisor"),
    };
  });
  afterAll(async () => {
    await sql`delete from price_point where source_url like 'https://example.test/fixture/%'`;
    await sql`delete from footprint_app where name in ('helpdesk', 'expense-tracker')`;
    await sql`delete from "user" where id like 'ev-%'`;
    await sql.end();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  const cases = () => evalCases({ foreignScenarioId, canaries });

  async function run(c: ReturnType<typeof cases>[number]): Promise<EvalOutcome> {
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("LOG_LEVEL", "error");
    resetEnvCache();
    const llm = new ScriptedLlm(c.stub.plan, c.stub.final);
    const result = await mods.agent.runAgent(
      {
        task: mods.advisor.ADVICE_TASK,
        system: mods.advisor.ADVISOR_SYSTEM,
        schema: mods.checks.adviceOutput,
        input: c.question,
        context: c.app ? `The user is asking about the app "${c.app}".` : undefined,
        tools: mods.tools.advisorTools(ACTOR),
      },
      { innerLlm: llm },
    );
    const { output, checks } = mods.checks.checkAdvice(result.data, result.calls);
    expect(result.engine).toBe("adk");
    return { output, checks, calls: result.calls, engine: result.engine };
  }

  for (const [i] of cases().entries()) {
    it(`case ${i + 1}: ${cases()[i].name}`, async () => {
      const outcome = await run(cases()[i]);
      expect(cases()[i].check(outcome)).toEqual([]);
    });
  }

  it("the demo answer for helpdesk passes the same checks", async () => {
    vi.stubEnv("AI_PROVIDER", "demo");
    vi.stubEnv("LOG_LEVEL", "error");
    resetEnvCache();
    const result = await mods.agent.runAgent({
      task: mods.advisor.ADVICE_TASK,
      system: mods.advisor.ADVISOR_SYSTEM,
      schema: mods.checks.adviceOutput,
      input: "Should helpdesk move if it reaches 5,000 users?",
      tools: mods.tools.advisorTools(ACTOR),
      demoContext: { app: "helpdesk" },
    });
    const { output, checks } = mods.checks.checkAdvice(result.data, result.calls);
    expect(result.engine).toBe("demo");
    expect(checks.droppedFigures).toEqual([]);
    expect(checks.fixedAnswer).toBe(false);
    expect(output.figures.length).toBeGreaterThanOrEqual(3);
    expect(output.recommendation).toBe(checks.verdictCall ? output.recommendation : "not_enough_data");
  });
});
