import { STALE_AFTER_HOURS, type PriceFreshness } from "@/lib/prices-view";
import { cloudLabel, fetchedOn } from "./format";

/**
 * The notices above the price table: every figure is a public list price, a cloud with no rows says so (it is never
 * shown as $0), and a refresh older than 72 hours gets the stale banner.
 */

export function ListPriceTableNote() {
  return (
    <p className="mb-4 rounded-card border border-border bg-surface px-4 py-3 text-sm text-muted wrap-anywhere">
      <strong className="font-semibold text-foreground">Public list prices.</strong> Each row is one normalized price
      as the cloud publishes it, in that cloud&apos;s reference region, in US dollars, with no discounts, commitments
      or spot pricing. Follow the source link on a row to check it. Not a quote.
    </p>
  );
}

export function PriceTableBanners({ freshness }: { freshness: PriceFreshness }) {
  const missing = freshness.clouds.filter((c) => c.unavailable);
  const allMissing = missing.length === freshness.clouds.length;
  const fetched = freshness.clouds.filter((c) => c.newest);
  return (
    <>
      {allMissing && (
        <p role="alert" className="mb-4 rounded-card border border-border bg-building-soft px-4 py-3 text-sm text-building">
          <strong className="font-semibold">Prices unavailable.</strong> No price rows are loaded yet, so the table is
          empty. It fills on the next nightly refresh.
        </p>
      )}
      {!allMissing &&
        missing.map((c) => (
          <p key={c.cloud} role="status" className="mb-4 rounded-card border border-border bg-building-soft px-4 py-3 text-sm text-building">
            <strong className="font-semibold">{cloudLabel(c.cloud)}: prices unavailable.</strong> No rows are loaded
            for it, so it has no lines below. A missing price is never shown as $0.
          </p>
        ))}
      {freshness.stale && (
        <p role="status" className="mb-4 rounded-card border border-border bg-building-soft px-4 py-3 text-sm text-building">
          <strong className="font-semibold">Prices may be out of date.</strong> The newest fetch on at least one cloud
          is more than {STALE_AFTER_HOURS} hours old ({freshness.oldestAgeHours} hours on the oldest). Newest fetch per
          cloud: {fetched.map((c) => `${cloudLabel(c.cloud)} ${fetchedOn(c.newest)}`).join(", ")}.
        </p>
      )}
    </>
  );
}
