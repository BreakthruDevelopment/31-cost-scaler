import type { Metadata } from "next";
import Link from "next/link";
import { CloudCostRow } from "@/components/footprint/cloud-cost-row";
import { cloudName } from "@/components/footprint/format";
import { ListPriceNote, PriceBanners, RateLimited } from "@/components/footprint/notices";
import { PageIntro, Panel } from "@/components/ui";
import { loadOverview, publicPageAllowed } from "@/lib/footprint-view";

export const metadata: Metadata = { title: "Footprint" };
export const dynamic = "force-dynamic";

export default async function FootprintPage() {
  if (!(await publicPageAllowed())) return <RateLimited section="Footprint" retryHref="/footprint" />;
  const data = await loadOverview();
  return (
    <>
      <PageIntro
        section="Footprint"
        title="What the portfolio runs today."
        description="Every app in the current environment, on each cloud it runs on: list cost, the free-tier credit as its own line, and what is left."
      />
      <ListPriceNote assumption={data.assumption} />
      <PriceBanners freshness={data.freshness} />
      <Panel title="Apps" count={data.items.length}>
        {data.items.length === 0 ? (
          <div className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">
            No apps in the footprint yet. It is imported from the infrastructure repo on the next refresh.
          </div>
        ) : (
          <ul aria-label="Apps in the footprint" className="grid gap-4 lg:grid-cols-2">
            {data.items.map(({ row, clouds }) => (
              <li key={row.name} className="min-w-0 rounded-card border border-border bg-surface p-4">
                <h3 className="font-semibold wrap-anywhere">
                  <Link href={`/footprint/${encodeURIComponent(row.name)}`} className="text-accent hover:underline">
                    {row.title}
                  </Link>
                </h3>
                <p className="mb-2 font-mono text-xs text-muted wrap-anywhere">
                  {row.name} · {row.clouds.map((c) => (c === "aws" || c === "azure" || c === "gcp" || c === "oci" ? cloudName(c) : c)).join(", ")}
                </p>
                <ul aria-label={`${row.title} cost by cloud`}>
                  {clouds.map((c) => (
                    <CloudCostRow key={c.cloud} c={c} />
                  ))}
                </ul>
                <Link href={`/footprint/${encodeURIComponent(row.name)}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-accent hover:underline">
                  Details and &quot;Should this app move?&quot;
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
