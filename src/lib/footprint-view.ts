import "server-only";
import { headers } from "next/headers";
import { listFootprint } from "@/lib/footprint/refresh";
import { allowPublicRequest, clientIpFromHeaders } from "@/lib/ip-limit";
import { loadPriceTable } from "@/lib/pricing/data";
import {
  DEFAULT_FOOTPRINT_USAGE,
  type AppCost,
  type FootprintApp,
  type OutgrowsFreeTier,
  appsOnCloud,
  outgrowsFreeTier,
  priceFootprintApp,
} from "@/lib/pricing/footprint";
import { type MoveResult, migrationBreakEven } from "@/lib/pricing/move";
import { TEN_X_PRESET } from "@/lib/pricing/presets";
import { CLOUD_ORDER, type Cloud, type PriceTable } from "@/lib/pricing/types";

/**
 * What the public footprint pages show, composed from the engine's pure functions over the footprint and the active
 * price rows (both public reads). Nothing here is invented: a cloud with no price rows is "unavailable", never zero.
 */

export const STALE_AFTER_HOURS = 72;
const STALE_MS = STALE_AFTER_HOURS * 3_600_000;

/** Pages call this first: one count per page view against the per-IP limit. False means show the 429 message. */
export async function publicPageAllowed(): Promise<boolean> {
  return allowPublicRequest(clientIpFromHeaders(await headers()));
}

export type FootprintRow = Awaited<ReturnType<typeof listFootprint>>[number];

const asApp = (row: FootprintRow): FootprintApp => ({ name: row.name, title: row.title, clouds: row.clouds, storage: row.storage, secretCount: row.secretCount });

export type CloudPriceStatus = {
  cloud: Cloud;
  rows: number;
  /** The newest `fetched_at` among the cloud's active rows, ISO; null when it has none. */
  newest: string | null;
  /** No active rows at all: the cloud's prices are unavailable. */
  unavailable: boolean;
};

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
  /** The app runs on this cloud today. */
  runsHere: boolean;
  /** No price rows for this cloud, so there is nothing to show. */
  unavailable: boolean;
  cost: AppCost;
  outgrows: OutgrowsFreeTier | null;
  /** Distinct price sources behind this cloud's figures: url and the oldest fetch date. */
  sources: { url: string; fetched: string }[];
};

function sourcesFor(cost: AppCost, table: PriceTable, cloud: Cloud): { url: string; fetched: string }[] {
  const byId = new Map<string, { sourceUrl: string; fetchedAt: Date | string }>();
  for (const key of table.skuKeys(cloud)) for (const r of table.rows(cloud, key)) byId.set(r.id, r);
  const out = new Map<string, string>();
  const add = (url: string, fetched: string) => {
    const prev = out.get(url);
    if (!prev || fetched < prev) out.set(url, fetched);
  };
  for (const line of cost.lines) {
    for (const id of line.priceIds) {
      const r = byId.get(id);
      if (r) add(r.sourceUrl, new Date(r.fetchedAt).toISOString().slice(0, 10));
    }
  }
  for (const credit of cost.creditLines) add(credit.sourceUrl, "checked in");
  return [...out].map(([url, fetched]) => ({ url, fetched }));
}

function costOn(app: FootprintApp, apps: FootprintApp[], cloud: Cloud, table: PriceTable): CloudCost {
  const n = appsOnCloud(apps, app, cloud);
  const cost: AppCost = priceFootprintApp({ app, cloud, n, table });
  const unavailable = table.skuKeys(cloud).length === 0;
  return {
    cloud,
    runsHere: app.clouds.includes(cloud),
    unavailable,
    cost,
    outgrows: !unavailable && cost.complete ? outgrowsFreeTier({ app, cloud, n, requestsPerUser: DEFAULT_FOOTPRINT_USAGE.requestsPerUser, table }) : null,
    sources: unavailable ? [] : sourcesFor(cost, table, cloud),
  };
}

const assumption = () => `${DEFAULT_FOOTPRINT_USAGE.mau} users a month, ${DEFAULT_FOOTPRINT_USAGE.requestsPerUser} requests each`;

export type FootprintListItem = { row: FootprintRow; clouds: CloudCost[] };

export type CloudTotal = { cloud: Cloud; apps: number; counted: number; listMicros: number; creditMicros: number; netMicros: number; unavailable: boolean };

export type FootprintOverview = {
  items: FootprintListItem[];
  freshness: PriceFreshness;
  /** Per cloud: the list cost, free-tier credit and net summed over the apps on it (complete prices only). */
  totals: CloudTotal[];
  assumption: string;
};

export async function loadOverview(): Promise<FootprintOverview> {
  const [rows, table] = await Promise.all([listFootprint(), loadPriceTable(null)]);
  const apps = rows.map(asApp);
  const items = rows.map(
    (row, i): FootprintListItem => ({
      row,
      clouds: CLOUD_ORDER.filter((c) => apps[i].clouds.includes(c)).map((c) => costOn(apps[i], apps, c, table)),
    }),
  );
  const totals = CLOUD_ORDER.map((cloud): CloudTotal => {
    const on = items.flatMap((i) => i.clouds.filter((c) => c.cloud === cloud));
    const counted = on.filter((c) => !c.unavailable && c.cost.complete);
    return {
      cloud,
      apps: on.length,
      counted: counted.length,
      listMicros: counted.reduce((s, c) => s + c.cost.totalMicros, 0),
      creditMicros: counted.reduce((s, c) => s + c.cost.creditMicros, 0),
      netMicros: counted.reduce((s, c) => s + c.cost.netMicros, 0),
      unavailable: table.skuKeys(cloud).length === 0,
    };
  });
  return { items, freshness: priceFreshness(table), totals, assumption: assumption() };
}

export type MoveOption = { to: Cloud; result: MoveResult | null; error: string | null };

export type FootprintDetail = {
  row: FootprintRow;
  clouds: CloudCost[];
  /** The cheapest cloud by list total among those with complete prices; null when none is complete. */
  cheapest: Cloud | null;
  freshness: PriceFreshness;
  from: Cloud | null;
  moves: MoveOption[];
  assumption: string;
};

/** Null when the app is not in the footprint. */
export async function loadDetail(name: string): Promise<FootprintDetail | null> {
  const [rows, table] = await Promise.all([listFootprint(), loadPriceTable(null)]);
  const row = rows.find((r) => r.name === name);
  if (!row) return null;
  const apps = rows.map(asApp);
  const app = asApp(row);
  const clouds = CLOUD_ORDER.map((c) => costOn(app, apps, c, table));
  const ranked = clouds.filter((c) => !c.unavailable && c.cost.complete).sort((a, b) => a.cost.totalMicros - b.cost.totalMicros);
  // The same "from" the API uses: the first cloud the app lists.
  const from = (CLOUD_ORDER as readonly string[]).includes(app.clouds[0]) ? (app.clouds[0] as Cloud) : null;
  const moves: MoveOption[] = from
    ? CLOUD_ORDER.filter((to) => !app.clouds.includes(to)).map((to) => {
        try {
          return { to, result: migrationBreakEven({ app, apps, from, to, table, scenario: TEN_X_PRESET }), error: null };
        } catch {
          return { to, result: null, error: "This move could not be priced." };
        }
      })
    : [];
  return { row, clouds, cheapest: ranked[0]?.cloud ?? null, freshness: priceFreshness(table), from, moves, assumption: assumption() };
}
