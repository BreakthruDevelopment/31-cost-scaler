import type * as Adk from "@google/adk";
import { z } from "zod";
import { type Delegation, type TraceCall, describeFigure, resolvePointer, stripNumbers } from "@/lib/advice-checks";
import { extractJson } from "./index";
import { TOOL_RULES } from "./tools";
import { type AnyToolDef, AiError, type DemoToolResult } from "./types";
import { demoTeamScripts } from "./demo";

/**
 * An ADK team inside `runAgent()`: a coordinator that delegates to specialists wrapped as `AgentTool`s, then writes the
 * answer. Everything a specialist says is data. Before the coordinator reads a reply, `afterToolCallback` parses it,
 * drops findings the specialist did not earn, and re-reads each surviving number from the recorded tool result itself.
 * After the coordinator answers, `teamFigureGate` drops any figure that is not one of those findings. Then the app's own
 * checks (`checkAdvice`) run unchanged. Nothing here can show a number a tool did not return.
 *
 * Why `AgentTool` and not sub-agent transfer: the coordinator keeps control and writes the answer; a specialist gets a
 * structured request, not the user's words; its reply is a function response we can check; no transfer loops.
 * ADK 2.5.0 starts a specialist's `Runner` without the parent's `RunConfig`, so `maxLlmCalls` does not reach it: one
 * shared `GatewayLlm` counter (agent.ts) caps every agent's model calls instead.
 */

export const TEAM_MAX_DELEGATIONS = 3;

export type SpecialistSpec = { name: string; description: string; instruction: string; tools: AnyToolDef[] };

export type TeamSpec = {
  /** The coordinator's own system text (it writes the answer). */
  coordinatorSystem: string;
  specialists: SpecialistSpec[];
  /** The structured request a specialist receives. */
  inputSchema: z.ZodObject;
  /** The JSON a specialist replies with. */
  reportSchema: z.ZodType<{ summary: string; findings: { call: string; path: string; note: string }[]; gaps: string[] }>;
};

/** A finding after the server resolved it: the tool's own number, with the unit and label the server wrote. */
export type Finding = { call: string; path: string; valueUsd: number; unit: string; label: string };
export type ReportDrop = { agent: string; call: string; path: string; reason: "not_made" | "path_not_found" | "not_a_number" | "unsupported_path" | "duplicate" };
export type TeamDrop = { label: string; call: string; path: string; reason: "not_reported" };

/** Per-run state shared by the callbacks. Never taken from a model. */
export type TeamState = {
  delegations: Delegation[];
  /** `${call}${path}` of every finding that reached the coordinator. */
  reported: Map<string, Finding>;
  reportDrops: ReportDrop[];
  started: number;
  pending: { agent: string; startCall: number; startLlm: number } | null;
};

export const newTeamState = (): TeamState => ({ delegations: [], reported: new Map(), reportDrops: [], started: 0, pending: null });

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const noNumbers = (text: string) => stripNumbers(text, new Set(), []).text;

/**
 * A specialist's reply, parsed and rewritten. Returns null for a reply that is not a valid report. Findings must cite a
 * call this specialist made that did not fail, and a path that is a finite number with a known meaning; each survivor is
 * read from the recorded result. Digits and number words are removed from the prose, so numbers reach the coordinator
 * only as findings.
 */
export function screenReport(
  reply: unknown,
  agent: string,
  calls: readonly TraceCall[],
  reportSchema: TeamSpec["reportSchema"],
): { report: { summary: string; findings: Finding[]; gaps: string[] }; drops: ReportDrop[] } | null {
  if (typeof reply !== "string") return null;
  let parsed;
  try {
    parsed = reportSchema.safeParse(extractJson(reply));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  const byId = new Map(calls.filter((c) => c.agent === agent && !c.error && c.result !== null).map((c) => [c.id, c]));
  const drops: ReportDrop[] = [];
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const f of parsed.data.findings) {
    const drop = (reason: ReportDrop["reason"]) => drops.push({ agent, call: f.call, path: f.path.slice(0, 80), reason });
    const call = byId.get(f.call);
    if (!call) {
      drop("not_made");
      continue;
    }
    const actual = resolvePointer(call.result, f.path);
    if (actual === undefined) drop("path_not_found");
    else if (typeof actual !== "number" || !Number.isFinite(actual)) drop("not_a_number");
    else {
      const meaning = describeFigure(call, f.path);
      if (!meaning) drop("unsupported_path");
      else if (seen.has(`${f.call}${f.path}`)) drop("duplicate");
      else {
        seen.add(`${f.call}${f.path}`);
        findings.push({ call: f.call, path: f.path, valueUsd: Math.round(actual * 100) / 100, unit: meaning.unit, label: meaning.label });
      }
    }
  }
  return { report: { summary: noNumbers(parsed.data.summary), findings, gaps: parsed.data.gaps.map(noNumbers) }, drops };
}

/** Drops every figure of the coordinator's answer that is not one of the findings a specialist reported. */
export function teamFigureGate<T>(data: T, reported: ReadonlyMap<string, unknown>): { data: T; dropped: TeamDrop[] } {
  if (!isRecord(data) || !Array.isArray(data.figures)) return { data, dropped: [] };
  const dropped: TeamDrop[] = [];
  const kept = data.figures.filter((f: unknown) => {
    if (isRecord(f) && typeof f.call === "string" && typeof f.path === "string" && reported.has(`${f.call}${f.path}`)) return true;
    dropped.push({ label: isRecord(f) && typeof f.label === "string" ? f.label.slice(0, 60) : "", call: isRecord(f) ? String(f.call).slice(0, 8) : "", path: isRecord(f) ? String(f.path).slice(0, 80) : "", reason: "not_reported" });
    return false;
  });
  return { data: { ...data, figures: kept } as T, dropped };
}

type BuildCtx = {
  llm: Adk.BaseLlm & { calls: number };
  spec: TeamSpec;
  state: TeamState;
  recorded: () => readonly TraceCall[];
  /** The coordinator's full instruction (system text, tool rules, answer schema). */
  coordinatorInstruction: string;
  /** Function tools for one specialist, recorded under its name. */
  functionTools: (tools: AnyToolDef[], agent: string) => Adk.FunctionTool[];
  generateContentConfig: (maxOutputTokens: number) => Adk.LlmAgentConfig["generateContentConfig"];
  maxOutputTokens: number;
};

function specialistInstruction(spec: SpecialistSpec, reportSchema: TeamSpec["reportSchema"]): string {
  const js = z.toJSONSchema(reportSchema, { target: "draft-7", io: "input", unrepresentable: "throw" }) as Record<string, unknown>;
  delete js.$schema;
  return [spec.instruction, "", ...TOOL_RULES, "- Reply with ONLY a JSON object that matches this JSON Schema:", JSON.stringify(js)].join("\n");
}

/** The coordinator, with each specialist wrapped as an `AgentTool`. No agent has `subAgents`, and none may transfer. */
export function buildTeamAgent(adk: typeof Adk, ctx: BuildCtx): Adk.LlmAgent {
  const { spec, state, llm } = ctx;
  const names = new Set(spec.specialists.map((s) => s.name));
  const specialistTools = spec.specialists.map((s) => {
    const agent = new adk.LlmAgent({
      name: s.name,
      description: s.description,
      model: llm,
      instruction: specialistInstruction(s, spec.reportSchema),
      tools: ctx.functionTools(s.tools, s.name),
      inputSchema: spec.inputSchema,
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
      generateContentConfig: ctx.generateContentConfig(700),
    });
    return new adk.AgentTool({ agent });
  });

  return new adk.LlmAgent({
    name: "coordinator",
    model: llm,
    instruction: ctx.coordinatorInstruction,
    tools: specialistTools,
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
    generateContentConfig: ctx.generateContentConfig(ctx.maxOutputTokens),
    beforeToolCallback: ({ tool }) => {
      if (!names.has(tool.name)) return { error: "unknown_specialist" };
      if (state.started >= TEAM_MAX_DELEGATIONS) return { error: "delegation_limit", message: `At most ${TEAM_MAX_DELEGATIONS} delegations per question. Write the answer from the reports you have.` };
      state.started++;
      state.pending = { agent: tool.name, startCall: ctx.recorded().length, startLlm: llm.calls };
      return undefined;
    },
    afterToolCallback: ({ tool, response }) => {
      const pending = state.pending;
      state.pending = null;
      // A refused delegation (limit) never started: leave its reply as it is.
      if (!pending || pending.agent !== tool.name) return undefined;
      const calls = ctx.recorded();
      const delegation: Delegation = {
        agent: pending.agent,
        callIds: calls.slice(pending.startCall).filter((c) => c.agent === pending.agent).map((c) => c.id),
        llmCalls: llm.calls - pending.startLlm,
        outcome: "ok",
      };
      let out: Record<string, unknown>;
      if (response.error !== undefined) {
        // ADK's own message could echo the model's arguments: the coordinator only learns that it failed.
        delegation.outcome = "error";
        out = { specialist: pending.agent, error: "delegation_failed" };
      } else {
        const screened = screenReport(response.result, pending.agent, calls, spec.reportSchema);
        if (!screened) {
          delegation.outcome = "invalid_report";
          out = { specialist: pending.agent, error: "invalid_report" };
        } else {
          for (const f of screened.report.findings) state.reported.set(`${f.call}${f.path}`, f);
          state.reportDrops.push(...screened.drops);
          if (state.reportDrops.length > 20) state.reportDrops.length = 20;
          out = { specialist: pending.agent, report: screened.report };
        }
      }
      state.delegations.push(delegation);
      return out;
    },
  });
}

/**
 * Demo mode for a team: `demoTeamScripts[task]` runs each delegation's tool calls in order over the real tools, each call
 * recorded with its specialist and each delegation recorded, then `final` writes the answer from the results. No model is
 * involved, so `llmCalls` is 0.
 */
export async function runDemoTeam<T>(opts: {
  task: string;
  spec: TeamSpec;
  schema: z.ZodType<T>;
  demoContext: unknown;
  deadlineAt: number;
  /** The tools of one specialist, recorded under its name (agent.ts `recordTools`). */
  wrap: (tools: AnyToolDef[], agent: string) => AnyToolDef[];
  recorded: () => readonly TraceCall[];
}): Promise<{ data: T; delegations: Delegation[]; steps: number }> {
  const makeScript = demoTeamScripts[opts.task];
  if (!makeScript) throw new Error(`No demo team script for AI task "${opts.task}". Add one to demoTeamScripts in src/lib/ai/demo.ts.`);
  const script = makeScript(opts.demoContext);
  const signal = AbortSignal.timeout(Math.max(1, opts.deadlineAt - Date.now()));
  const results: DemoToolResult[] = [];
  const delegations: Delegation[] = [];
  const timedOut = () => new AiError("The demo ran out of time", "tool_loop", "timeout");
  // A tool that ignores the signal (a stalled database call) must not hold the request open: race it against the deadline.
  const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(timedOut()), { once: true }));
  aborted.catch(() => undefined);
  for (const d of script.delegations) {
    const specialist = opts.spec.specialists.find((s) => s.name === d.agent);
    if (!specialist) throw new Error(`Demo team script names an unknown specialist "${d.agent}".`);
    const tools = new Map(opts.wrap(specialist.tools, d.agent).map((t) => [t.name, t]));
    const startCall = opts.recorded().length;
    for (const step of d.steps) {
      if (signal.aborted) throw timedOut();
      const call = typeof step.call === "function" ? step.call(results) : step.call;
      const tool = tools.get(call.name);
      const parsed = tool?.args.safeParse(call.args);
      if (!tool || !parsed?.success) {
        // A script that asks a specialist for a tool it does not hold is a programmer error, not a runtime failure.
        throw new Error(`Demo team script: "${call.name}" is not a valid call for the ${d.agent} specialist.`);
      }
      try {
        results.push({ name: call.name, ok: true, data: await Promise.race([tool.run(parsed.data, { signal }), aborted]) });
      } catch (err) {
        if (signal.aborted) throw err instanceof AiError ? err : timedOut();
        results.push({ name: call.name, ok: false, data: null }); // recorded with its (safe) error by the wrapper
      }
    }
    delegations.push({ agent: d.agent, callIds: opts.recorded().slice(startCall).map((c) => c.id), llmCalls: 0, outcome: "ok" });
  }
  const done = opts.schema.safeParse(script.final(results));
  if (!done.success) throw new AiError("Model output failed validation", "invalid_output");
  return { data: done.data, delegations, steps: results.length + 1 };
}
