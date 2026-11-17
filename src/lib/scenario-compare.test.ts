import { describe, expect, it } from "vitest";
import { fixtureRowsWithIds } from "../../test/fixtures/pricing-table";
import { priceScenario } from "@/lib/pricing/scenario";
import { BASE_SPEC, type ScenarioSpec } from "@/lib/pricing/spec";
import { buildPriceTable } from "@/lib/pricing/table";
import type { PriceRow } from "@/lib/pricing/types";
import {
  MAX_COMPARE,
  type ComparedScenario,
  compareScenarios,
  parseCompareIds,
  readStoredResult,
  summarize,
  toStoredResult,
} from "@/lib/scenario-compare";

const TABLE = buildPriceTable(fixtureRowsWithIds());
const spec = (over: Partial<ScenarioSpec>): ScenarioSpec => ({ ...BASE_SPEC, ...over });
const priced = (s: ScenarioSpec) => summarize(priceScenario(s, TABLE));

const scenario = (id: string, name: string, s: ScenarioSpec, source: "saved" | "computed" = "saved"): ComparedScenario => ({
  id,
  name,
  baseApp: null,
  price: priced(s),
  source,
});

describe("ids in the compare URL", () => {
  it("accepts repeated and comma-separated values, de-duplicates and keeps the order", () => {
    expect(parseCompareIds(["a", "b"])).toEqual(["a", "b"]);
    expect(parseCompareIds("a,b")).toEqual(["a", "b"]);
    expect(parseCompareIds([" a ", "a", "b"])).toEqual(["a", "b"]);
    expect(parseCompareIds(undefined)).toEqual([]);
    expect(parseCompareIds("")).toEqual([]);
  });
  it("stops one past the cap, so too many is refused rather than silently trimmed", () => {
    expect(parseCompareIds(Array.from({ length: 50 }, (_, i) => `id-${i}`))).toHaveLength(MAX_COMPARE + 1);
    expect(parseCompareIds(["a", "b", "c"])).toHaveLength(MAX_COMPARE);
  });
});

describe("a stored result", () => {
  it("round-trips through the versioned envelope", () => {
    const stored = toStoredResult(priceScenario(BASE_SPEC, TABLE));
    const read = readStoredResult(JSON.parse(JSON.stringify(stored)));
    expect(read).not.toBeNull();
    expect(read?.clouds.aws.totalMicros).toBe(stored.price.clouds.aws.totalMicros);
    expect(read?.cheapest).toBe(stored.price.cheapest);
  });

  it("is ignored when it was written in another shape, so nothing stale is shown as current", () => {
    const stored = toStoredResult(priceScenario(BASE_SPEC, TABLE));
    expect(readStoredResult({ ...stored, v: 99 })).toBeNull();
    expect(readStoredResult({ v: 1, price: { cheapest: "aws" } })).toBeNull();
    expect(readStoredResult(null)).toBeNull();
    expect(readStoredResult("not an object")).toBeNull();
    expect(readStoredResult({ v: 1, price: { ...stored.price, clouds: { aws: stored.price.clouds.aws } } })).toBeNull();
  });
});

describe("comparing scenarios", () => {
  const small = spec({ users: { mau: 100, requestsPerUser: 10 } });
  const big = spec({ users: { mau: 1_000_000, requestsPerUser: 1_000 }, identity: { mau: 1_000_000 } });

  it("puts every cloud in one row per cloud, one cell per scenario", () => {
    const c = compareScenarios([scenario("s1", "Small", small), scenario("s2", "Big", big)]);
    expect(c.rows.map((r) => r.cloud)).toEqual(["aws", "azure", "gcp", "oci"]);
    for (const row of c.rows) expect(row.cells.map((x) => x.scenarioId)).toEqual(["s1", "s2"]);
  });

  it("marks the lowest complete list total in each cloud's row", () => {
    const c = compareScenarios([scenario("s1", "Small", small), scenario("s2", "Big", big)]);
    const aws = c.rows[0];
    const best = aws.cells.filter((x) => x.best);
    expect(best).toHaveLength(1);
    expect(best[0].scenarioId).toBe("s1");
  });

  it("never ranks a cloud whose price list is missing a part", () => {
    // Oracle lists no database price in the fixture table, so its total is incomplete on both scenarios.
    const c = compareScenarios([scenario("s1", "Small", small), scenario("s2", "Big", big)]);
    const oci = c.rows.find((r) => r.cloud === "oci");
    expect(oci?.cells.every((x) => x.summary.complete)).toBe(false);
    expect(oci?.cells.some((x) => x.best && !x.summary.complete)).toBe(false);
    expect(c.winner?.cloud).not.toBe("oci");
  });

  it("names the single lowest (scenario, cloud) pair overall", () => {
    const c = compareScenarios([scenario("s2", "Big", big), scenario("s1", "Small", small)]);
    expect(c.winner).not.toBeNull();
    expect(c.winner?.scenarioId).toBe("s1");
    const cell = c.rows.find((r) => r.cloud === c.winner?.cloud)?.cells.find((x) => x.scenarioId === "s1");
    const everyComplete = c.rows.flatMap((r) => r.cells).filter((x) => x.summary.complete);
    expect(Math.min(...everyComplete.map((x) => x.summary.totalMicros))).toBe(cell?.summary.totalMicros);
  });

  it("names nobody when two scenarios cost exactly the same", () => {
    const c = compareScenarios([scenario("s1", "One", small), scenario("s2", "A copy of it", small)]);
    expect(c.winner).toBeNull();
    expect(c.winnerTied).toBe(true);
    expect(c.winnerMicros).not.toBeNull();
    expect(c.rows.every((r) => r.cells.every((x) => !x.best))).toBe(true);
  });

  it("names nobody when no cloud has a complete total", () => {
    const emptyTable = buildPriceTable([] as PriceRow[]);
    const nothing: ComparedScenario = { id: "s1", name: "x", baseApp: null, price: summarize(priceScenario(BASE_SPEC, emptyTable)), source: "computed" };
    const c = compareScenarios([nothing, { ...nothing, id: "s2" }]);
    expect(c.winner).toBeNull();
    expect(c.winnerTied).toBe(false);
    expect(c.winnerMicros).toBeNull();
    expect(c.rows.every((r) => r.cells.every((x) => !x.best))).toBe(true);
  });

  it("flags scenarios priced from price lists fetched on different days", () => {
    const a = scenario("s1", "Small", small);
    const b = scenario("s2", "Big", big);
    expect(compareScenarios([a, b]).mixedPriceDates).toBe(false);
    const older = { ...b, price: { ...b.price, pricesAsOf: "2020-01-01T00:00:00.000Z" } };
    const mixed = compareScenarios([a, older]);
    expect(mixed.mixedPriceDates).toBe(true);
    expect(mixed.priceDates).toHaveLength(2);
  });
});
