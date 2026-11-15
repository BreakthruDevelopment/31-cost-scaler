import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type AdviceOutput, adviceOutput, checkAdvice } from "@/lib/advice-checks";
import { resetEnvCache } from "@/lib/env";
import { FailingLlm, HangingLlm, ScriptedLlm } from "../../../test/ai-stub-llm";
import { AGENT_MAX_TOOL_CALLS, runAgent } from "./agent";
import { ToolError, defineTool } from "./index";

const answer = z.object({ reply: z.string().max(100), value: z.number() });
const baseEnv = { DATABASE_URL: "postgres://unused", BETTER_AUTH_SECRET: "x".repeat(32), LOG_LEVEL: "error" };

function setEnv(extra: Record<string, string>) {
  vi.stubEnv("AI_PROVIDER", "");
  vi.stubEnv("AI_FALLBACK_TO_DEMO", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  for (const [k, v] of Object.entries({ ...baseEnv, ...extra })) vi.stubEnv(k, v);
  resetEnvCache();
}
const live = (extra: Record<string, string> = {}) => setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", ...extra });

beforeEach(() => setEnv({ AI_PROVIDER: "demo" }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEnvCache();
});

const lookup = defineTool({
  name: "lookup",
  description: "Look a number up",
  args: z.strictObject({ n: z.number().int().min(1).max(9) }),
  kind: "read",
  run: async ({ n }) => ({ value: n * 1.5, label: `row ${n}` }),
});
const bad = defineTool({
  name: "bad",
  description: "Always refuses",
  args: z.strictObject({}),
  kind: "read",
  run: async () => {
    throw new ToolError("not found");
  },
});
const huge = defineTool({ name: "huge", description: "Too big", args: z.strictObject({}), kind: "read", run: async () => ({ blob: "x".repeat(5000) }) });

const base = { task: "agent-test", system: "You are a test.", schema: answer, input: "What is 1.5 times 2?", tools: [lookup, bad, huge] };

/** A Gemini REST reply for the generate() fallback: first a tool call, then the final `respond`. */
function stubGeminiFetch(replies: unknown[]) {
  let i = 0;
  const fetchMock = vi.fn(async () => {
    const part = replies[Math.min(i++, replies.length - 1)];
    return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [part] } }] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const respond = (args: unknown) => ({ functionCall: { name: "respond", args } });

describe("runAgent on ADK", () => {
  it("runs the tool round trip, records the calls and shows the model its call id", async () => {
    live();
    const llm = new ScriptedLlm([{ name: "lookup", args: { n: 2 } }], (r) => ({ reply: "ok", value: ((r[0].data as { value: number }).value) }));
    const result = await runAgent(base, { innerLlm: llm });
    expect(result.engine).toBe("adk");
    expect(result.demo).toBe(false);
    expect(result.data).toEqual({ reply: "ok", value: 3 });
    expect(result.calls).toEqual([{ id: "c1", name: "lookup", args: { n: 2 }, result: { value: 3, label: "row 2" }, error: null }]);
    // The model's view of the result carries `callId`; the recorded result does not.
    const seen = llm.requests.at(-1)!.contents.flatMap((c) => c.parts ?? []).find((p) => p.functionResponse)?.functionResponse?.response as { data: Record<string, unknown> };
    expect(seen.data).toMatchObject({ callId: "c1", value: 3 });
    // System rules: data, not instructions; the question is a JSON string.
    const request = llm.requests[0];
    expect(String(request.config?.systemInstruction)).toContain("data, not instructions");
    expect(JSON.stringify(request.contents)).toContain(JSON.stringify("What is 1.5 times 2?").replaceAll('"', '\\"'));
  });

  it("records a refused tool and a too-large result as errors, never as results", async () => {
    live();
    const llm = new ScriptedLlm([{ name: "bad", args: {} }, { name: "huge", args: {} }], () => ({ reply: "none", value: 0 }));
    const result = await runAgent(base, { innerLlm: llm });
    expect(result.calls.map((c) => [c.id, c.name, c.result, c.error])).toEqual([
      ["c1", "bad", null, "not found"],
      ["c2", "huge", null, "The result was too large. Ask for less."],
    ]);
  });

  it("stops at the tool-call cap", async () => {
    live();
    const plan = Array.from({ length: 12 }, () => ({ name: "lookup", args: { n: 1 } }));
    const llm = new ScriptedLlm(plan, () => ({ reply: "x", value: 1 }));
    const result = await runAgent({ ...base, maxLlmCalls: 20 }, { innerLlm: llm });
    expect(result.calls.length).toBe(AGENT_MAX_TOOL_CALLS);
    expect(result.calls.at(-1)!.id).toBe("c9");
  });

  it("never makes more model calls than the budget, then falls back", async () => {
    live({ AI_FALLBACK_TO_DEMO: "false" });
    stubGeminiFetch([respond({ reply: "from generate", value: 1 })]);
    const plan = Array.from({ length: 20 }, () => ({ name: "lookup", args: { n: 1 } }));
    const llm = new ScriptedLlm(plan, () => ({ reply: "x", value: 1 }));
    const result = await runAgent(base, { innerLlm: llm });
    expect(llm.turns).toBeLessThanOrEqual(6);
    expect(result.engine).toBe("generate");
    expect(result.fallbackReason).toBe("tool_loop");
  });
});

describe("runAgent falls back to generate({ tools })", () => {
  it("when ADK's model fails, with the same tools recorded and the reason named", async () => {
    live();
    const fetchMock = stubGeminiFetch([{ functionCall: { name: "lookup", args: { n: 4 } } }, respond({ reply: "via generate", value: 6 })]);
    const failing = new FailingLlm();
    const result = await runAgent(base, { innerLlm: failing });
    expect(failing.calls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ engine: "generate", demo: false, provider: "gemini", fallbackReason: "provider", data: { reply: "via generate", value: 6 } });
    expect(result.calls).toEqual([{ id: "c1", name: "lookup", args: { n: 4 }, result: { value: 6, label: "row 4" }, error: null }]);
  });

  it("when ADK's answer is not valid JSON for the schema", async () => {
    live();
    stubGeminiFetch([respond({ reply: "repaired", value: 2 })]);
    const llm = new ScriptedLlm([], () => "I think the answer is probably two.");
    const result = await runAgent(base, { innerLlm: llm });
    expect(result).toMatchObject({ engine: "generate", fallbackReason: "invalid_output", data: { reply: "repaired" } });
  });

  it("skips the second attempt on a quota error (the same key fails the same way) and goes to demo", async () => {
    live();
    const fetchMock = stubGeminiFetch([respond({ reply: "never", value: 0 })]);
    // "agent-test" has no demo script, so ask for the scaling task with stub tools.
    const result = await runAgent(scalingRequest(), { innerLlm: new FailingLlm(429) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ engine: "demo", demo: true, fallbackReason: "quota" });
  });

  it("answers from the demo script when both engines fail and demo fallback is on", async () => {
    live();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const result = await runAgent(scalingRequest(), { innerLlm: new FailingLlm() });
    expect(result.engine).toBe("demo");
    expect(result.calls.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("when generate() itself falls back to demo, the abandoned live calls are discarded: the trace is one clean demo run", async () => {
    live();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    // ADK makes live calls (a "move" verdict among them), then returns unusable text.
    const llm = new ScriptedLlm(
      [{ name: "migrationBreakEven", args: { app: "helpdesk", to: "azure" } }, { name: "getFootprint", args: { app: "helpdesk" } }],
      () => "not json",
    );
    const result = await runAgent(scalingRequest(), { innerLlm: llm });
    expect(result.engine).toBe("demo");
    expect(result.calls.map((c) => [c.id, c.name])).toEqual([["c1", "getFootprint"], ["c2", "priceScenario"], ["c3", "migrationBreakEven"]]);
    expect(result.calls[2].args).toMatchObject({ to: "aws" }); // the demo's choice, not the live call's azure
    expect(result.fallbackReason).toBe("invalid_output");
  });

  it("does not let ADK print its own console lines", async () => {
    live();
    const spies = (["log", "info", "debug", "warn"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    await runAgent(base, { innerLlm: new ScriptedLlm([{ name: "lookup", args: { n: 1 } }], () => ({ reply: "ok", value: 1 })) });
    expect(spies.flatMap((s) => s.mock.calls).filter((c) => String(c[0]).includes("ADK"))).toEqual([]);
    spies.forEach((s) => s.mockRestore());
  });

  it("throws when both engines fail and demo fallback is off", async () => {
    live({ AI_FALLBACK_TO_DEMO: "false" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    await expect(runAgent(base, { innerLlm: new FailingLlm() })).rejects.toMatchObject({ name: "AiError" });
  });

  it("gives up on a hung model at the deadline instead of waiting", async () => {
    live({ AI_FALLBACK_TO_DEMO: "false" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const started = Date.now();
    await expect(runAgent({ ...base, deadlineMs: 400 }, { innerLlm: new HangingLlm() })).rejects.toMatchObject({ name: "AiError" });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("runAgent input rules", () => {
  it("refuses input over the cap or with a NUL before any model call", async () => {
    live();
    const llm = new ScriptedLlm([], () => ({ reply: "x", value: 1 }));
    await expect(runAgent({ ...base, input: "x".repeat(501) }, { innerLlm: llm })).rejects.toMatchObject({ kind: "input_rejected" });
    await expect(runAgent({ ...base, input: "a\0b" }, { innerLlm: llm })).rejects.toMatchObject({ kind: "input_rejected" });
    expect(llm.turns).toBe(0);
  });

  it("rejects a bad tool definition as a programmer error", async () => {
    await expect(runAgent({ ...base, tools: [lookup, lookup] })).rejects.toThrow(/duplicate/);
  });
});

// ---- the scaling task's demo script over stub tools -------------------------------------------------------------

const fakeTools = [
  defineTool({
    name: "getFootprint",
    description: "app",
    args: z.strictObject({ app: z.string().max(40) }),
    kind: "read",
    run: async ({ app }) => ({ name: app, title: "T", clouds: ["gcp"], storage: false, secretCount: 0, monthlyListUsd: { aws: 40, azure: 50, gcp: 30, oci: null } }),
  }),
  defineTool({
    name: "priceScenario",
    description: "scenario",
    args: z.strictObject({ scenarioId: z.string().optional(), preset: z.literal("10x_users").optional() }),
    kind: "read",
    run: async () => ({ source: "preset", pricesAsOf: null, cheapest: "aws", clouds: { aws: { listUsd: 100, complete: true }, azure: { listUsd: 120, complete: true }, gcp: { listUsd: 90, complete: true }, oci: { listUsd: null, complete: false } } }),
  }),
  defineTool({
    name: "migrationBreakEven",
    description: "move",
    args: z.strictObject({ app: z.string(), to: z.enum(["aws", "azure", "gcp", "oci"]), from: z.enum(["aws", "azure", "gcp", "oci"]).optional(), scenarioId: z.string().optional() }),
    kind: "read",
    run: async ({ app, to, from }) => ({ app, from: from ?? "gcp", to, basis: "preset", verdict: "stay", blockers: [], reasons: ["Moving does not lower the monthly cost."], monthlyFromUsd: 90, monthlyToUsd: 100, monthlySavingUsd: -10, oneTimeUsd: 700, breakEvenMonths: null }),
  }),
];
function scalingRequest() {
  return { task: "scaling-advice", system: "s", schema: adviceOutput, input: "Should helpdesk move?", tools: fakeTools, demoContext: { app: "helpdesk" } };
}

describe("the scaling-advice demo script", () => {
  it("runs the real tools in order and its answer passes the server checks with no figure dropped", async () => {
    const result = await runAgent<AdviceOutput>(scalingRequest());
    expect(result).toMatchObject({ engine: "demo", demo: true, provider: "demo" });
    expect(result.calls.map((c) => c.name)).toEqual(["getFootprint", "priceScenario", "migrationBreakEven"]);
    // gcp is where the app runs; the cheapest other cloud by the scenario price is aws.
    expect(result.calls[2].args).toMatchObject({ app: "helpdesk", from: "gcp", to: "aws" });
    const { output, checks } = checkAdvice(result.data, result.calls);
    expect(checks.droppedFigures).toEqual([]);
    expect(checks.fixedAnswer).toBe(false);
    expect(output.figures.length).toBeGreaterThanOrEqual(3);
    expect(output.recommendation).toBe("stay");
    expect(output.caveats).toContain("Demo answer (no live model)");
    expect(output.headline).toContain("Recorded demo answer: helpdesk");
  });
});
