import Link from "next/link";
import { PageIntro, buttonSecondary } from "@/components/ui";
import type { PriceFreshness } from "@/lib/footprint-view";
import { STALE_AFTER_HOURS } from "@/lib/footprint-view";
import { cloudName, formatDate } from "./format";

/** Shown instead of the page when this IP has used its 60 requests a minute. */
export function RateLimited({ section, retryHref }: { section: string; retryHref: string }) {
  return (
    <div role="alert">
      <PageIntro section={section} title="Too many requests." description="You have asked for this page a lot in the last minute. Wait about a minute, then try again." />
      <Link href={retryHref} className={buttonSecondary}>
        Try again
      </Link>
    </div>
  );
}

/** Every total on these pages is an estimate from public list prices; say so once per page, near the top. */
export function ListPriceNote({ assumption }: { assumption: string }) {
  return (
    <p className="mb-6 rounded-card border border-border bg-surface px-4 py-3 text-sm text-muted wrap-anywhere">
      <strong className="font-semibold text-foreground">List price estimate.</strong> Not a quote or a bill. Figures use public list prices in each cloud&apos;s reference region and assume {assumption}. Net is shown after always-free allowances; rankings use list price.
    </p>
  );
}

/** The stale banner (refresh older than 72 hours) and a line for each cloud whose prices are missing. */
export function PriceBanners({ freshness }: { freshness: PriceFreshness }) {
  const missing = freshness.clouds.filter((c) => c.unavailable);
  const allMissing = missing.length === freshness.clouds.length;
  return (
    <>
      {allMissing && (
        <p role="alert" className="mb-4 rounded-card border border-border bg-building-soft px-4 py-3 text-sm text-building">
          <strong className="font-semibold">Prices unavailable.</strong> The price table is empty, so no costs can be shown yet.
        </p>
      )}
      {!allMissing &&
        missing.map((c) => (
          <p key={c.cloud} role="status" className="mb-4 rounded-card border border-border bg-building-soft px-4 py-3 text-sm text-building">
            <strong className="font-semibold">{cloudName(c.cloud)}: prices unavailable.</strong> No price rows are loaded for it, so it is left out of totals and rankings (never counted as $0).
          </p>
        ))}
      {freshness.stale && (
        <p role="status" className="mb-4 rounded-card border border-border bg-building-soft px-4 py-3 text-sm text-building">
          <strong className="font-semibold">Prices may be out of date.</strong> The last refresh was more than {STALE_AFTER_HOURS} hours ago ({freshness.oldestAgeHours} hours on the oldest cloud). Newest fetch per cloud:{" "}
          {freshness.clouds.filter((c) => c.newest).map((c) => `${cloudName(c.cloud)} ${formatDate(c.newest)}`).join(", ")}.
        </p>
      )}
    </>
  );
}
