import type { DemoTeamScript, DemoToolResult, DemoToolScript } from "./types";

/**
 * Recorded answers keyed by task name. Demo mode keeps live demos working when the
 * free model quota is used up, and lets tests run without a network or API key.
 * Each app adds a fixture for each AI task it defines.
 */
export const demoFixtures: Record<string, unknown> = {
  // Static shape of a scaling answer. The advisor itself runs the scripted tool loop below (real tools, real numbers);
  // this fixture is only what a plain generate() call for the task would return.
  "scaling-advice": {
    headline: "Recorded demo answer: no live model",
    recommendation: "not_enough_data",
    targetCloud: null,
    figures: [],
    explanation: "This is a recorded answer. Ask again with a live model, or read the computed tables on the footprint page.",
    caveats: ["Demo answer (no live model)"],
  },
  "summarize-items": {
    summary:
      "You have a few open items. The most recent ones focus on setup work; nothing looks overdue.",
    highlights: ["Setup tasks are the largest group", "No items are flagged urgent"],
  },
};

/**
 * Scripted tool loops for tasks that use `generate({ tools })`, keyed by task name. A script is a function
 * of the caller's `demoContext`; the loop runs the real handlers for each step, then `final` builds the
 * answer from their results. Keep `args` valid for the real tool schemas.
 */
export const demoToolScripts: Record<string, (ctx: unknown) => DemoToolScript> = {
  // Example for the README: an assistant that looks items up, then answers.
  "items-assistant": (ctx) => {
    const query = typeof (ctx as { query?: unknown } | undefined)?.query === "string" ? (ctx as { query: string }).query : "setup";
    return {
      steps: [{ call: { name: "search_items", args: { query } } }],
      final: (results) => {
        const found = results[0]?.ok && Array.isArray(results[0].data) ? results[0].data.length : 0;
        return { reply: `Demo assistant (recorded): I found ${found} matching item${found === 1 ? "" : "s"}.`, matches: found };
      },
    };
  },
};

const CLOUDS_IN_ORDER = ["aws", "azure", "gcp", "oci"] as const;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

type DemoAsk = { app: string; scenarioId: string | undefined };
function demoAsk(ctx: unknown): DemoAsk {
  const c = isObj(ctx) ? ctx : {};
  return { app: typeof c.app === "string" ? c.app : "helpdesk", scenarioId: typeof c.scenarioId === "string" ? c.scenarioId : undefined };
}

/** The scenario step: the user's own scenario, else the 10x users preset. */
const scenarioCall = ({ scenarioId }: DemoAsk) => ({ name: "priceScenario", args: scenarioId ? { scenarioId } : { preset: "10x_users" } });

/** The move step: the app's own cloud to the cheapest cloud it is not on, by the scenario's list price. */
function moveCall({ app, scenarioId }: DemoAsk, previous: DemoToolResult[]) {
  const fp = previous[0]?.ok && isObj(previous[0].data) ? previous[0].data : {};
  const runsOn = Array.isArray(fp.clouds) ? fp.clouds.filter((x): x is string => typeof x === "string") : [];
  const scen = previous[1]?.ok && isObj(previous[1].data) && isObj(previous[1].data.clouds) ? previous[1].data.clouds : {};
  const candidates = CLOUDS_IN_ORDER.filter((x) => !runsOn.includes(x));
  const price = (x: string) => (isObj(scen[x]) && typeof scen[x].listUsd === "number" ? scen[x].listUsd : Infinity);
  const to = [...candidates].sort((a, b) => price(a) - price(b))[0] ?? "aws";
  return { name: "migrationBreakEven", args: { app, from: runsOn[0], to, ...(scenarioId ? { scenarioId } : {}) } };
}

/** `final` for both demos: written by code from the real results (results[2] is the move analysis). */
function demoFinal({ app, scenarioId }: DemoAsk, results: DemoToolResult[], opts: { pricingFigure?: boolean } = {}) {
  const move = results[2];
  const m = move?.ok && isObj(move.data) ? move.data : null;
  const call = m && typeof m.callId === "string" ? m.callId : "c3";
  if (!m) {
    return {
      headline: `Recorded demo answer: ${app} could not be analysed`,
      recommendation: "not_enough_data",
      targetCloud: null,
      figures: [],
      explanation: "The demo run could not price this app. Check the app name and the price table.",
      caveats: ["Demo answer (no live model)"],
    };
  }
  const fig = (label: string, key: string, unit: "per_month" | "one_time" | "months") =>
    typeof m[key] === "number" ? [{ label, valueUsd: m[key] as number, unit, call, path: `/${key}` }] : [];
  // The team demo also cites the pricing specialist's own scenario figure for the target cloud.
  const scen = results[1]?.ok && isObj(results[1].data) ? results[1].data : null;
  const scenCloud = scen && isObj(scen.clouds) && typeof m.to === "string" && isObj(scen.clouds[m.to]) ? scen.clouds[m.to] : null;
  const pricing =
    opts.pricingFigure && scen && typeof scen.callId === "string" && isObj(scenCloud) && typeof scenCloud.listUsd === "number"
      ? [{ label: `Scenario list cost on ${String(m.to)}`, valueUsd: scenCloud.listUsd, unit: "per_month" as const, call: scen.callId, path: `/clouds/${String(m.to)}/listUsd` }]
      : [];
  const verdict = typeof m.verdict === "string" ? m.verdict : "not_enough_data";
  return {
    headline: scenarioId ? `Recorded demo answer: ${app} on your scenario` : `Recorded demo answer: ${app} at ten times the users`,
    recommendation: verdict,
    targetCloud: verdict === "move" || verdict === "consider" ? m.to : null,
    figures: [
      ...fig(`Monthly list cost on ${String(m.from)}`, "monthlyFromUsd", "per_month"),
      ...fig(`Monthly list cost on ${String(m.to)}`, "monthlyToUsd", "per_month"),
      ...fig("One-time cost of moving", "oneTimeUsd", "one_time"),
      ...fig("Months to pay it back", "breakEvenMonths", "months"),
      ...pricing,
    ],
    explanation: `Demo: ${Array.isArray(m.reasons) ? m.reasons.filter((r) => typeof r === "string").join(" ") : "see the figures."}`.slice(0, 600),
    caveats: ["Demo answer (no live model)", "List prices only, not a quote."],
  };
}

/**
 * Scaling advisor demo: getFootprint(app ?? "helpdesk") -> priceScenario(the user's scenario, else the 10x users preset)
 * -> migrationBreakEven(app, its cloud, the cheapest cloud it is not on). `final` writes the answer from those results,
 * so a demo shows real numbers and passes the same server checks as a live one.
 */
demoToolScripts["scaling-advice"] = (ctx) => {
  const ask = demoAsk(ctx);
  return {
    steps: [{ call: { name: "getFootprint", args: { app: ask.app } } }, { call: scenarioCall(ask) }, { call: (previous) => moveCall(ask, previous) }],
    final: (results) => demoFinal(ask, results),
  };
};

/**
 * The same demo as a team: the pricing specialist calls getFootprint then priceScenario, the migration specialist calls
 * migrationBreakEven. Each tool call is recorded with its specialist, so attribution shows in demo mode too.
 */
export const demoTeamScripts: Record<string, (ctx: unknown) => DemoTeamScript> = {
  "scaling-advice": (ctx) => {
    const ask = demoAsk(ctx);
    return {
      delegations: [
        { agent: "pricing", steps: [{ call: { name: "getFootprint", args: { app: ask.app } } }, { call: scenarioCall(ask) }] },
        { agent: "migration", steps: [{ call: (previous) => moveCall(ask, previous) }] },
      ],
      final: (results) => demoFinal(ask, results, { pricingFigure: true }),
    };
  },
};

export function demoAnswer(task: string): string {
  const fixture = demoFixtures[task];
  if (fixture === undefined) {
    throw new Error(`No demo fixture for AI task "${task}". Add one to src/lib/ai/demo.ts.`);
  }
  return JSON.stringify(fixture);
}
