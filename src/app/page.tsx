import Link from "next/link";
import { cloudName, perMonth, usd } from "@/components/footprint/format";
import { ListPriceNote, PriceBanners, RateLimited } from "@/components/footprint/notices";
import { PageIntro, Panel, StatGrid, StatTile, buttonPrimary, buttonSecondary } from "@/components/ui";
import { loadOverview, publicPageAllowed } from "@/lib/footprint-view";

export const dynamic = "force-dynamic";

const steps = [
  { title: "Numbers you can trace", body: "Every price comes from a cloud's public list and links to its source with the date it was fetched." },
  { title: "Like for like", body: "AWS, Azure, Google Cloud and Oracle Cloud are priced on the same components: compute, database, storage, identity and egress." },
  { title: "Advice that never invents a number", body: "Missing prices are shown as missing, never as zero, and the move verdict is computed from list prices, not guessed." },
];

export default async function Home() {
  if (!(await publicPageAllowed())) return <RateLimited section="Cloud Cost Scaler" retryHref="/" />;
  const data = await loadOverview();
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
        {counted.length === 0 ? (
          <div className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">
            No footprint or prices are loaded yet, so there is nothing to total. They arrive with the next refresh.
          </div>
        ) : (
          <>
            <StatGrid>
              <StatTile value={data.items.length} label="Apps in the footprint" tone="accent" />
              <StatTile value={perMonth(list)} label="List price estimate" />
              <StatTile value={usd(credit)} label="Free-tier credit" tone="live" />
              <StatTile value={perMonth(net)} label="Net, after always-free allowances" />
            </StatGrid>
            {counted.length < data.totals.filter((t) => t.state !== "no_apps").length && (
              <p className="mb-4 text-sm text-muted">The totals above leave out clouds with no complete prices (shown below); they are never counted as $0.</p>
            )}
            <ul aria-label="Cost by cloud" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {data.totals.map((t) => (
                <li key={t.cloud} className="min-w-0 rounded-card border border-border bg-surface p-4">
                  <h3 className="font-mono text-sm font-medium">{cloudName(t.cloud)}</h3>
                  {t.state === "unavailable" ? (
                    <p className="mt-2 text-sm text-muted">Prices unavailable.</p>
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
