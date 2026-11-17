import { type Column, DataList } from "@/components/ui";
import type { PriceGroup, PriceRowView } from "@/lib/prices-view";
import { COMPONENT_LABEL, UNIT_LABEL, cloudLabel, fetchedOn, formatUnitUsd, safeSourceHref, sourceHost, tierRange } from "./format";

/**
 * One cloud's rows. A table that scrolls inside its own box from 640px up and becomes one card per price below
 * that (`DataList`), so a 375px screen never scrolls sideways: a seven-column price table cannot be made to fit,
 * and squeezing it would hide the source link that makes a number checkable.
 */
export function CloudPriceTable({ group }: { group: PriceGroup }) {
  const columns: Column<PriceRowView>[] = [
    {
      key: "sku",
      header: "Normalized SKU",
      primary: true,
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block font-mono text-sm wrap-anywhere">{r.skuKey}</span>
          {r.description && <span className="block text-sm font-normal text-muted wrap-anywhere">{r.description}</span>}
        </span>
      ),
    },
    { key: "component", header: "Component", cell: (r) => <span className="wrap-anywhere">{COMPONENT_LABEL[r.component]}</span> },
    {
      key: "price",
      header: "List price",
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block font-semibold tabular-nums wrap-anywhere">{formatUnitUsd(r.usdMicros)}</span>
          <span className="block text-sm text-muted wrap-anywhere">{UNIT_LABEL[r.unit]}</span>
        </span>
      ),
    },
    {
      key: "tier",
      header: "Tier",
      cell: (r) => <span className="wrap-anywhere">{tierRange(r.tierStart, r.tierEnd) ?? "No tiers"}</span>,
    },
    { key: "region", header: "Region", cell: (r) => <span className="font-mono text-sm wrap-anywhere">{r.region}</span> },
    {
      key: "source",
      header: "Source",
      cell: (r) => {
        const href = safeSourceHref(r.sourceUrl);
        return (
          <span className="block min-w-0">
            {href ? (
              <a href={href} rel="noopener noreferrer" className="block text-accent hover:underline wrap-anywhere">
                {sourceHost(r.sourceUrl)}
              </a>
            ) : (
              <span className="block wrap-anywhere">{sourceHost(r.sourceUrl)}</span>
            )}
            <span className="block text-sm text-muted wrap-anywhere">fetched {fetchedOn(r.fetchedAt)}</span>
          </span>
        );
      },
    },
  ];
  return (
    <DataList
      caption={`${cloudLabel(group.cloud)} prices`}
      rows={group.rows}
      rowKey={(r) => r.id}
      columns={columns}
      empty={`No ${cloudLabel(group.cloud)} rows match this filter.`}
    />
  );
}
