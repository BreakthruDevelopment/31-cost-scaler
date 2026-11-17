import type { CloudCost } from "@/lib/footprint-view";
import { DEFAULT_FOOTPRINT_USAGE } from "@/lib/pricing/footprint";
import { cloudName, outgrowsText, perMonth, usd } from "./format";

function Cell({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm wrap-anywhere">{children}</dd>
    </div>
  );
}

/** One cloud's list cost, free-tier credit, net and "outgrows free tier at" for one app. */
export function CloudCostRow({ c }: { c: CloudCost }) {
  const incomplete = !c.unavailable && !c.cost.complete;
  return (
    <li className="min-w-0 border-t border-border py-3 first:border-t-0">
      <h4 className="mb-2 font-mono text-sm font-medium">{cloudName(c.cloud)}</h4>
      {c.unavailable ? (
        <p className="text-sm text-muted">Prices unavailable for {cloudName(c.cloud)}.</p>
      ) : (
        <dl className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          <Cell label="List cost">
            <span className="font-semibold">{incomplete ? "Incomplete" : perMonth(c.cost.totalMicros)}</span>
          </Cell>
          <Cell label="Free-tier credit">{incomplete ? "Not shown" : usd(c.cost.creditMicros)}</Cell>
          <Cell label="Net">
            <span className="font-semibold">{incomplete ? "Not shown" : perMonth(c.cost.netMicros)}</span>
          </Cell>
          <Cell label="Outgrows free tier at" className="col-span-3 sm:col-span-1">
            {incomplete ? "Not available" : outgrowsText(c.outgrows, DEFAULT_FOOTPRINT_USAGE.requestsPerUser)}
          </Cell>
        </dl>
      )}
      {incomplete && <p className="mt-2 text-sm text-muted">{c.cost.unlistedCount} price{c.cost.unlistedCount === 1 ? " is" : "s are"} not listed, so this total is not comparable.</p>}
    </li>
  );
}
