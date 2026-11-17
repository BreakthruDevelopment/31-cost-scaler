import type { Metadata } from "next";
import { RateLimited } from "@/components/footprint/notices";
import { ListPriceTableNote, PriceTableBanners } from "@/components/prices/banners";
import { COMPONENT_LABEL, cloudLabel } from "@/components/prices/format";
import { CloudPriceTable } from "@/components/prices/price-table";
import { FilterBar, PageIntro, Panel } from "@/components/ui";
import { CLOUDS, COMPONENTS } from "@/lib/db/schema";
import { MAX_PRICE_ROWS } from "@/lib/prices";
import { loadPriceTable, publicPricePageAllowed } from "@/lib/prices-view";
import { CLOUD_ORDER } from "@/lib/pricing/types";

export const metadata: Metadata = { title: "Prices" };
export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Above this many rows a cloud's panel starts folded, so the page stays scrollable on a phone. */
const ROWS_OPEN_BY_DEFAULT = 40;

export default async function PricesPage({ searchParams }: PageProps<"/prices">) {
  if (!(await publicPricePageAllowed())) return <RateLimited section="Prices" retryHref="/prices" />;
  const query = await searchParams;
  const wantedCloud = first(query.cloud);
  const wantedComponent = first(query.component);
  // An unknown value in the query string is a bad filter, not an error page: show everything and say so.
  const cloud = (CLOUDS as readonly string[]).includes(wantedCloud ?? "") ? (wantedCloud as (typeof CLOUDS)[number]) : undefined;
  const component = (COMPONENTS as readonly string[]).includes(wantedComponent ?? "") ? (wantedComponent as (typeof COMPONENTS)[number]) : undefined;
  const badFilter = (wantedCloud && !cloud) || (wantedComponent && !component);

  const table = await loadPriceTable({ cloud, component });
  const filtered = Boolean(cloud || component);

  return (
    <>
      <PageIntro
        section="Prices"
        title="One price table, four clouds."
        description="Every price the estimates use, normalized to the same components and units, with the public source and the date it was fetched."
      />
      <ListPriceTableNote />
      {badFilter && (
        <p role="alert" className="mb-4 rounded-card border border-border bg-building-soft px-4 py-3 text-sm text-building">
          <strong className="font-semibold">That filter is not one we know.</strong> Showing every price instead. Pick
          a cloud and a component from the lists below.
        </p>
      )}
      <PriceTableBanners freshness={table.freshness} />

      <FilterBar
        label="Filter prices"
        filters={[
          {
            name: "cloud",
            label: "Cloud",
            value: cloud ?? "",
            options: [{ value: "", label: "All clouds" }, ...CLOUD_ORDER.map((c) => ({ value: c, label: cloudLabel(c) }))],
          },
          {
            name: "component",
            label: "Component",
            value: component ?? "",
            options: [{ value: "", label: "All components" }, ...COMPONENTS.map((c) => ({ value: c, label: COMPONENT_LABEL[c] }))],
          },
        ]}
      />

      {table.truncated && (
        <p role="status" className="mb-4 rounded-card border border-border bg-building-soft px-4 py-3 text-sm text-building">
          <strong className="font-semibold">Showing the first {MAX_PRICE_ROWS.toLocaleString("en-US")} rows.</strong>{" "}
          Filter by cloud or component to see the rest.
        </p>
      )}

      {table.groups.length === 0 ? (
        <Panel title="Prices" count={0}>
          <div className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">
            {filtered
              ? "No prices match this filter. Try another cloud or component."
              : "No prices are loaded yet. They arrive with the nightly refresh."}
          </div>
        </Panel>
      ) : (
        table.groups.map((group) => (
          // A cloud with a lot of rows starts folded: the whole table is thousands of rows, and at 375px that is a
          // page nobody can scroll. The count is on the header either way, and the rows are in the HTML, so
          // find-in-page still works.
          <Panel
            key={group.cloud}
            title={cloudLabel(group.cloud)}
            count={group.rows.length}
            collapsible
            defaultOpen={group.rows.length <= ROWS_OPEN_BY_DEFAULT}
            openLabel="Hide rows"
            closedLabel="Show rows"
          >
            <CloudPriceTable group={group} />
          </Panel>
        ))
      )}
    </>
  );
}
