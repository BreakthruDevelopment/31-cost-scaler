import Link from "next/link";
import { cloudName, perMonth, usd } from "@/components/footprint/format";
import { ListPriceNote, PriceBanners, RateLimited } from "@/components/footprint/notices";
import { PageIntro, Panel, StatGrid, StatTile, buttonPrimary, buttonSecondary } from "@/components/ui";
import { summariseTotals } from "@/lib/footprint-calc";
import { loadOverview, publicPageAllowed } from "@/lib/footprint-view";

export const dynamic = "force-dynamic";

const steps = [
  { title: "Numbers you can trace", body: "Every price comes from a cloud's public list and links to its source with the date it was fetched." },
  { title: "Like for like", body: "AWS, Azure, Google Cloud and Oracle Cloud are priced on the same components: compute, database, storage, identity and egress." },
  { title: "Advice that never invents a number", body: "Missing prices are shown as missing, never as zero, and the move verdict is computed from list prices, not guessed." },
];

/**
 * What the panel says when no cloud has a complete price. This is a real state, not an empty one: the apps exist,
 * so the page must say that a price is *missing* rather than show totals of zero, which would read as free.
 */
function NoTotals({ state, apps, placements }: { state: "no_prices" | "none_priced"; apps: number; placements: number }) {
  const appCount = `${apps} app${apps === 1 ? "" : "s"}`;
  return (
    <p role="status" className="mb-6 rounded-card border border-border bg-background px-4 py-4 text-sm text-muted wrap-anywhere">
      {state === "no_prices" ? (
        <>
          <strong className="font-semibold text-foreground">No prices are loaded yet.</strong> The {appCount} in the footprint run on clouds whose price tables are empty, so there is no total to show.
        </>
      ) : (
        <>
          <strong className="font-semibold text-foreground">No complete price for any app yet.</strong> All {placements} app-on-cloud {placements === 1 ? "figure is" : "figures are"} missing at least one
          component&apos;s list price, so no total can be shown.
        </>
      )}{" "}
      This is a gap in the price table, not a free deployment: an amount appears only once every component it needs is listed, and a missing price is never counted as $0.00. Each cloud below says what it is
      waiting on.
    </p>
  );
}

export default async function Home() {
  if (!(await publicPageAllowed())) return <RateLimited section="Cloud Cost Scaler" retryHref="/" />;
  const data = await loadOverview();
  const summary = summariseTotals(data.totals);
  const counted = data.totals.filter((t) => t.state === "priced");
  const list = counted.reduce((s, t) => s + t.listMicros, 0);
  const credit = counted.reduce((s, t) => s + t.creditMicros, 0);
  const net = counted.reduce((s, t) => s + t.netMicros, 0);
  return (
    <>
      <PageIntro
        section="Cloud Cost Scaler"
        title="Know what you run costs, before the bill arrives."
        description="What the portfolio's own apps cost at list price today, what the free tiers cover, and whether an app should move clouds to scale efficiently."
        actions={
          <>
            <Link href="/footprint" className={buttonPrimary}>
              See the footprint
            </Link>
            <Link href="/sign-in" className={buttonSecondary}>
              Sign in to build scenarios
            </Link>
          </>
        }
      />
      <ListPriceNote assumption={data.assumption} />
      <PriceBanners freshness={data.freshness} />
      <Panel title="The portfolio today">
        {summary.state === "empty" ? (
          <div className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">
            No apps are in the footprint yet, so there is nothing to total. It is imported from the infrastructure repo on the next refresh.
          </div>
        ) : (
          <>
            {summary.state === "priced" ? (
              <>
                <StatGrid>
                  <StatTile value={data.items.length} label="Apps in the footprint" tone="accent" />
                  <StatTile value={perMonth(list)} label="List price estimate" />
                  <StatTile value={usd(credit)} label="Free-tier credit" tone="live" />
                  <StatTile value={perMonth(net)} label="Net, after always-free allowances" />
                </StatGrid>
                {summary.omitted > 0 && (
                  <p className="mb-4 text-sm text-muted wrap-anywhere">
                    The totals above cover {summary.counted} of {summary.placements} app-on-cloud {summary.placements === 1 ? "figure" : "figures"}: {summary.omitted} {summary.omitted === 1 ? "has" : "have"}{" "}
                    no complete list price (each cloud below says so), and a missing price is never counted as $0.00.
                  </p>
                )}
              </>
            ) : (
              <NoTotals state={summary.state} apps={data.items.length} placements={summary.placements} />
            )}
            <ul aria-label="Cost by cloud" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {data.totals.map((t) => (
                <li key={t.cloud} className="min-w-0 rounded-card border border-border bg-surface p-4">
                  <h3 className="font-mono text-sm font-medium">{cloudName(t.cloud)}</h3>
                  {t.state === "unavailable" ? (
                    <p className="mt-2 text-sm text-muted">
                      Prices unavailable
                      {t.apps > 0 ? `, so the ${t.apps} app${t.apps === 1 ? " that runs" : "s that run"} here ${t.apps === 1 ? "is" : "are"} left out of the totals` : ""}.
                    </p>
                  ) : t.state === "no_apps" ? (
                    <p className="mt-2 text-sm text-muted">No apps run here.</p>
                  ) : t.state === "unpriced" ? (
                    <p className="mt-2 text-sm text-muted">No complete prices for the {t.apps} app{t.apps === 1 ? "" : "s"} here, so no total is shown.</p>
                  ) : (
                    <dl className="mt-2 space-y-1 text-sm">
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted">List</dt>
                        <dd className="font-semibold">{perMonth(t.listMicros)}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted">Credit</dt>
                        <dd>{usd(t.creditMicros)}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted">Net</dt>
                        <dd className="font-semibold">{perMonth(t.netMicros)}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted">Apps</dt>
                        <dd>{t.counted === t.apps ? t.apps : `${t.counted} of ${t.apps} priced`}</dd>
                      </div>
                    </dl>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
      <div className="grid gap-x-4 md:grid-cols-3">
        {steps.map((s) => (
          <Panel key={s.title} title={s.title}>
            <p className="text-muted">{s.body}</p>
          </Panel>
        ))}
      </div>
    </>
  );
}
