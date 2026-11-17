import { describe, expect, it } from "vitest";
import { FIXED_HEADLINE } from "@/lib/advice-checks";
import { UNREADABLE_OUTPUT, figureSource, toAdviceView } from "@/lib/advice-view";

const output = {
  headline: "Moving helpdesk pays back quickly",
  recommendation: "move" as const,
  targetCloud: "gcp" as const,
  figures: [{ label: "Monthly saving from moving", valueUsd: 12.5, unit: "per_month" as const, call: "c2", path: "/monthlySavingUsd" }],
  explanation: "The saving covers the effort.",
  caveats: ["List prices only."],
};

const row = (over: Partial<Parameters<typeof toAdviceView>[0]> = {}) => ({
  id: "a1",
  createdAt: new Date("2026-11-16T10:00:00Z"),
  demo: false,
  question: "Should helpdesk move?",
  appName: "helpdesk",
  output,
  checks: {},
  ...over,
});

describe("toAdviceView", () => {
  it("renders a row written before figureAgents and delegations existed", () => {
    // The screen must not need the newer checks fields: 31.7 merges before 31.12.
    const view = toAdviceView(row({ checks: { droppedFigures: [], strippedNumbers: 0 } }));
    expect(view.output.headline).toBe(output.headline);
    expect(view.checks.delegations).toEqual([]);
    expect(view.checks.figureAgents).toEqual({});
    expect(view.checks.engine).toBeNull();
  });

  it("survives a checks column that is null, a string or the wrong shape", () => {
    for (const checks of [null, "nonsense", 42, { droppedFigures: "no", delegations: { nope: 1 } }]) {
      const view = toAdviceView(row({ checks }));
      expect(view.checks.droppedFigures).toEqual([]);
      expect(view.checks.delegations).toEqual([]);
    }
  });

  it("falls back to an honest card when the stored output cannot be parsed", () => {
    const view = toAdviceView(row({ output: { headline: "" } }));
    expect(view.output).toEqual(UNREADABLE_OUTPUT);
    expect(view.output.headline).toBe(FIXED_HEADLINE);
    expect(view.output.figures).toEqual([]);
  });

  it("keeps the dropped figures and explains each reason in words", () => {
    const view = toAdviceView(
      row({ checks: { droppedFigures: [{ label: "Saving", call: "c3", path: "/x", reason: "mismatch" }], strippedNumbers: 2 } }),
    );
    expect(view.checks.droppedFigures).toHaveLength(1);
    expect(view.checks.droppedFigures[0].why).toContain("did not match");
    expect(view.checks.strippedNumbers).toBe(2);
  });

  it("explains a reason code it has never seen, rather than showing the bare code", () => {
    const view = toAdviceView(row({ checks: { droppedFigures: [{ label: "x", call: "c1", path: "/y", reason: "brand_new_reason" }] } }));
    expect(view.checks.droppedFigures[0].why).toBe("it could not be checked against a tool result");
  });

  it("reads the delegations the server recorded", () => {
    const view = toAdviceView(
      row({ checks: { delegations: [{ agent: "pricing", llmCalls: 2, outcome: "ok" }, { agent: "migration", llmCalls: 1, outcome: "ok" }] } }),
    );
    expect(view.checks.delegations.map((d) => d.agent)).toEqual(["pricing", "migration"]);
  });

  it("does not show any number the output did not carry", () => {
    const view = toAdviceView(row());
    expect(view.output.figures).toEqual(output.figures);
  });
});

describe("figureSource", () => {
  it("names the specialist the server attributed the call to, with the call id", () => {
    expect(figureSource("c2", { c2: "pricing" })).toBe("Pricing agent · c2");
    expect(figureSource("c4", { c4: "migration" })).toBe("Migration agent · c4");
  });
  it("says Advisor when a single agent answered, and passes an unknown agent through", () => {
    expect(figureSource("c1", {})).toBe("Advisor · c1");
    expect(figureSource("c1", { c1: "forecasting" })).toBe("forecasting · c1");
  });
});
