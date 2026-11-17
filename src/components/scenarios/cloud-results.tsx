import { cloudName, perMonth, usd } from "@/components/footprint/format";
import { StatusBadge } from "@/components/ui";
import type { ScenarioPrice } from "@/lib/pricing/scenario";
import { CLOUD_ORDER, type Cloud, type CloudPrice } from "@/lib/pricing/types";

/**
 * One scenario priced on all four clouds. The cheapest cloud comes first — on a phone that is the card you see
 * without scrolling. A cloud missing a price shows "incomplete" and is left out of the ranking: no total here is
 * ever completed with a zero.
 *
 * Rendered on the server for the first paint and again in the builder after a re-price, so it holds no state.
 */

/** Cheapest first, then the fixed cloud order. */
export function orderedClouds(result: ScenarioPrice): CloudPrice[] {
  const rest = CLOUD_ORDER.filter((c) => c !== result.cheapest).map((c) => result.clouds[c]);
  return result.cheapest ? [result.clouds[result.cheapest], ...rest] : rest;
}

function Amount({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="min-w-0 text-muted wrap-anywhere">{label}</dt>
      <dd className={`shrink-0 text-right ${strong ? "text-lg font-semibold" : ""}`}>{value}</dd>
    </div>
  );
}

function CloudCard({ c, cheapest }: { c: CloudPrice; cheapest: boolean }) {
  const unavailable = c.lines.length > 0 && c.lines.every((l) => l.status === "not_listed");
  return (
    <li className="min-w-0 rounded-card border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-mono text-base font-medium">{cloudName(c.cloud)}</h4>
        {cheapest && <StatusBadge status="healthy" label="Lowest list cost" />}
        {!c.complete && <StatusBadge status="building" label="Incomplete" />}
      </div>
      {unavailable ? (
        <p className="mt-3 text-sm text-muted">
          No prices are loaded for {cloudName(c.cloud)}, so this scenario cannot be priced there. It is left out of the ranking, never counted as $0.
        </p>
      ) : (
        <dl className="mt-3 space-y-1 text-sm">
          <Amount label="List cost" value={c.complete ? perMonth(c.totalMicros) : "Incomplete"} strong />
          {c.complete && <Amount label="Free-tier credit" value={usd(c.creditMicros)} />}
          {c.complete && <Amount label={`Net, ${c.netLabel}`} value={perMonth(c.netMicros)} strong />}
        </dl>
      )}
      {!c.complete && !unavailable && (
        <p className="mt-2 text-sm text-muted">
          {c.unlistedCount} price{c.unlistedCount === 1 ? " is" : "s are"} not listed on {cloudName(c.cloud)}, so the total would be missing a part. It is not shown or ranked.
        </p>
      )}
      <details className="mt-3">
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-accent">Cost lines ({c.lines.length})</summary>
        <ul className="mt-2 space-y-2">
          {c.lines.map((l) => (
            <li key={l.id} className="min-w-0 border-t border-border pt-2 text-sm first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="min-w-0 font-medium wrap-anywhere">{l.label}</span>
                <span className="shrink-0 font-mono">{l.status === "priced" && l.micros !== null ? perMonth(l.micros) : "Not listed"}</span>
              </div>
              <p className="text-muted wrap-anywhere">{l.detail}</p>
              {l.notes.map((n) => (
                <p key={n} className="text-muted wrap-anywhere">
                  {n}
                </p>
              ))}
            </li>
          ))}
          {c.creditLines.map((l) => (
            <li key={l.id} className="min-w-0 border-t border-border pt-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="min-w-0 font-medium wrap-anywhere">{l.label}</span>
                <span className="shrink-0 font-mono">{usd(l.micros)}</span>
              </div>
              <p className="text-muted wrap-anywhere">
                Free-tier allowance ·{" "}
                <a href={l.sourceUrl} className="text-accent hover:underline" rel="nofollow noreferrer">
                  source
                </a>
              </p>
            </li>
          ))}
          {c.lines.length === 0 && c.creditLines.length === 0 && <li className="text-sm text-muted">Nothing to price: every part of this scenario is set to zero.</li>}
        </ul>
      </details>
    </li>
  );
}

function LikeForLikeNote({ lfl }: { lfl: NonNullable<ScenarioPrice["likeForLike"]> }) {
  return (
    <p className="rounded-card border border-border bg-background px-3 py-2 text-sm text-muted wrap-anywhere">
      <strong className="font-semibold text-foreground">Like for like:</strong> {lfl.label}.{" "}
      {CLOUD_ORDER.map((c) => `${cloudName(c)} ${perMonth(lfl.totalsMicros[c])}`).join(", ")}. Shown for information only; it never picks a verdict.
    </p>
  );
}

export function CloudResults({ result, headingId }: { result: ScenarioPrice; headingId?: string }) {
  const clouds = orderedClouds(result);
  const cheapest: Cloud | null = result.cheapest;
  return (
    <div className="space-y-4">
      <p role="status" className="text-sm wrap-anywhere">
        {cheapest ? (
          <>
            <strong className="font-semibold">Cheapest: {cloudName(cheapest)}</strong> at {perMonth(result.clouds[cheapest].totalMicros)} list price
            {result.clouds[cheapest].creditMicros < 0 && <> ({perMonth(result.clouds[cheapest].netMicros)} {result.clouds[cheapest].netLabel})</>}.
          </>
        ) : (
          <strong className="font-semibold">No cloud lists a price for every part of this scenario, so none is named cheapest.</strong>
        )}
      </p>
      {result.likeForLike && <LikeForLikeNote lfl={result.likeForLike} />}
      <ul aria-labelledby={headingId} className="grid gap-4 lg:grid-cols-2">
        {clouds.map((c) => (
          <CloudCard key={c.cloud} c={c} cheapest={c.cloud === cheapest} />
        ))}
      </ul>
      <details>
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-accent">How these numbers are worked out</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
          {result.assumptions.map((a) => (
            <li key={a} className="wrap-anywhere">
              {a}
            </li>
          ))}
        </ul>
      </details>
      <p className="text-sm text-muted wrap-anywhere">{result.disclaimer}</p>
    </div>
  );
}
