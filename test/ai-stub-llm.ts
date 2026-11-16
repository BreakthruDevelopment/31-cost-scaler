// A stand-in for ADK's Gemini model, so agent tests and the stubbed evals run with no key and no network.
// Each model turn asks for the next planned tool call; when the plan is used up it answers with `final(results)`.
import { BaseLlm, type LlmRequest, type LlmResponse } from "@google/adk";

export type StubCall = { name: string; args: unknown };
/** What a tool returned to the model: `{ data }` or `{ error, message }`. */
export type StubResult = Record<string, unknown>;

export class ScriptedLlm extends BaseLlm {
  turns = 0;
  requests: LlmRequest[] = [];
  constructor(
    private readonly plan: StubCall[] | ((results: StubResult[]) => StubCall[]),
    private readonly final: (results: StubResult[]) => unknown,
  ) {
    super({ model: "stub-model" });
  }
  private results(req: LlmRequest): StubResult[] {
    return req.contents.flatMap((c) => (c.parts ?? []).flatMap((p) => (p.functionResponse?.response ? [p.functionResponse.response as StubResult] : [])));
  }
  async *generateContentAsync(req: LlmRequest): AsyncGenerator<LlmResponse, void> {
    this.requests.push(structuredClone({ ...req, toolsDict: {} }));
    const results = this.results(req);
    const plan = typeof this.plan === "function" ? this.plan(results) : this.plan;
    const turn = this.turns++;
    if (turn < plan.length) {
      yield { content: { role: "model", parts: [{ functionCall: { name: plan[turn].name, args: plan[turn].args as Record<string, unknown> } }] } };
      return;
    }
    const answer = this.final(results);
    yield { content: { role: "model", parts: [{ text: typeof answer === "string" ? answer : JSON.stringify(answer) }] } };
  }
  async connect(): Promise<never> {
    throw new Error("no live connection in tests");
  }
}

/** A model that always fails the way a provider does (`status` mirrors the SDK's ApiError). */
export class FailingLlm extends BaseLlm {
  calls = 0;
  constructor(private readonly status?: number) {
    super({ model: "stub-model" });
  }
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    this.calls++;
    // ADK reports a model failure as an event carrying only the error's text, so the text names the status like the SDK's does.
    throw new Error(this.status ? `stub provider failure: got status: ${this.status}. {"error":{"code":${this.status},"status":"RESOURCE_EXHAUSTED"}}` : "stub provider failure");
  }
  async connect(): Promise<never> {
    throw new Error("no live connection in tests");
  }
}

/** A model that never answers until aborted (for the deadline test). */
export class HangingLlm extends BaseLlm {
  constructor() {
    super({ model: "stub-model" });
  }
  async *generateContentAsync(_req: LlmRequest, _stream?: boolean, signal?: AbortSignal): AsyncGenerator<LlmResponse, void> {
    await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    yield {};
  }
  async connect(): Promise<never> {
    throw new Error("no live connection in tests");
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// A team: one model stand-in serving the coordinator, the two specialists and (after a failed team) the single agent.
// ---------------------------------------------------------------------------------------------------------------------

export type TeamRole = "coordinator" | "pricing" | "migration" | "single";
/** One model turn: ask for a tool (a delegation, for the coordinator) or say something (the final text). */
export type TeamTurn = { call: StubCall } | { say: string | object | ((results: StubResult[]) => unknown) } | { throws: Error };
/** A role's turns in order, or a function of the turn number (for loops). After the last turn the role repeats it. */
export type TeamScript = TeamTurn[] | ((turn: number, results: StubResult[]) => TeamTurn);

export function roleOf(req: LlmRequest): TeamRole {
  const system = String(req.config?.systemInstruction ?? "");
  if (system.includes("You are the coordinator")) return "coordinator";
  if (system.includes("You are the pricing specialist")) return "pricing";
  if (system.includes("You are the migration specialist")) return "migration";
  return "single";
}

export class TeamScriptedLlm extends BaseLlm {
  /** Every request, with the role that made it. */
  requests: { role: TeamRole; request: LlmRequest }[] = [];
  private turns: Record<TeamRole, number> = { coordinator: 0, pricing: 0, migration: 0, single: 0 };
  constructor(
    private readonly scripts: Partial<Record<TeamRole, TeamScript>>,
    private readonly delayMs = 0,
  ) {
    super({ model: "stub-model" });
  }
  count(role: TeamRole): number {
    return this.requests.filter((r) => r.role === role).length;
  }
  async *generateContentAsync(req: LlmRequest): AsyncGenerator<LlmResponse, void> {
    const role = roleOf(req);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    this.requests.push({ role, request: structuredClone({ ...req, toolsDict: {} }) });
    const results = req.contents.flatMap((c) => (c.parts ?? []).flatMap((p) => (p.functionResponse?.response ? [p.functionResponse.response as StubResult] : [])));
    const script = this.scripts[role] ?? [{ say: {} }];
    const turn = this.turns[role]++;
    const t: TeamTurn = typeof script === "function" ? script(turn, results) : script[Math.min(turn, script.length - 1)];
    if ("throws" in t) throw t.throws;
    if ("call" in t) {
      yield { content: { role: "model", parts: [{ functionCall: { name: t.call.name, args: t.call.args as Record<string, unknown> } }] } };
      return;
    }
    const said = typeof t.say === "function" ? t.say(results) : t.say;
    yield { content: { role: "model", parts: [{ text: typeof said === "string" ? said : JSON.stringify(said) }] } };
  }
  async connect(): Promise<never> {
    throw new Error("no live connection in tests");
  }
}

/** A 429 the way Gemini's SDK words it, with a per-minute or a per-day quota id. */
export function quotaError(scope: "minute" | "day"): Error {
  const id = scope === "day" ? "GenerateRequestsPerDayPerProjectPerModel-FreeTier" : "GenerateRequestsPerMinutePerProjectPerModel-FreeTier";
  return Object.assign(new Error(`got status: 429. {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"violations":[{"quotaId":"${id}"}]}]}}`), { status: 429 });
}

/** A specialist's reply as the JSON text it would send. */
export const reportText = (findings: { call: string; path: string; note?: string }[], summary = "Looked at the tool results.", gaps: string[] = []) =>
  JSON.stringify({ summary, findings: findings.map((f) => ({ note: "figure", ...f })), gaps });
