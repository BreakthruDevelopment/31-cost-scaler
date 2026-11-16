/**
 * Runs the scaling advisor's eval cases (test/advice-eval-cases.ts) against the LIVE model, with the same server checks
 * as production. Not part of CI. Needs a local database that holds the fixture footprint and prices:
 *   pnpm db:migrate && pnpm seed:footprint && pnpm seed:prices
 *   AI_PROVIDER=gemini GEMINI_API_KEY=... DATABASE_URL=postgres://...@localhost/... pnpm eval:advice
 * It creates two throwaway users (eval-live-*) and one scenario, and removes them afterwards. Cases that script a
 * deliberately wrong model are skipped. Record the results in the app's run log.
 *
 * It asks FIVE questions (the cases flagged `live`), each through the coordinator-and-specialists team: about 40 model
 * requests against the Gemini key's shared free daily allowance. Run it once, not on a day with a planned demo. It prints the
 * p50 and the slowest latency (with 5 samples the slowest stands in for p95; the target is p95 <= 45 s).
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();
if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]", "postgres", "db"].includes(host)) {
  throw new Error("Eval refused: it writes throwaway users, so it only runs against a local database.");
}
if (process.env.AI_PROVIDER !== "gemini" || !process.env.GEMINI_API_KEY) {
  throw new Error("Set AI_PROVIDER=gemini and GEMINI_API_KEY: this runs the live model.");
}
// Live only: a failure must show, not be papered over by the demo script.
process.env.AI_FALLBACK_TO_DEMO = "false";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
process.env.LOG_LEVEL ??= "warn";

const { runAgent } = await import("../src/lib/ai/agent");
const { adviceOutput, checkAdvice, figureAgents } = await import("../src/lib/advice-checks");
const { advisorToolset } = await import("../src/lib/advice-tools");
const { ADVICE_TASK, ADVISOR_SYSTEM, advisorTeam } = await import("../src/lib/advisor");
const { BASE_SPEC } = await import("../src/lib/pricing/spec");
const { evalCases, outcomeOf } = await import("../test/advice-eval-cases");

const sql = postgres(url, { max: 1, onnotice: () => {} });
const actor = { id: "eval-live-actor", role: "user" as const };
const other = { id: "eval-live-other", role: "user" as const };
let failed = 0;
const latencies: number[] = [];
try {
  const apps = await sql`select name from footprint_app where name in ('helpdesk', 'expense-tracker')`;
  const prices = await sql`select count(*)::int as n from price_point where status = 'active'`;
  if (apps.length < 2 || prices[0].n === 0) throw new Error("Seed the fixture first: pnpm seed:footprint && pnpm seed:prices");
  await sql`delete from "user" where id like 'eval-live-%'`;
  for (const u of [actor, other]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@eval.local"}, ${u.role})`;
  const spec = { ...BASE_SPEC, users: { ...BASE_SPEC.users, mau: 2_718_281 } };
  const [{ id: foreignScenarioId }] = await sql`insert into scenario (owner_id, name, spec) values (${other.id}, 'EVAL-CANARY-NAME', ${sql.json(spec)}) returning id`;

  const live = evalCases({ foreignScenarioId, canaries: ["EVAL-CANARY-NAME", "2718281"] }).filter((c) => c.live);
  if (live.length !== 5) throw new Error(`Expected 5 live cases, found ${live.length}`);
  for (const c of live) {
    const started = Date.now();
    try {
      const tools = advisorToolset(actor);
      const result = await runAgent({
        task: ADVICE_TASK,
        system: ADVISOR_SYSTEM,
        schema: adviceOutput,
        input: c.question,
        context: c.app ? `The user is asking about the app "${c.app}".` : undefined,
        tools: tools.all,
        team: advisorTeam(tools),
        demoContext: { app: c.app },
      });
      const ms = Date.now() - started;
      latencies.push(ms);
      const { output, checks } = checkAdvice(result.data, result.calls, { trustedText: result.demo });
      const outcome = outcomeOf({
        output,
        checks,
        calls: result.calls,
        engine: result.engine,
        demo: result.demo,
        fallbackReason: result.fallbackReason,
        notice: result.notice,
        delegations: result.delegations,
        figureAgents: figureAgents(output.figures, result.calls),
        teamDroppedFigures: result.teamDroppedFigures,
        reportDroppedFindings: result.reportDroppedFindings,
        attempts: result.attempts,
        requestsSent: result.requestsSent,
      });
      // The question must have been answered by the team: a fallback or the demo hides what the live model did.
      const fails = [...(result.engine === "team" ? [] : [`answered by ${result.engine}, not the team (${result.fallbackReason ?? "no reason"})`]), ...c.check(outcome)];
      if (fails.length) failed++;
      console.log(
        `${fails.length ? "FAIL" : "PASS"}  ${c.name}\n      engine=${result.engine}${result.fallbackReason ? ` (fallback: ${result.fallbackReason})` : ""} delegations=${result.delegations.map((d) => `${d.agent}:${d.llmCalls}`).join(",") || "none"} ` +
          `calls=${result.calls.map((x) => `${x.agent ?? "-"}.${x.name}`).join(">") || "none"} requests=${result.requestsSent} ` +
          `dropped=${checks.droppedFigures.length}+${result.teamDroppedFigures.length} stripped=${checks.strippedNumbers} ms=${ms}${fails.length ? `\n      ${fails.join("\n      ")}` : ""}`,
      );
    } catch (err) {
      failed++;
      console.log(`FAIL  ${c.name}\n      ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    }
  }
} finally {
  await sql`delete from "user" where id like 'eval-live-%'`.catch(() => undefined);
  await sql.end();
}
if (latencies.length) {
  const sorted = [...latencies].sort((a, b) => a - b);
  console.log(`\nlatency over ${sorted.length} questions: p50 ${(sorted[Math.floor((sorted.length - 1) / 2)] / 1000).toFixed(1)} s, slowest ${(sorted.at(-1)! / 1000).toFixed(1)} s (target p95 <= 45 s)`);
}
console.log(failed ? `\n${failed} case(s) failed` : "\nAll live cases passed");
process.exit(failed ? 1 : 0);
