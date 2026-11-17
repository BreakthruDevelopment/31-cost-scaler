import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cloudName, formatDate, outgrowsText, perMonth, sourceHost, usd, VERDICT } from "@/components/footprint/format";
import { ListPriceNote, PriceBanners, RateLimited } from "@/components/footprint/notices";
import { PageIntro, Panel, StatusBadge } from "@/components/ui";
import { type CloudCost, type MoveOption, loadDetail, publicPageAllowed } from "@/lib/footprint-view";
import { safeHref } from "@/lib/footprint-calc";
import { DEFAULT_FOOTPRINT_USAGE } from "@/lib/pricing/footprint";
import { CONSIDER_MAX_MONTHS, DEFAULT_HOURLY_RATE_USD, MOVE_MAX_MONTHS, MOVE_MIN_SAVING_MICROS } from "@/lib/pricing/move";
import { TEN_X_PRESET } from "@/lib/pricing/presets";
import { footprintName } from "@/lib/pricing/spec";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/footprint/[app]">): Promise<Metadata> {
  const { app } = await params;
  return { title: `Footprint: ${app.slice(0, 40)}` };
}

/** One source row: a link only for an https URL, and always a visible label (`sourceHost` never returns ""). */
function SourceRow({ s }: { s: { url: string; fetched: string } }) {
  const href = safeHref(s.url);
  const label = sourceHost(s.url);
  return (
    <li className="min-w-0 wrap-anywhere">
      {href ? (
        <a href={href} rel="noopener noreferrer" className="text-accent hover:underline">
          {label}
        </a>
      ) : (
        <span>{label}</span>
      )}{" "}
      <span className="text-muted">({s.fetched === "checked in" ? "allowance checked in" : `fetched ${formatDate(s.fetched)}`})</span>
    </li>
  );
}

function CloudCard({ c, cheapest }: { c: CloudCost; cheapest: boolean }) {
  const incomplete = !c.unavailable && !c.cost.complete;
  return (
    <li className="min-w-0 rounded-card border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-mono text-base font-medium">{cloudName(c.cloud)}</h3>
        {c.runsHere ? <StatusBadge status="live" label="Runs here today" /> : <StatusBadge status="not-started" label="Not used today" />}
        {cheapest && <StatusBadge status="healthy" label="Lowest list cost" />}
      </div>
      {c.unavailable ? (
        <p role="status" className="mt-3 text-sm text-muted">
          Prices unavailable for {cloudName(c.cloud)}. No price rows are loaded, so there is no total and it is left out of the ranking.
        </p>
      ) : (
        <>
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">List cost</dt>
              <dd className="min-w-0 text-right text-lg font-semibold">{incomplete ? "Incomplete" : perMonth(c.cost.totalMicros)}</dd>
            </div>
            {!incomplete && (
              <>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-muted">Free-tier credit</dt>
                  <dd className="min-w-0 text-right">{usd(c.cost.creditMicros)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="min-w-0 text-muted">Net, {c.cost.netLabel}</dt>
                  <dd className="shrink-0 text-right font-semibold">{perMonth(c.cost.netMicros)}</dd>
                </div>
              </>
            )}
          </dl>
          {incomplete && (
            <p className="mt-2 text-sm text-muted">
              {c.cost.unlistedCount} price{c.cost.unlistedCount === 1 ? " is" : "s are"} not listed. The total would be missing a part, so it is not shown or ranked.
            </p>
          )}
          {!incomplete && (
            <p className="mt-2 text-sm wrap-anywhere">
              <span className="text-muted">Outgrows free tier at: </span>
              {outgrowsText(c.outgrows, DEFAULT_FOOTPRINT_USAGE.requestsPerUser)}
            </p>
          )}
          <h4 className="mt-4 text-sm font-semibold">Components</h4>
          <ul className="mt-1 divide-y divide-border text-sm">
            {c.cost.lines.map((l) => (
              <li key={l.id} className="min-w-0 py-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 font-medium wrap-anywhere">{l.label}</span>
                  <span className="shrink-0 text-right">{l.micros === null ? "not listed" : perMonth(l.micros)}</span>
                </div>
                <p className="text-muted wrap-anywhere">{l.detail}</p>
                {l.snap && (
                  <p className="text-muted wrap-anywhere">
                    Priced at {l.snap.listed} ({l.snap.requested} is not a listed size).
                  </p>
                )}
              </li>
            ))}
            {c.cost.creditLines.map((l) => (
              <li key={l.id} className="flex min-w-0 items-baseline justify-between gap-3 py-2">
                <span className="min-w-0 wrap-anywhere">
                  <span className="font-medium">Credit: </span>
                  {l.label}
                </span>
                <span className="shrink-0 text-right">{usd(l.micros)}</span>
              </li>
            ))}
          </ul>
          {c.cost.notes.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              {c.cost.notes.map((n) => (
                <li key={n} className="wrap-anywhere">
                  {n}
                </li>
              ))}
            </ul>
          )}
          {c.sources.length > 0 && (
            <div className="mt-3 text-sm">
              <h4 className="font-semibold">Sources</h4>
              <ul className="mt-1 space-y-1">
                {c.sources.map((s) => (
                  <SourceRow key={s.url} s={s} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </li>
  );
}

function MoveCard({ m, from }: { m: MoveOption; from: string }) {
  const r = m.result;
  if (!r) {
    return (
      <li role="alert" className="min-w-0 rounded-card border border-border bg-surface p-4 text-sm">
        <h3 className="font-mono text-base font-medium">To {cloudName(m.to)}</h3>
        <p className="mt-2 text-muted">{m.error}</p>
      </li>
    );
  }
  const v = VERDICT[r.verdict];
  return (
    <li className="min-w-0 rounded-card border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-mono text-base font-medium">
          {from} to {cloudName(r.to)}
        </h3>
        <StatusBadge status={v.status} label={v.label} />
      </div>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm wrap-anywhere">
        {r.reasons.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <dl className="mt-3 space-y-1 text-sm">
        {r.atScenario && (
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted">List cost at 10x, {cloudName(r.from)} / {cloudName(r.to)}</dt>
            <dd className="shrink-0 text-right">
              {r.atScenario.fromComplete ? perMonth(r.atScenario.from) : "incomplete"} / {r.atScenario.toComplete ? perMonth(r.atScenario.to) : "incomplete"}
            </dd>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted">Monthly saving</dt>
          <dd className="shrink-0 text-right font-semibold">{r.monthlySavingMicros === null ? "Not known" : perMonth(r.monthlySavingMicros)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted">One-time cost ({r.effort.hours} h at {usd(r.hourlyRateMicros)}/h + egress)</dt>
          <dd className="shrink-0 text-right">{r.oneTimeTotalMicros === null ? "Not known" : usd(r.oneTimeTotalMicros)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted">Break-even</dt>
          <dd className="shrink-0 text-right">{r.breakEvenMonths === null ? "None" : `${r.breakEvenMonths} months`}</dd>
        </div>
      </dl>
      {r.verdict === "not_enough_data" && (
        <div className="mt-3 rounded-card bg-background px-3 py-2 text-sm wrap-anywhere">
          <p>
            <strong className="font-semibold">Not enough data for a like-for-like comparison.</strong> A move is only judged when both clouds have a complete list price for the same components. Missing
            prices are never treated as zero.
          </p>
          {r.likeForLike && (
            <p className="mt-2 text-muted">
              On the {r.likeForLike.comparedLineIds.length} component{r.likeForLike.comparedLineIds.length === 1 ? "" : "s"} both clouds do list, {cloudName(r.from)} comes to{" "}
              {perMonth(r.likeForLike.fromMicros)} and {cloudName(r.to)} to {perMonth(r.likeForLike.toMicros)}. That is a partial figure for context only, not the saving from moving
              {r.likeForLike.leftOut.length > 0 && <>: it leaves out {r.likeForLike.leftOut.map((l) => l.label).join(", ")}, with no listed price on one of the two clouds</>}. The move&apos;s own saving
              stays unknown until every component is priced on both.
            </p>
          )}
        </div>
      )}
      {r.notes.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
          {r.notes.map((n) => (
            <li key={n} className="wrap-anywhere">
              {n}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default async function FootprintAppPage({ params }: PageProps<"/footprint/[app]">) {
  const { app } = await params;
  const name = footprintName.safeParse(app);
  if (!name.success) notFound();
  if (!(await publicPageAllowed())) return <RateLimited section="Footprint" retryHref={`/footprint/${name.data}`} />;
  const d = await loadDetail(name.data);
  if (!d) notFound();
  const { row } = d;
  return (
    <>
      <Link href="/footprint" className="mb-4 inline-flex min-h-11 items-center text-sm font-semibold text-accent hover:underline">
        <span aria-hidden>←</span>&nbsp;All apps
      </Link>
      <PageIntro section="Footprint" title={row.title} />
      <p className="-mt-4 mb-8 max-w-2xl text-lg text-muted wrap-anywhere">
        <span className="font-mono text-base">{row.name}</span> runs on{" "}
        {row.clouds.map((c) => (c === "aws" || c === "azure" || c === "gcp" || c === "oci" ? cloudName(c) : c)).join(", ")}
        {row.storage ? ", with an object-storage bucket" : ""}
        {row.secretCount > 0 ? `, ${row.secretCount} per-app secret${row.secretCount === 1 ? "" : "s"}` : ""}.
      </p>
      <ListPriceNote assumption={d.assumption} />
      <PriceBanners freshness={d.freshness} />
      <Panel title="Cost on each cloud">
        <p className="mb-4 text-sm text-muted">
          The same stack priced on all four clouds. Shared databases and VMs are split evenly across the apps on that cloud. The lowest list cost is marked; free-tier credit never changes the ranking.
        </p>
        <ul aria-label="Cost on each cloud" className="grid gap-4 md:grid-cols-2">
          {d.clouds.map((c) => (
            <CloudCard key={c.cloud} c={c} cheapest={d.cheapest === c.cloud} />
          ))}
        </ul>
      </Panel>
      <Panel title="Should this app move?">
        <p className="mb-4 text-sm text-muted">
          Priced at the 10x users preset ({TEN_X_PRESET.users.mau.toLocaleString("en-US")} users a month). The verdict is computed from list prices, at ${DEFAULT_HOURLY_RATE_USD} an hour of migration effort: move when it pays back in {MOVE_MAX_MONTHS} months or less and saves at least {usd(Number(MOVE_MIN_SAVING_MICROS))} a month, consider within {CONSIDER_MAX_MONTHS} months, otherwise stay.
        </p>
        {d.moves.length === 0 ? (
          <div className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">
            {d.from ? "This app already runs on every cloud, so there is nowhere to move it." : "This app lists no cloud we can price, so there is nothing to compare."}
          </div>
        ) : (
          <ul aria-label="Move options" className="grid gap-4 md:grid-cols-2">
            {d.moves.map((m) => (
              <MoveCard key={m.to} m={m} from={d.from ? cloudName(d.from) : ""} />
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
