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
