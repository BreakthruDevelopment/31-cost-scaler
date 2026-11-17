import "server-only";
import { eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { db, schema } from "@/lib/db";
import { STALE_AFTER_HOURS, type PriceFreshness } from "@/lib/footprint-calc";
import { allowPublicRequest, clientIpFromHeaders } from "@/lib/ip-limit";
import { MAX_PRICE_ROWS, listPricePoints, priceFilter } from "@/lib/prices";
import { CLOUD_ORDER, type Cloud } from "@/lib/pricing/types";

/**
 * What the public price table page shows. Everything here is a read of the ACTIVE `price_point` rows through
 * `listPricePoints` (which calls `assertCan`); the page never queries the database itself.
 *
 * Freshness is a separate aggregate over every cloud, not over the filtered rows: filtering to one cloud must not
 * hide that another cloud's prices are missing or stale.
 */

export { STALE_AFTER_HOURS };
export type { PriceFreshness };

/** Pages call this first: one count per page view against the per-IP limit. False means show the 429 message. */
export async function publicPricePageAllowed(): Promise<boolean> {
  return allowPublicRequest(clientIpFromHeaders(await headers()));
}

export type PriceRowView = typeof schema.pricePoint.$inferSelect;

export type PriceGroup = { cloud: Cloud; rows: PriceRowView[] };

export type PriceTableView = {
  groups: PriceGroup[];
  total: number;
  /** True when the 2,000-row cap trimmed the answer, so the page can say the list is partial. */
  truncated: boolean;
  freshness: PriceFreshness;
  filter: { cloud?: Cloud; component?: string };
};

/** Per cloud, over ACTIVE rows only: how many there are and when the newest was fetched. */
export async function priceFreshnessByCloud(now: number = Date.now()): Promise<PriceFreshness> {
  const p = schema.pricePoint;
  const rows = await db()
    .select({ cloud: p.cloud, n: sql<number>`count(*)::int`, newest: sql<Date | null>`max(${p.fetchedAt})` })
    .from(p)
    .where(eq(p.status, "active"))
    .groupBy(p.cloud);
  const byCloud = new Map(rows.map((r) => [r.cloud, r]));
  const clouds = CLOUD_ORDER.map((cloud) => {
    const r = byCloud.get(cloud);
    const newest = r?.newest ? new Date(r.newest).toISOString() : null;
    return { cloud, rows: r?.n ?? 0, newest, unavailable: (r?.n ?? 0) === 0 };
  });
  const ages = clouds.flatMap((c) => (c.newest ? [now - new Date(c.newest).getTime()] : []));
  const oldest = ages.length ? Math.max(...ages) : null;
  return {
    clouds,
    stale: oldest !== null && oldest > STALE_AFTER_HOURS * 3_600_000,
    oldestAgeHours: oldest === null ? null : Math.floor(oldest / 3_600_000),
  };
}

/**
 * The table for one filter. An unknown `cloud` or `component` in the query string is a bad filter, not a crash:
 * the caller catches the zod error and falls back to no filter with a message.
 */
export async function loadPriceTable(rawFilter: unknown = {}): Promise<PriceTableView> {
  const filter = priceFilter.parse(rawFilter);
  const [rows, freshness] = await Promise.all([listPricePoints(filter), priceFreshnessByCloud()]);
  const groups = CLOUD_ORDER.flatMap((cloud) => {
    const forCloud = rows.filter((r) => r.cloud === cloud);
    return forCloud.length ? [{ cloud, rows: forCloud }] : [];
  });
  return { groups, total: rows.length, truncated: rows.length >= MAX_PRICE_ROWS, freshness, filter };
}
