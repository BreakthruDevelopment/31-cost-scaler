/**
 * The scaling advisor's eval cases (test/advice-eval-cases.ts), run with a stub model so CI checks the plumbing: the
 * tools, the recorded trace and the server checks. `pnpm eval:advice` runs the same cases against the live model.
 * Needs Postgres (the tools read the footprint and the price table): runs against the scratch TEST_DATABASE_URL.
 */
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { BASE_SPEC } from "@/lib/pricing/spec";
import { type EvalCase, type EvalOutcome, evalCases, outcomeOf } from "./advice-eval-cases";
import { ScriptedLlm, TeamScriptedLlm } from "./ai-stub-llm";
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

  /** One case through the single agent (`stub`) or, when it has team scripts, through the team, as `askAdvisor` runs them. */
  async function run(c: EvalCase): Promise<EvalOutcome> {
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("LOG_LEVEL", "error");
    vi.stubEnv("AI_FALLBACK_TO_DEMO", "true");
    resetEnvCache();
    const toolset = mods.tools.advisorToolset(ACTOR);
    const base = {
      task: mods.advisor.ADVICE_TASK,
      system: mods.advisor.ADVISOR_SYSTEM,
      schema: mods.checks.adviceOutput,
      input: c.question,
      context: c.app ? `The user is asking about the app "${c.app}".` : undefined,
      tools: toolset.all,
      demoContext: { app: c.app },
    };
    if (!c.team) {
      const llm = new ScriptedLlm(c.stub!.plan, c.stub!.final);
      const result = await mods.agent.runAgent({ ...base, demoContext: undefined }, { innerLlm: llm });
      const { output, checks } = mods.checks.checkAdvice(result.data, result.calls);
      expect(result.engine).toBe("adk");
      return outcomeOf({ output, checks, calls: result.calls, engine: result.engine });
    }
    const llm = new TeamScriptedLlm(c.team);
    const result = await mods.agent.runAgent({ ...base, team: mods.advisor.advisorTeam(toolset) }, { innerLlm: llm });
    const { output, checks } = mods.checks.checkAdvice(result.data, result.calls, { trustedText: result.demo });
    return outcomeOf({
      output,
      checks,
      calls: result.calls,
      engine: result.engine,
      demo: result.demo,
      fallbackReason: result.fallbackReason,
      notice: result.notice,
      delegations: result.delegations,
      figureAgents: mods.checks.figureAgents(output.figures, result.calls),
      teamDroppedFigures: result.teamDroppedFigures,
      reportDroppedFindings: result.reportDroppedFindings,
      attempts: result.attempts,
      requestsSent: result.requestsSent,
    });
  }

  for (const [i] of cases().entries()) {
    it(`case ${i + 1}: ${cases()[i].name}`, async () => {
      const outcome = await run(cases()[i]);
      expect(cases()[i].check(outcome)).toEqual([]);
    });
  }

  it("there are exactly five live questions, so `pnpm eval:advice` stays within the key's shared allowance", () => {
    expect(cases().filter((c) => c.live && !c.stubOnly)).toHaveLength(5);
  });

  it("the team answers from the stub keep the figures that specialists reported, with the tools' own values", async () => {
    const c = cases().find((x) => x.name.startsWith("team: a move question"))!;
    const o = await run(c);
    expect(o.engine).toBe("team");
    expect(o.output.figures.length).toBeGreaterThanOrEqual(3);
    for (const f of o.output.figures) {
      const call = o.calls.find((x) => x.id === f.call)!;
      expect(mods.checks.resolvePointer(call.result, f.path)).toBeCloseTo(f.valueUsd, 2);
      expect(call.agent).toBe(o.figureAgents[f.call]);
    }
    expect(o.teamDroppedFigures).toEqual([]);
    expect(o.checks.droppedFigures).toEqual([]);
  });

  it("the demo team answer for helpdesk passes checkAdvice with full attribution", async () => {
    vi.stubEnv("AI_PROVIDER", "demo");
    vi.stubEnv("LOG_LEVEL", "error");
    resetEnvCache();
    const toolset = mods.tools.advisorToolset(ACTOR);
    const result = await mods.agent.runAgent({
      task: mods.advisor.ADVICE_TASK,
      system: mods.advisor.ADVISOR_SYSTEM,
      schema: mods.checks.adviceOutput,
      input: "Should helpdesk move if it reaches 5,000 users?",
      tools: toolset.all,
      team: mods.advisor.advisorTeam(toolset),
      demoContext: { app: "helpdesk" },
    });
    const { output, checks } = mods.checks.checkAdvice(result.data, result.calls, { trustedText: true });
    expect(result.engine).toBe("demo");
    expect(checks.droppedFigures).toEqual([]);
    expect(checks.fixedAnswer).toBe(false);
    const attribution = mods.checks.figureAgents(output.figures, result.calls);
    expect(output.figures.length).toBeGreaterThanOrEqual(4);
    expect(output.figures.every((f) => attribution[f.call])).toBe(true);
    expect(new Set(Object.values(attribution))).toEqual(new Set(["pricing", "migration"]));
  });

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
