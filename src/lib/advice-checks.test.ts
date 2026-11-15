import { describe, expect, it } from "vitest";
import { type AdviceOutput, type TraceCall, FIXED_HEADLINE, NO_MOVE_ANALYSIS_CAVEAT, checkAdvice, resolvePointer, stripNumbers } from "./advice-checks";

const move = (over: Record<string, unknown> = {}): TraceCall => ({
  id: "c1",
  name: "migrationBreakEven",
  args: { app: "helpdesk", to: "aws" },
  error: null,
  result: {
    app: "helpdesk", from: "gcp", to: "aws", basis: "preset", verdict: "consider", blockers: [],
    reasons: ["Pays back in more than 6 and at most 18 months."], monthlyFromUsd: 120.5, monthlyToUsd: 80.25, monthlySavingUsd: 40.25, oneTimeUsd: 500, breakEvenMonths: 12.42, ...over,
  },
});

const answer = (over: Partial<AdviceOutput> = {}): AdviceOutput => ({
  headline: "Helpdesk could move",
  recommendation: "consider",
  targetCloud: "aws",
  figures: [{ label: "Monthly cost on AWS", valueUsd: 80.25, unit: "per_month", call: "c1", path: "/monthlyToUsd" }],
  explanation: "It is cheaper on AWS.",
  caveats: [],
  ...over,
});

describe("figures", () => {
  it("keeps a figure that equals the tool's number to the cent, and shows the tool's number", () => {
    const { output, checks } = checkAdvice(answer({ figures: [{ label: "Cost", valueUsd: 80.2500001, unit: "per_month", call: "c1", path: "/monthlyToUsd" }] }), [move()]);
    expect(output.figures).toEqual([{ label: "Monthly list cost on AWS", valueUsd: 80.25, unit: "per_month", call: "c1", path: "/monthlyToUsd" }]);
    expect(checks.droppedFigures).toEqual([]);
  });

  it.each([
    ["a number that is not the tool's", { call: "c1", path: "/monthlyToUsd", valueUsd: 0.01 }, "mismatch"],
    ["a call that never happened", { call: "c5", path: "/monthlyToUsd", valueUsd: 80.25 }, "unknown_call"],
    ["a path that is not in the result", { call: "c1", path: "/nope", valueUsd: 80.25 }, "path_not_found"],
    ["a path to text", { call: "c1", path: "/verdict", valueUsd: 80.25 }, "not_a_number"],
    ["an inherited property", { call: "c1", path: "/constructor", valueUsd: 80.25 }, "path_not_found"],
    ["a null number", { call: "c1", path: "/oneTimeUsd", valueUsd: 0 }, "mismatch"],
  ])("drops and lists %s", (_name, f, reason) => {
    const res = move({ oneTimeUsd: null });
    const { output, checks } = checkAdvice(answer({ figures: [{ label: "L", unit: "per_month", ...f }] }), [res]);
    expect(output.figures).toEqual([]);
    expect(checks.droppedFigures).toEqual([{ label: "L", call: f.call, path: f.path, reason: f.path === "/oneTimeUsd" ? "not_a_number" : reason }]);
  });

  it("drops a figure from a call that failed", () => {
    const failed: TraceCall = { id: "c2", name: "priceScenario", args: {}, result: null, error: "not found" };
    const { checks } = checkAdvice(answer({ figures: [{ label: "L", valueUsd: 1, unit: "per_month", call: "c2", path: "/x" }] }), [move(), failed]);
    expect(checks.droppedFigures[0].reason).toBe("call_failed");
  });
});

describe("the verdict comes from code", () => {
  it("replaces a recommendation and target that disagree", () => {
    const { output, checks } = checkAdvice(answer({ recommendation: "move", targetCloud: "oci" }), [move()]);
    expect(output).toMatchObject({ recommendation: "consider", targetCloud: "aws" });
    expect(checks).toMatchObject({ verdictReplaced: true, verdictCall: "c1" });
  });

  it("names no target for stay, blocked or not_enough_data", () => {
    const { output } = checkAdvice(answer({ targetCloud: "aws" }), [move({ verdict: "stay" })]);
    expect(output).toMatchObject({ recommendation: "stay", targetCloud: null });
  });

  it("adds the code's blocker reasons as caveats", () => {
    const reason = "This app uses object storage (storage: true), which runs only on Google Cloud.";
    const { output } = checkAdvice(answer({ recommendation: "move", caveats: ["Check later."] }), [move({ verdict: "blocked", blockers: [{ code: "object_storage_gcp_only", reason }], monthlyToUsd: 80.25 })]);
    expect(output.recommendation).toBe("blocked");
    expect(output.caveats[0]).toBe(reason);
  });

  it("with several analyses uses the best verdict", () => {
    const stay = { ...move({ verdict: "stay" }), id: "c1" };
    const mv = { ...move({ verdict: "move", to: "azure" }), id: "c2" };
    const { output, checks } = checkAdvice(answer(), [stay, mv]);
    expect(output).toMatchObject({ recommendation: "move", targetCloud: "azure" });
    expect(checks.verdictCall).toBe("c2");
  });

  it("without a move analysis a recommendation becomes not_enough_data, with a caveat", () => {
    const price: TraceCall = { id: "c1", name: "priceScenario", args: {}, error: null, result: { clouds: { aws: { listUsd: 10 } } } };
    const { output } = checkAdvice(answer({ recommendation: "move", figures: [{ label: "AWS", valueUsd: 10, unit: "per_month", call: "c1", path: "/clouds/aws/listUsd" }] }), [price]);
    expect(output).toMatchObject({ recommendation: "not_enough_data", targetCloud: null });
    expect(output.caveats).toContain(NO_MOVE_ANALYSIS_CAVEAT);
    expect(output.figures).toHaveLength(1);
  });
});

describe("stray numbers", () => {
  it("removes $999 from the explanation and the headline, and a figure's own number stays", () => {
    const { output, checks } = checkAdvice(
      answer({ headline: "AWS costs $0.01 a month", explanation: "It is $999 elsewhere but $80.25 on AWS, 12% less.", caveats: ["Save $5,000 a year."] }),
      [move()],
    );
    expect(output.headline).toBe("AWS costs a month");
    expect(output.explanation).toBe("It is elsewhere but $80.25 on AWS, less.");
    expect(output.caveats).toEqual(["Save a year."]);
    expect(checks.strippedNumbers).toBe(4);
    expect(JSON.stringify(output)).not.toMatch(/999|0\.01|5,000/);
  });

  it("lets the code's own reasons through verbatim, and app names (with digits) that a tool found", () => {
    const call = move({ app: "app-7x" });
    const reason = "Pays back in more than 6 and at most 18 months.";
    const { output } = checkAdvice(answer({ explanation: `app-7x: ${reason}` }), [call]);
    expect(output.explanation).toBe(`app-7x: ${reason}`);
    // the same numbers paraphrased are the model's, so they go
    expect(checkAdvice(answer({ explanation: "It pays back in 6 months." }), [call]).output.explanation).toBe("It pays back in months.");
  });

  it("an app name that only appears in an argument or a failed call does not whitelist a number", () => {
    const failed: TraceCall = { id: "c2", name: "getFootprint", args: { app: "5000" }, result: null, error: "not found" };
    const { output } = checkAdvice(answer({ explanation: "It saves $5000 a month, 5000 users." }), [move(), failed]);
    expect(output.explanation).toBe("It saves a month, users.");
    const forged = move();
    forged.args = { app: "5000", to: "aws" };
    expect(checkAdvice(answer({ explanation: "Saves $5000." }), [forged]).output.explanation).toBe("Saves.");
  });

  it("removes digits in any script and number words, but not the app's own 'one-time'", () => {
    const { output, checks } = checkAdvice(
      answer({ explanation: "Saves ４５ dollars, about forty-five or a dozen. The one-time cost is small.", headline: "Ten percent cheaper" }),
      [move()],
    );
    expect(output.explanation).toBe("Saves dollars, about - or a. The one-time cost is small.");
    expect(output.headline).toBe("percent cheaper");
    expect(checks.strippedNumbers).toBe(5);
  });

  it("leaves a demo answer's text (written by code) alone", () => {
    const { output } = checkAdvice(answer({ headline: "Recorded demo answer: 10x users" }), [move()], { trustedText: true });
    expect(output.headline).toBe("Recorded demo answer: 10x users");
  });

  it("stripNumbers handles thousands separators and percentages", () => {
    expect(stripNumbers("1,234.50 and 50% and 7", new Set([123450]), [])).toEqual({ text: "1,234.50 and and", removed: 2 });
  });
});

describe("figure meaning comes from the server", () => {
  const fig = (path: string, valueUsd: number, unit: "per_month" | "one_time" | "months" = "per_month") => ({ label: "Whatever the model wrote", valueUsd, unit, call: "c1", path });

  it("sets the unit and label from the path, whatever the model claimed", () => {
    const { output, checks } = checkAdvice(
      answer({ figures: [fig("/oneTimeUsd", 500), fig("/breakEvenMonths", 12.42), fig("/monthlySavingUsd", 40.25, "one_time"), fig("/monthlyFromUsd", 120.5, "months")] }),
      [move()],
    );
    expect(output.figures.map((f) => [f.path, f.unit, f.label])).toEqual([
      ["/oneTimeUsd", "one_time", "One-time cost of moving"],
      ["/breakEvenMonths", "months", "Months to pay it back"],
      ["/monthlySavingUsd", "per_month", "Monthly saving from moving"],
      ["/monthlyFromUsd", "per_month", "Monthly list cost on Google Cloud"],
    ]);
    expect(checks.droppedFigures).toEqual([]);
  });

  it("drops paths with no known meaning, getPrices rates included, and repeats", () => {
    const prices: TraceCall = { id: "c2", name: "getPrices", args: {}, error: null, result: { rowCount: 1, rows: [{ usd: 0.0336, tierStart: 0 }] } };
    const { output, checks } = checkAdvice(
      answer({ figures: [{ ...fig("/rows/0/usd", 0.03), call: "c2" }, { ...fig("/rowCount", 1), call: "c2" }, fig("/monthlyToUsd", 80.25), fig("/monthlyToUsd", 80.25)] }),
      [move(), prices],
    );
    expect(checks.droppedFigures.map((d) => d.reason)).toEqual(["unsupported_path", "unsupported_path", "duplicate"]);
    expect(output.figures).toHaveLength(1);
  });

  it("knows the scenario and footprint paths", () => {
    const scen: TraceCall = { id: "c2", name: "priceScenario", args: {}, error: null, result: { clouds: { oci: { listUsd: 10, netUsd: 8 }, bogus: { listUsd: 1 } } } };
    const foot: TraceCall = { id: "c3", name: "getFootprint", args: {}, error: null, result: { name: "helpdesk", monthlyListUsd: { gcp: 33.5 } } };
    const { output, checks } = checkAdvice(
      answer({ figures: [{ ...fig("/clouds/oci/listUsd", 10), call: "c2" }, { ...fig("/clouds/oci/netUsd", 8), call: "c2" }, { ...fig("/clouds/bogus/listUsd", 1), call: "c2" }, { ...fig("/monthlyListUsd/gcp", 33.5), call: "c3" }] }),
      [move(), scen, foot],
    );
    expect(output.figures.map((f) => f.label)).toEqual(["Monthly list cost on Oracle Cloud", "Monthly cost on Oracle Cloud after allowances", "Monthly list cost on Google Cloud"]);
    expect(checks.droppedFigures.map((d) => d.reason)).toEqual(["unsupported_path"]);
  });
});

describe("nothing to stand on", () => {
  it("replaces an answer with no verified figure and no analysis by the fixed sentence", () => {
    const { output, checks } = checkAdvice(answer({ recommendation: "move", figures: [{ label: "AWS", valueUsd: 0.01, unit: "per_month", call: "c1", path: "/x" }], explanation: "AWS costs $0.01." }), []);
    expect(output.headline).toBe(FIXED_HEADLINE);
    expect(output.figures).toEqual([]);
    expect(output.recommendation).toBe("not_enough_data");
    expect(checks.fixedAnswer).toBe(true);
    expect(checks.droppedFigures).toHaveLength(1);
  });

  it("keeps a verdict-only answer when every figure was dropped", () => {
    const { output, checks } = checkAdvice(answer({ figures: [{ label: "x", valueUsd: 9, unit: "per_month", call: "c1", path: "/monthlyToUsd" }] }), [move()]);
    expect(checks.fixedAnswer).toBe(false);
    expect(output.recommendation).toBe("consider");
    expect(output.figures).toEqual([]);
  });
});

describe("resolvePointer", () => {
  it("follows objects and arrays, decodes ~0 and ~1, and refuses anything else", () => {
    const root = { a: { "b/c": [10, { d: 5 }], "~": 1 } };
    expect(resolvePointer(root, "/a/b~1c/1/d")).toBe(5);
    expect(resolvePointer(root, "/a/~0")).toBe(1);
    expect(resolvePointer(root, "/a/b~1c/01")).toBeUndefined();
    expect(resolvePointer(root, "a")).toBeUndefined();
    expect(resolvePointer(root, "/__proto__")).toBeUndefined();
  });
});
