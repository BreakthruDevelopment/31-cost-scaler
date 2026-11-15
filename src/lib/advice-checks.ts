import { z } from "zod";

/**
 * Server-side checks on the advisor's answer. The model only chooses words and which tool results to cite; every
 * number a reader sees, and the verdict, comes from tool results the server recorded.
 *
 *  1. A figure must name a recorded call and a JSON pointer into its result, equal that number to the cent, and point at
 *     a path that has a known meaning (`describeFigure`). Failures are dropped and listed. Survivors show the tool's own
 *     number, with the unit and label the server derives from the path, never the model's.
 *  2. If `migrationBreakEven` ran, the recommendation and target cloud are its verdict (the best verdict when it ran
 *     more than once). If it never ran, the answer cannot recommend a move: `not_enough_data`.
 *  3. Any number (digits in any script, and number words) written in the headline, the explanation or a caveat that is
 *     not a surviving figure is removed. A verdict's reasons, written by code, may be quoted verbatim.
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

export type DroppedFigure = { label: string; call: string; path: string; reason: "unknown_call" | "call_failed" | "path_not_found" | "not_a_number" | "unsupported_path" | "mismatch" | "duplicate" };

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

// Digits in any script (\p{Nd}), so "４５" is a number too.
const NUMBER = /\$?\p{Nd}[\p{Nd},]*(?:\.\p{Nd}+)?%?/gu;
const ASCII_NUMBER = /^\$?[0-9][0-9,]*(?:\.[0-9]+)?$/;
// Number words. "one" is left alone in "one-time" and "one time", which the app's own wording uses.
const NUMBER_WORD = /\b(?:zero|one(?![- ]time)|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen)\b/gi;

/** Removes numbers (and number words) not in `allowed` (cents); text inside a `keep` string is left as written. */
export function stripNumbers(text: string, allowed: ReadonlySet<number>, keep: readonly string[]): { text: string; removed: number } {
  let removed = 0;
  const names = [...new Set(keep)].filter(Boolean).sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = names.length ? text.split(new RegExp(`(${names.join("|")})`)) : [text];
  const out = parts.map((part, i) => {
    if (names.length && i % 2 === 1) return part; // a kept name or reason
    return part
      .replace(NUMBER, (token) => {
        const value = Number(token.replace(/[$,]/g, ""));
        if (ASCII_NUMBER.test(token) && Number.isFinite(value) && allowed.has(cents(value))) return token;
        removed++;
        return "";
      })
      .replace(NUMBER_WORD, () => {
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

/**
 * App names the answer may repeat (they can hold digits): only from successful results, which exist in the footprint
 * because the tool looked them up. Never from arguments: a model could "name" an app 5000 to whitelist the number.
 */
function appNames(calls: readonly TraceCall[]): string[] {
  const names: string[] = [];
  for (const c of calls) {
    if (c.error || !isRecord(c.result)) continue;
    if (c.name === "getFootprint" && typeof c.result.name === "string") names.push(c.result.name);
    if (c.name === "migrationBreakEven" && typeof c.result.app === "string") names.push(c.result.app);
  }
  return names;
}

const CLOUD_NAME: Record<string, string> = { aws: "AWS", azure: "Azure", gcp: "Google Cloud", oci: "Oracle Cloud" };
const cloudName = (c: unknown) => (typeof c === "string" && Object.hasOwn(CLOUD_NAME, c) ? CLOUD_NAME[c] : undefined);

/**
 * What each figure path means: its unit and a label the server writes. Anything not listed (including per-unit rates
 * from getPrices) cannot be shown as a figure.
 */
export function describeFigure(call: TraceCall, path: string): { unit: AdviceOutput["figures"][number]["unit"]; label: string } | null {
  const r = isRecord(call.result) ? call.result : {};
  const parts = path.split("/").slice(1);
  if (call.name === "migrationBreakEven" && parts.length === 1) {
    switch (parts[0]) {
      case "monthlyFromUsd": return { unit: "per_month", label: `Monthly list cost on ${cloudName(r.from) ?? "the current cloud"}` };
      case "monthlyToUsd": return { unit: "per_month", label: `Monthly list cost on ${cloudName(r.to) ?? "the new cloud"}` };
      case "monthlySavingUsd": return { unit: "per_month", label: "Monthly saving from moving" };
      case "oneTimeUsd": return { unit: "one_time", label: "One-time cost of moving" };
      case "breakEvenMonths": return { unit: "months", label: "Months to pay it back" };
    }
  }
  if (call.name === "priceScenario" && parts.length === 3 && parts[0] === "clouds" && cloudName(parts[1])) {
    if (parts[2] === "listUsd") return { unit: "per_month", label: `Monthly list cost on ${cloudName(parts[1])}` };
    if (parts[2] === "netUsd") return { unit: "per_month", label: `Monthly cost on ${cloudName(parts[1])} after allowances` };
  }
  if (call.name === "getFootprint" && parts.length === 2 && parts[0] === "monthlyListUsd" && cloudName(parts[1])) {
    return { unit: "per_month", label: `Monthly list cost on ${cloudName(parts[1])}` };
  }
  return null;
}

export function checkAdvice(output: AdviceOutput, calls: readonly TraceCall[], opts: { trustedText?: boolean } = {}): { output: AdviceOutput; checks: AdviceChecks } {
  const byId = new Map(calls.map((c) => [c.id, c]));
  const dropped: DroppedFigure[] = [];
  const figures: AdviceOutput["figures"] = [];
  const seen = new Set<string>();

  for (const f of output.figures) {
    const drop = (reason: DroppedFigure["reason"]) => dropped.push({ label: f.label.slice(0, 60), call: f.call, path: f.path.slice(0, 80), reason });
    const call = byId.get(f.call);
    if (!call) drop("unknown_call");
    else if (call.error || call.result === null) drop("call_failed");
    else {
      const actual = resolvePointer(call.result, f.path);
      if (actual === undefined) drop("path_not_found");
      else if (typeof actual !== "number" || !Number.isFinite(actual)) drop("not_a_number");
      else {
        const meaning = describeFigure(call, f.path);
        if (!meaning) drop("unsupported_path");
        else if (cents(actual) !== cents(f.valueUsd)) drop("mismatch");
        else if (seen.has(`${f.call}${f.path}`)) drop("duplicate");
        else {
          seen.add(`${f.call}${f.path}`);
          // The tool's number, with the unit and label the server derives from the path: not the model's.
          figures.push({ ...f, valueUsd: Math.round(actual * 100) / 100, unit: meaning.unit, label: meaning.label });
        }
      }
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
  // A verdict's reasons ("within 6 months", "$10 a month") are the code's words: fine verbatim, not as a model's numbers.
  const keep = [...appNames(calls), ...verdicts.flatMap((v) => v.reasons)];
  let strippedNumbers = 0;
  const clean = (t: string) => {
    // A demo answer is written by code from the real results (never by a model), so its text is not stripped.
    if (opts.trustedText) return t;
    const r = stripNumbers(t, allowed, keep);
    strippedNumbers += r.removed;
    return r.text;
  };
  const headline = clean(output.headline) || "Scaling advice";
  const explanation = clean(output.explanation);
  const modelCaveats = output.caveats.map(clean).filter(Boolean);
  const caveats = [...new Set([...trustedCaveats, ...modelCaveats])].map((c) => c.slice(0, 160)).slice(0, 4);
  const labelled = figures; // labels are server-written

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
