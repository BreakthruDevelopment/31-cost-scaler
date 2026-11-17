import "server-only";
import type { Actor } from "@/lib/auth/rbac";
import { type PriceFreshness, priceFreshness } from "@/lib/footprint-calc";
import { listFootprint } from "@/lib/footprint/refresh";
import { HttpError } from "@/lib/errors";
import { log } from "@/lib/log";
import { loadPriceTable } from "@/lib/pricing/data";
import { type ScenarioPrice, priceScenario } from "@/lib/pricing/scenario";
import { BASE_SPEC, type ScenarioSpec, scenarioSpec } from "@/lib/pricing/spec";
import {
  type ComparedScenario,
  type Comparison,
  MAX_COMPARE,
  MIN_COMPARE,
  compareScenarios,
  readStoredResult,
  summarize,
  toStoredResult,
} from "@/lib/scenario-compare";
import { type ScenarioDraft, draftFromSpec } from "@/lib/scenario-draft";
import { MAX_SCENARIOS_PER_USER, type ScenarioRow, getScenario, getScenarioResult, listScenarios, saveScenarioResult } from "@/lib/scenarios";

/**
 * What the scenario screens read. Every function takes the acting user and goes through the data functions in
 * `scenarios.ts`, which call `assertCan()` and scope every query to the owner: another user's id is a 404 here too.
 *
 * Pricing itself is pure (`src/lib/pricing`) and runs against the public price rows, so rendering a page costs a
 * table read and some arithmetic. The per-user pricing limit lives on the paths a client can loop — the server
 * action behind the builder's "Price" button and `POST /api/price` — not on a page render.
 */

export type { PriceFreshness };

/** A scenario's spec as the engine wants it. A row whose stored spec no longer parses falls back to the base spec. */
function specOf(row: ScenarioRow): ScenarioSpec {
  const parsed = scenarioSpec.safeParse(row.spec);
  if (parsed.success) return parsed.data;
  log.warn("scenario_spec_unparsable", { scenarioId: row.id });
  return BASE_SPEC;
}

export type ScenarioListView = { rows: ScenarioRow[]; max: number; atCap: boolean; minCompare: number; maxCompare: number };

export async function loadScenarioList(actor: Actor): Promise<ScenarioListView> {
  const rows = await listScenarios(actor);
  return {
    rows,
    max: MAX_SCENARIOS_PER_USER,
    atCap: rows.length >= MAX_SCENARIOS_PER_USER,
    minCompare: MIN_COMPARE,
    maxCompare: MAX_COMPARE,
  };
}

export type BuilderView = {
  /** Null for a new scenario. */
  scenario: { id: string; version: number } | null;
  draft: ScenarioDraft;
  /** The spec priced on all four clouds, for the result panel. */
  result: ScenarioPrice;
  freshness: PriceFreshness;
  /** Footprint app names for the "based on" picker. */
  apps: { name: string; title: string }[];
};

async function footprintOptions(): Promise<{ name: string; title: string }[]> {
  try {
    return (await listFootprint()).map((a) => ({ name: a.name, title: a.title }));
  } catch (err) {
    // The picker is optional: a footprint that can't be read must not take the builder down with it.
    log.warn("scenario_footprint_options_failed", { error: err instanceof Error ? err.message : "unknown" });
    return [];
  }
}

/** The builder for one of the actor's scenarios, or for a new one (`id` null). Another user's id throws 404. */
export async function loadBuilder(actor: Actor, id: string | null): Promise<BuilderView> {
  const row = id === null ? null : await getScenario(actor, id);
  const spec = row ? specOf(row) : BASE_SPEC;
  const [table, apps] = await Promise.all([loadPriceTable(actor), footprintOptions()]);
  return {
    scenario: row ? { id: row.id, version: row.version } : null,
    draft: draftFromSpec(row?.name ?? "", spec),
    result: priceScenario(spec, table),
    freshness: priceFreshness(table),
    apps,
  };
}

/**
 * Price a saved scenario and store the result, so a later comparison reads the numbers the owner saw. Called after a
 * create or an update; a pricing failure is logged and swallowed, because the scenario itself is already saved.
 *
 * `row` is the version this priced, and `saveScenarioResult` checks it against the locked scenario row. Loading the
 * price table and pricing take time, so a second save of the same scenario can commit a newer version in between;
 * these numbers then describe a spec that is gone, and the newer save's result is the one to keep. The write is
 * dropped in that case (`false` here), which is not a failure: nothing told the user this result was stored, and a
 * scenario with no usable stored result is simply priced again at comparison time.
 */
export async function storeScenarioResult(actor: Actor, row: ScenarioRow): Promise<boolean> {
  try {
    const priced = priceScenario(specOf(row), await loadPriceTable(actor));
    const stored = await saveScenarioResult(actor, row.id, {
      version: row.version,
      pricesAsOf: priced.pricesAsOf ? new Date(priced.pricesAsOf) : new Date(),
      result: toStoredResult(priced),
    });
    return stored !== null;
  } catch (err) {
    log.warn("scenario_result_store_failed", { scenarioId: row.id, error: err instanceof Error ? err.message : "unknown" });
    return false;
  }
}

export type CompareView =
  | { ok: true; comparison: Comparison; freshness: PriceFreshness }
  | { ok: false; reason: "too_few" | "too_many" | "missing"; message: string };

const COMPARE_MESSAGE = {
  too_few: `Pick at least ${MIN_COMPARE} scenarios to compare.`,
  too_many: `Compare at most ${MAX_COMPARE} scenarios at a time.`,
  missing: "One of those scenarios no longer exists.",
} as const;

/**
 * Compare 2–3 of the actor's own scenarios. Each one uses the result stored when it was last saved; one with no
 * stored result (or a result written in an older shape) is priced now from the current table and marked as such.
 * An id that is not the actor's own is "no longer exists" — the same answer as a deleted one, so ids can't be probed.
 */
export async function loadComparison(actor: Actor, ids: string[]): Promise<CompareView> {
  if (ids.length < MIN_COMPARE) return { ok: false, reason: "too_few", message: COMPARE_MESSAGE.too_few };
  if (ids.length > MAX_COMPARE) return { ok: false, reason: "too_many", message: COMPARE_MESSAGE.too_many };

  let rows: ScenarioRow[];
  try {
    rows = await Promise.all(ids.map((id) => getScenario(actor, id)));
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return { ok: false, reason: "missing", message: COMPARE_MESSAGE.missing };
    throw err;
  }

  const table = await loadPriceTable(actor);
  const scenarios: ComparedScenario[] = await Promise.all(
    rows.map(async (row): Promise<ComparedScenario> => {
      const stored = readStoredResult((await getScenarioResult(actor, row.id))?.result);
      return {
        id: row.id,
        name: row.name,
        baseApp: row.baseApp,
        price: stored ?? summarize(priceScenario(specOf(row), table)),
        source: stored ? "saved" : "computed",
      };
    }),
  );
  return { ok: true, comparison: compareScenarios(scenarios), freshness: priceFreshness(table) };
}
