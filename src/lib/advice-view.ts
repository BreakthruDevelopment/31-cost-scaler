import { z } from "zod";
import { adviceOutput, FIXED_HEADLINE } from "@/lib/advice-checks";
import { trimmed } from "@/lib/text";

/**
 * A stored `advice` row as the advisor screen renders it. `output` and `checks` are jsonb, so they are re-parsed
 * here rather than trusted: a row written by an older build (before `checks.figureAgents` or `checks.delegations`
 * existed) must still render, and a row written by a newer one must not be able to put a surprise shape on screen.
 *
 * Numbers come only from `output.figures`, which the server already proved equal to a recorded tool result
 * (`checkAdvice`). This module never computes, sums or rounds a figure: the screen shows what the tools returned.
 *
 * Pure: no database, no model, no server-only imports, so the client components can share the types.
 */

/** Drop reasons in the words a reader needs, not the code's enum. */
const DROP_REASON: Record<string, string> = {
  unknown_call: "it cited a tool call that never ran",
  call_failed: "the tool call it cited failed",
  path_not_found: "the value it cited is not in that tool's result",
  not_a_number: "the value it cited is not a number",
  unsupported_path: "that part of a tool result is not a figure we show",
  mismatch: "it did not match the tool's own number",
  duplicate: "it repeated a figure already shown",
};

/**
 * Each field falls back to "" on its own, so no length here can fail the item and empty the list: the caps match
 * what the write path already enforces (`adviceOutput`: label 60, path 80, call `c1`–`c9`) and `reason` is an enum.
 */
export const droppedFigure = z.object({
  label: z.string().max(60).catch(""),
  call: z.string().max(8).catch(""),
  path: z.string().max(80).catch(""),
  reason: z.string().max(40).catch(""),
});

/**
 * `agent` is trimmed, not capped: it was the one field here that could *reject* its item, and an item that fails
 * empties the whole `delegations` array through the `.catch([])` below. The card then drops its "Consulted: …"
 * line and silently presents a team answer as if one agent wrote it — the same shape as the drift bug this module's
 * sibling (`src/lib/admin-stats.ts`) was fixed for, and one specialist rename away from being real: `agent` is a
 * specialist's name from `src/lib/advisor.ts`, so renaming `pricing` to something over 40 characters would do it.
 */
export const delegation = z.object({
  agent: trimmed(40),
  llmCalls: z.number().catch(0),
  outcome: z.string().max(40).catch(""),
});

/**
 * Every field falls back on its own, so one surprise never blanks the card. The two array caps are deliberately
 * above what the write path can produce, so neither can empty its list in practice: `output.figures` is capped at
 * 8 by `adviceOutput`, and a dropped figure comes from one of those, so `droppedFigures` cannot reach 16; the
 * coordinator refuses a fourth delegation (`TEAM_MAX_DELEGATIONS = 3`), so `delegations` cannot reach 8. They stay
 * as caps rather than becoming trims because a list longer than the cap could only come from a hand-written row,
 * and dropping the overflow silently would understate the count the card prints.
 */
const checksShape = z
  .object({
    droppedFigures: z.array(droppedFigure).max(16).catch([]),
    strippedNumbers: z.number().int().nonnegative().catch(0),
    fixedAnswer: z.boolean().catch(false),
    verdictReplaced: z.boolean().catch(false),
    delegations: z.array(delegation).max(8).catch([]),
    // Trimmed, not capped: a long value would empty the whole record and attribute every figure to "Advisor".
    figureAgents: z.record(z.string(), trimmed(40)).catch({}),
    engine: z.string().max(20).nullable().catch(null),
  })
  .partial()
  .catch({});

export type AdviceChecksView = {
  droppedFigures: { label: string; call: string; path: string; reason: string; why: string }[];
  strippedNumbers: number;
  fixedAnswer: boolean;
  verdictReplaced: boolean;
  delegations: { agent: string; llmCalls: number; outcome: string }[];
  figureAgents: Record<string, string>;
  engine: string | null;
};

export type AdviceView = {
  id: string;
  createdAt: string;
  demo: boolean;
  question: string;
  appName: string | null;
  output: z.infer<typeof adviceOutput>;
  checks: AdviceChecksView;
};

/** The answer the screen shows when even the output column cannot be parsed: honest, and never a blank card. */
export const UNREADABLE_OUTPUT: z.infer<typeof adviceOutput> = {
  headline: FIXED_HEADLINE,
  recommendation: "not_enough_data",
  targetCloud: null,
  figures: [],
  explanation: "This answer could not be read back. Ask again, or use the computed tables on the footprint and price pages.",
  caveats: [],
};

export const AGENT_LABEL: Record<string, string> = { pricing: "Pricing agent", migration: "Migration agent" };

/** "Pricing agent · c2" for a figure a specialist produced, "Advisor · c2" when a single agent answered. */
export function figureSource(call: string, figureAgents: Record<string, string>): string {
  const agent = figureAgents[call];
  return `${agent ? (AGENT_LABEL[agent] ?? agent) : "Advisor"} · ${call}`;
}

export function toAdviceView(row: {
  id: string;
  createdAt: Date | string;
  demo: boolean;
  question: string;
  appName: string | null;
  output: unknown;
  checks: unknown;
}): AdviceView {
  const parsedOutput = adviceOutput.safeParse(row.output);
  const c = checksShape.parse(row.checks) ?? {};
  return {
    id: row.id,
    createdAt: (row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt)).toISOString(),
    demo: row.demo,
    question: row.question,
    appName: row.appName,
    output: parsedOutput.success ? parsedOutput.data : UNREADABLE_OUTPUT,
    checks: {
      droppedFigures: (c.droppedFigures ?? []).map((d) => ({ ...d, why: DROP_REASON[d.reason] ?? "it could not be checked against a tool result" })),
      strippedNumbers: c.strippedNumbers ?? 0,
      fixedAnswer: c.fixedAnswer ?? false,
      verdictReplaced: c.verdictReplaced ?? false,
      delegations: (c.delegations ?? []).map((d) => ({ agent: d.agent, llmCalls: d.llmCalls ?? 0, outcome: d.outcome ?? "" })),
      figureAgents: c.figureAgents ?? {},
      engine: c.engine ?? null,
    },
  };
}
