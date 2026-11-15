import { z } from "zod";

/**
 * Server-side checks on the advisor's answer. The model only chooses words and which tool results to cite; every
 * number a reader sees, and the verdict, comes from tool results the server recorded.
 *
 *  1. A figure must name a recorded call and a JSON pointer into its result, and equal that number to the cent.
 *     Failures are dropped and listed; survivors show the tool's own number.
 *  2. If `migrationBreakEven` ran, the recommendation and target cloud are its verdict (the best verdict when it ran
 *     more than once). If it never ran, the answer cannot recommend a move: `not_enough_data`.
 *  3. Any number written in the headline, a figure label, the explanation or a caveat that is not a surviving figure
 *     (or one of the rule thresholds the code itself wrote into a verdict's reasons) is removed.
 *  4. Blocker reasons from the code are added as caveats.
 *  5. If no figure survived and no verdict ran, the answer becomes a fixed sentence pointing at the computed tables.
 *
 * Output is rendered as plain text. Pure functions: no database, no model.
 */

export const RECOMMENDATIONS = ["stay", "consider", "move", "blocked", "not_enough_data"] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export const adviceOutput = z.object({
  headline: z.string().min(1).max(140),
  recommendation: z.enum(RECOMMENDATIONS),
  targetCloud: z.enum(["aws", "azure", "gcp", "oci"]).nullable(),
  figures: z
    .array(
      z.object({
        label: z.string().max(60),
        valueUsd: z.number(),
        unit: z.enum(["per_month", "one_time", "months"]),
        /** The tool call it came from (`callId` in the tool result). */
        call: z.string().regex(/^c[1-9]$/),
        /** JSON pointer into that call's result. */
        path: z.string().max(80),
      }),
    )
    .max(8),
  explanation: z.string().max(600),
  caveats: z.array(z.string().max(160)).max(4),
});
export type AdviceOutput = z.infer<typeof adviceOutput>;

export type TraceCall = { id: string; name: string; args: unknown; result: unknown; error: string | null };

export type DroppedFigure = { label: string; call: string; path: string; reason: "unknown_call" | "call_failed" | "path_not_found" | "not_a_number" | "mismatch" };

export type AdviceChecks = {
  droppedFigures: DroppedFigure[];
  strippedNumbers: number;
  /** The call whose verdict decided the recommendation, or null. */
  verdictCall: string | null;
  verdictReplaced: boolean;
  /** True when nothing could be verified and the answer is the fixed sentence. */
  fixedAnswer: boolean;
};

export const FIXED_HEADLINE = "No verified figures: see the computed tables";
export const FIXED_EXPLANATION =
  "The advisor could not back an answer with figures from the price tables. The computed tables on the footprint and scenario pages show the prices and the move analysis.";
export const NO_MOVE_ANALYSIS_CAVEAT = "No move analysis was run for this question, so no recommendation is made.";

const cents = (n: number) => Math.round(n * 100);
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** RFC 6901 pointer lookup that never reaches inherited properties. */
export function resolvePointer(root: unknown, path: string): unknown {
  if (path === "") return root;
  if (!path.startsWith("/")) return undefined;
  let node: unknown = root;
  for (const raw of path.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
      node = node[Number(key)];
    } else if (isRecord(node) && Object.hasOwn(node, key)) {
      node = node[key];
    } else {
      return undefined;
    }
  }
  return node;
}

const NUMBER = /\$?\d[\d,]*(?:\.\d+)?%?/g;

function numbersIn(text: string): number[] {
  return [...text.matchAll(NUMBER)].map((m) => Number(m[0].replace(/[$,%]/g, ""))).filter(Number.isFinite);
}

/** Removes number tokens whose value (to the cent) is not allowed; keeps app names (which may hold digits) intact. */
export function stripNumbers(text: string, allowed: ReadonlySet<number>, keep: readonly string[]): { text: string; removed: number } {
  let removed = 0;
  const names = [...new Set(keep)].filter(Boolean).sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = names.length ? text.split(new RegExp(`(${names.join("|")})`)) : [text];
  const out = parts.map((part, i) => {
    if (names.length && i % 2 === 1) return part; // a kept name
    return part.replace(NUMBER, (token) => {
      const value = Number(token.replace(/[$,%]/g, ""));
      if (!token.endsWith("%") && Number.isFinite(value) && allowed.has(cents(value))) return token;
      removed++;
      return "";
    });
  });
  const cleaned = out.join("").replace(/[ \t]{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
  return { text: cleaned, removed };
}

const VERDICT_RANK: Record<string, number> = { move: 5, consider: 4, stay: 3, not_enough_data: 2, blocked: 1 };

type Verdict = { call: string; verdict: Recommendation; to: string; saving: number; reasons: string[]; blockers: string[] };

function verdictsOf(calls: readonly TraceCall[]): Verdict[] {
  const out: Verdict[] = [];
  for (const c of calls) {
    if (c.name !== "migrationBreakEven" || c.error || !isRecord(c.result)) continue;
    const r = c.result;
    if (typeof r.verdict !== "string" || !(RECOMMENDATIONS as readonly string[]).includes(r.verdict) || typeof r.to !== "string") continue;
    out.push({
      call: c.id,
      verdict: r.verdict as Recommendation,
      to: r.to,
      saving: typeof r.monthlySavingUsd === "number" ? r.monthlySavingUsd : -Infinity,
      reasons: Array.isArray(r.reasons) ? r.reasons.filter((x): x is string => typeof x === "string") : [],
      blockers: Array.isArray(r.blockers) ? r.blockers.flatMap((b) => (isRecord(b) && typeof b.reason === "string" ? [b.reason] : [])) : [],
    });
  }
  return out;
}

function bestVerdict(vs: Verdict[]): Verdict | null {
  let best: Verdict | null = null;
  for (const v of vs) {
    if (!best || VERDICT_RANK[v.verdict] > VERDICT_RANK[best.verdict] || (VERDICT_RANK[v.verdict] === VERDICT_RANK[best.verdict] && v.saving > best.saving)) best = v;
  }
  return best;
}

/** App names the answer may repeat: from the arguments and results of the calls. */
function appNames(calls: readonly TraceCall[]): string[] {
  const names: string[] = [];
  for (const c of calls) {
    if (isRecord(c.args) && typeof c.args.app === "string") names.push(c.args.app);
    if (!c.error && isRecord(c.result) && typeof c.result.name === "string") names.push(c.result.name);
  }
  return names;
}

export function checkAdvice(output: AdviceOutput, calls: readonly TraceCall[]): { output: AdviceOutput; checks: AdviceChecks } {
  const byId = new Map(calls.map((c) => [c.id, c]));
  const dropped: DroppedFigure[] = [];
  const figures: AdviceOutput["figures"] = [];

  for (const f of output.figures) {
    const drop = (reason: DroppedFigure["reason"]) => dropped.push({ label: f.label.slice(0, 60), call: f.call, path: f.path.slice(0, 80), reason });
    const call = byId.get(f.call);
    if (!call) drop("unknown_call");
    else if (call.error || call.result === null) drop("call_failed");
    else {
      const actual = resolvePointer(call.result, f.path);
      if (actual === undefined) drop("path_not_found");
      else if (typeof actual !== "number" || !Number.isFinite(actual)) drop("not_a_number");
      else if (cents(actual) !== cents(f.valueUsd)) drop("mismatch");
      else figures.push({ ...f, valueUsd: Math.round(actual * 100) / 100 }); // show the tool's number, not the model's
    }
  }

  const verdicts = verdictsOf(calls);
  const verdict = bestVerdict(verdicts);
  let recommendation = output.recommendation;
  let targetCloud = output.targetCloud;
  const trustedCaveats: string[] = [];
  if (verdict) {
    recommendation = verdict.verdict;
    targetCloud = (verdict.verdict === "move" || verdict.verdict === "consider") && ["aws", "azure", "gcp", "oci"].includes(verdict.to) ? (verdict.to as "aws") : null;
    trustedCaveats.push(...verdict.blockers);
  } else {
    // A move recommendation with no move analysis is a model opinion: verdicts come from code.
    if (recommendation !== "not_enough_data") trustedCaveats.push(NO_MOVE_ANALYSIS_CAVEAT);
    recommendation = "not_enough_data";
    targetCloud = null;
  }
  const verdictReplaced = recommendation !== output.recommendation || targetCloud !== output.targetCloud;

  const allowed = new Set<number>(figures.map((f) => cents(f.valueUsd)));
  // Thresholds the code itself wrote into reasons ("within 6 months", "$10 a month") are not model numbers.
  for (const v of verdicts) for (const r of v.reasons) for (const n of numbersIn(r)) allowed.add(cents(n));
  const keep = appNames(calls);
  let strippedNumbers = 0;
  const clean = (t: string) => {
    const r = stripNumbers(t, allowed, keep);
    strippedNumbers += r.removed;
    return r.text;
  };
  const headline = clean(output.headline) || "Scaling advice";
  const explanation = clean(output.explanation);
  const modelCaveats = output.caveats.map(clean).filter(Boolean);
  const caveats = [...new Set([...trustedCaveats, ...modelCaveats])].map((c) => c.slice(0, 160)).slice(0, 4);
  const labelled = figures.map((f) => ({ ...f, label: clean(f.label) || "Figure" }));

  const checks: AdviceChecks = { droppedFigures: dropped, strippedNumbers, verdictCall: verdict?.call ?? null, verdictReplaced, fixedAnswer: false };
  if (labelled.length === 0 && !verdict) {
    checks.fixedAnswer = true;
    return {
      output: { headline: FIXED_HEADLINE, recommendation: "not_enough_data", targetCloud: null, figures: [], explanation: FIXED_EXPLANATION, caveats: [] },
      checks,
    };
  }
  return { output: { headline, recommendation, targetCloud, figures: labelled, explanation, caveats }, checks };
}
