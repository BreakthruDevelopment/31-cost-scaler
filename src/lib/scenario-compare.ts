import { z } from "zod";
import type { ScenarioPrice } from "@/lib/pricing/scenario";
import { CLOUD_LABEL, CLOUD_ORDER, type Cloud, type CloudPrice } from "@/lib/pricing/types";

/**
 * Comparing saved scenarios, as pure functions over already-priced results (no database, no price table), so the
 * compare page is a thin loader over code the tests can drive directly.
 *
 * Nothing here invents a number. A cloud whose price list is missing a part has `complete: false`: it is shown as
 * "incomplete", never as $0, and it is left out of every ranking. A scenario whose clouds are all incomplete has no
 * cheapest cloud at all.
 */

export const MIN_COMPARE = 2;
export const MAX_COMPARE = 3;

const cloudEnum = z.enum(CLOUD_ORDER as unknown as [Cloud, ...Cloud[]]);

/**
 * What `scenario_result.result` holds. The version tag is what makes an older or hand-edited row safe: anything
 * that doesn't parse is re-priced from the current table instead of being rendered as if it were current.
 */
export const STORED_RESULT_VERSION = 1;

const storedCloud = z.object({
  cloud: cloudEnum,
  label: z.string().max(40),
  totalMicros: z.number().int(),
  creditMicros: z.number().int(),
  netMicros: z.number().int(),
  netLabel: z.string().max(80),
  complete: z.boolean(),
  unlistedCount: z.number().int().min(0),
});

export const storedResultSchema = z.object({
  v: z.literal(STORED_RESULT_VERSION),
  price: z.object({
    pricesAsOf: z.string().max(40).nullable(),
    cheapest: cloudEnum.nullable(),
    /** Priced with new-account allowances counted. Rows stored before this existed were priced with the defaults. */
    conditionalCreditsApplied: z.boolean().default(false),
    clouds: z.object({ aws: storedCloud, azure: storedCloud, gcp: storedCloud, oci: storedCloud }),
  }),
});

/** The totals a comparison shows for one cloud. */
export type CloudSummary = z.infer<typeof storedCloud>;
export type PriceSummary = z.infer<typeof storedResultSchema>["price"];

const summarizeCloud = (c: CloudPrice): CloudSummary => ({
  cloud: c.cloud,
  label: c.label,
  totalMicros: c.totalMicros,
  creditMicros: c.creditMicros,
  netMicros: c.netMicros,
  netLabel: c.netLabel,
  complete: c.complete,
  unlistedCount: c.unlistedCount,
});

/** The part of a full pricing result a comparison needs. */
export function summarize(price: ScenarioPrice): PriceSummary {
  return {
    pricesAsOf: price.pricesAsOf,
    cheapest: price.cheapest,
    conditionalCreditsApplied: price.conditionalCreditsApplied,
    clouds: {
      aws: summarizeCloud(price.clouds.aws),
      azure: summarizeCloud(price.clouds.azure),
      gcp: summarizeCloud(price.clouds.gcp),
      oci: summarizeCloud(price.clouds.oci),
    },
  };
}

/** What a save stores, so a later read can tell the shape it was written in. */
export const toStoredResult = (price: ScenarioPrice) => ({ v: STORED_RESULT_VERSION, price: summarize(price) });

/** A stored result, or null when there is none or it was written in a shape this build doesn't know. */
export function readStoredResult(value: unknown): PriceSummary | null {
  const parsed = storedResultSchema.safeParse(value);
  return parsed.success ? parsed.data.price : null;
}

/**
 * `?ids=a&ids=b`, `?ids=a,b` and any mix: trimmed, de-duplicated, in the order given. It stops one past the
 * maximum, so a long URL can't fan out into a page of database reads, and so four ticked boxes are refused with
 * "at most 3" instead of quietly comparing the first three.
 */
export function parseCompareIds(raw: string | string[] | undefined): string[] {
  const parts = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).flatMap((v) => v.split(","));
  const out: string[] = [];
  for (const part of parts) {
    const id = part.trim();
    if (id !== "" && !out.includes(id)) out.push(id);
    if (out.length > MAX_COMPARE) break;
  }
  return out;
}

export type ComparedScenario = {
  id: string;
  name: string;
  baseApp: string | null;
  price: PriceSummary;
  /** "saved": the result stored when the scenario was last saved. "computed": priced now, because none was stored. */
  source: "saved" | "computed";
};

export type CompareCell = {
  scenarioId: string;
  summary: CloudSummary;
  /** The single lowest list total in this cloud's row, among the complete ones. A tie marks nobody. */
  best: boolean;
};

export type CompareRow = { cloud: Cloud; label: string; cells: CompareCell[] };

export type Comparison = {
  scenarios: ComparedScenario[];
  rows: CompareRow[];
  /** The one (scenario, cloud) pair with the lowest complete list total; null when none is complete, or it is a tie. */
  winner: { scenarioId: string; cloud: Cloud } | null;
  /** The lowest complete list total, whether or not one pair holds it alone. Null when no pair is complete. */
  winnerMicros: number | null;
  /** Two or more pairs come to the same lowest total, so no single one is named. */
  winnerTied: boolean;
  /** Some, but not all, of these were priced with new-account allowances, so their credits and net figures differ in kind. */
  mixedAllowances: boolean;
  /** The scenarios were priced from price lists fetched on different dates, so their totals are not strictly like for like. */
  mixedPriceDates: boolean;
  /** Every distinct "prices as of" date behind the numbers, oldest first. */
  priceDates: string[];
};

/**
 * The single lowest `totalMicros` among complete cells, and whether it is held alone. A tie names nobody: two
 * scenarios that cost the same are not "the cheaper one", and saying so would be inventing a difference.
 */
function lowest<T extends { summary: CloudSummary }>(cells: T[]): { micros: number | null; only: T | null } {
  const complete = cells.filter((c) => c.summary.complete);
  if (complete.length === 0) return { micros: null, only: null };
  // Integer micro-dollars, compared, never arithmetic: no float touches money here either.
  const micros = complete.reduce((min, c) => (c.summary.totalMicros < min ? c.summary.totalMicros : min), complete[0].summary.totalMicros);
  const holders = complete.filter((c) => c.summary.totalMicros === micros);
  return { micros, only: holders.length === 1 ? holders[0] : null };
}

export function compareScenarios(scenarios: ComparedScenario[]): Comparison {
  const rows: CompareRow[] = CLOUD_ORDER.map((cloud) => {
    const cells: CompareCell[] = scenarios.map((s) => ({ scenarioId: s.id, summary: s.price.clouds[cloud], best: false }));
    const { only } = lowest(cells);
    if (only && cells.length > 1) only.best = true;
    return { cloud, label: CLOUD_LABEL[cloud], cells };
  });

  const everyCell = rows.flatMap((row) => row.cells.map((cell) => ({ ...cell, cloud: row.cloud })));
  const overall = lowest(everyCell);
  const priceDates = [...new Set(scenarios.map((s) => s.price.pricesAsOf).filter((d): d is string => d !== null))].sort();
  return {
    scenarios,
    rows,
    winner: overall.only ? { scenarioId: overall.only.scenarioId, cloud: overall.only.cloud } : null,
    winnerMicros: overall.micros,
    winnerTied: overall.micros !== null && overall.only === null,
    mixedAllowances: new Set(scenarios.map((s) => s.price.conditionalCreditsApplied)).size > 1,
    mixedPriceDates: priceDates.length > 1,
    priceDates,
  };
}
