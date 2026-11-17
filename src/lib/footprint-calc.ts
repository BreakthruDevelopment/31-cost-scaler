import type { AppCost, OutgrowsFreeTier } from "@/lib/pricing/footprint";
import { CLOUD_ORDER, type Cloud, type PriceTable } from "@/lib/pricing/types";

/**
 * The pure parts of the public footprint pages (no database, no headers), so they can be unit-tested. A cloud whose
 * prices are missing or incomplete is never turned into a number: it is never summed as $0 and never ranked.
 */

export const STALE_AFTER_HOURS = 72;
const STALE_MS = STALE_AFTER_HOURS * 3_600_000;

export type CloudPriceStatus = { cloud: Cloud; rows: number; newest: string | null; unavailable: boolean };

export type PriceFreshness = {
  clouds: CloudPriceStatus[];
  /** The newest refresh is older than 72 hours on at least one cloud that has rows. */
  stale: boolean;
  /** Hours since the oldest of the per-cloud newest fetches (null when there are no rows). */
  oldestAgeHours: number | null;
};

export function priceFreshness(table: PriceTable, now: number = Date.now()): PriceFreshness {
  const clouds = CLOUD_ORDER.map((cloud): CloudPriceStatus => {
    let rows = 0;
    let newest = 0;
    for (const key of table.skuKeys(cloud)) {
      for (const r of table.rows(cloud, key)) {
        rows += 1;
        newest = Math.max(newest, new Date(r.fetchedAt).getTime());
      }
    }
    return { cloud, rows, newest: newest > 0 ? new Date(newest).toISOString() : null, unavailable: rows === 0 };
  });
  const ages = clouds.flatMap((c) => (c.newest ? [now - new Date(c.newest).getTime()] : []));
  const oldest = ages.length ? Math.max(...ages) : null;
  return { clouds, stale: oldest !== null && oldest > STALE_MS, oldestAgeHours: oldest === null ? null : Math.floor(oldest / 3_600_000) };
}

export type CloudCost = {
  cloud: Cloud;
  runsHere: boolean;
  /** No price rows for this cloud, so there is nothing to show. */
  unavailable: boolean;
  cost: AppCost;
  outgrows: OutgrowsFreeTier | null;
  sources: { url: string; fetched: string }[];
};

/** Whether this app-on-cloud figure may be shown, summed and ranked. */
export const isPriced = (c: Pick<CloudCost, "unavailable" | "cost">): boolean => !c.unavailable && c.cost.complete;

/**
 * `unavailable`: no price rows for the cloud. `no_apps`: nothing runs there. `unpriced`: apps run there but none has
 * a complete price (for example its serverless rows are quarantined). Only `priced` may show dollar figures.
 */
export type CloudTotalState = "unavailable" | "no_apps" | "unpriced" | "priced";

export type CloudTotal = { cloud: Cloud; state: CloudTotalState; apps: number; counted: number; listMicros: number; creditMicros: number; netMicros: number };

export function cloudTotals(items: readonly { clouds: readonly CloudCost[] }[], freshness: PriceFreshness): CloudTotal[] {
  return CLOUD_ORDER.map((cloud): CloudTotal => {
    const on = items.flatMap((i) => i.clouds.filter((c) => c.cloud === cloud));
    const counted = on.filter(isPriced);
    const unavailable = freshness.clouds.find((c) => c.cloud === cloud)?.unavailable ?? true;
    const state: CloudTotalState = unavailable ? "unavailable" : on.length === 0 ? "no_apps" : counted.length === 0 ? "unpriced" : "priced";
    return {
      cloud,
      state,
      apps: on.length,
      counted: counted.length,
      listMicros: counted.reduce((s, c) => s + c.cost.totalMicros, 0),
      creditMicros: counted.reduce((s, c) => s + c.cost.creditMicros, 0),
      netMicros: counted.reduce((s, c) => s + c.cost.netMicros, 0),
    };
  });
}

/**
 * What the landing page's summary may say about a set of per-cloud totals.
 *
 * - `empty`: no app runs anywhere, so there is nothing to total.
 * - `no_prices`: apps run, but not one cloud they use has any price rows loaded.
 * - `none_priced`: apps run on clouds that do have prices, but no app has a complete price on any of them.
 * - `priced`: at least one app-on-cloud figure is complete, so dollar totals may be shown.
 *
 * `omitted` counts the app-on-cloud placements left out of those totals (`placements - counted`). It is the only
 * honest trigger for the "totals leave some out" note: a cloud with no apps omits nothing, and a *priced* cloud
 * with one unpriced app omits one. An amount is never shown for an omitted placement, and never summed as $0.
 */
export type TotalsSummary = {
  state: "empty" | "no_prices" | "none_priced" | "priced";
  /** App-on-cloud placements across all clouds (one app on two clouds counts twice). */
  placements: number;
  /** Placements with a complete list price: the ones the dollar totals are built from. */
  counted: number;
  omitted: number;
};

export function summariseTotals(totals: readonly CloudTotal[]): TotalsSummary {
  const placements = totals.reduce((s, t) => s + t.apps, 0);
  const counted = totals.reduce((s, t) => s + t.counted, 0);
  const withApps = totals.filter((t) => t.apps > 0);
  const state: TotalsSummary["state"] =
    counted > 0 ? "priced" : withApps.length === 0 ? "empty" : withApps.every((t) => t.state === "unavailable") ? "no_prices" : "none_priced";
  return { state, placements, counted, omitted: placements - counted };
}

/** The cheapest cloud by LIST total among those with a complete price; null when none qualifies. Ties go to the first cloud in display order. */
export function cheapestCloud(clouds: readonly CloudCost[]): Cloud | null {
  let best: CloudCost | null = null;
  for (const c of clouds) {
    if (!isPriced(c)) continue;
    if (!best || c.cost.totalMicros < best.cost.totalMicros) best = c;
  }
  return best?.cloud ?? null;
}

/** A source link is only rendered for an https URL; anything else (javascript:, data:, relative) gets no link. */
export function safeHref(url: string): string | null {
  if (!/^https:\/\//i.test(url)) return null;
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}
