import type { Metadata } from "next";
import Link from "next/link";
import { cloudName, perMonth, usd } from "@/components/footprint/format";
import { PriceBanners } from "@/components/footprint/notices";
import { PageIntro, Panel, StatusBadge, buttonSecondary } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { DISCLAIMER } from "@/lib/pricing/scenario";
import type { CloudSummary, ComparedScenario, Comparison } from "@/lib/scenario-compare";
import { parseCompareIds } from "@/lib/scenario-compare";
import { loadComparison } from "@/lib/scenario-view";

export const metadata: Metadata = { title: "Compare scenarios" };
export const dynamic = "force-dynamic";

/** One cell's figure: a cloud that is missing a price is "Incomplete", never a number. */
const listCost = (s: CloudSummary) => (s.complete ? perMonth(s.totalMicros) : "Incomplete");

const notListed = (s: CloudSummary) => `${s.unlistedCount} price${s.unlistedCount === 1 ? " is" : "s are"} not listed`;

function ScenarioCard({ s, winner }: { s: ComparedScenario; winner: boolean }) {
  const cheapest = s.price.cheapest;
  return (
    <li className="min-w-0 rounded-card border border-border bg-surface p-4">
      <h3 className="font-semibold wrap-anywhere">
        <Link href={`/scenarios/${s.id}`} className="text-accent hover:underline">
          {s.name}
        </Link>
      </h3>
      <p className="mt-0.5 text-sm text-muted wrap-anywhere">
        {s.baseApp ? `Based on ${s.baseApp} · ` : ""}
        {s.source === "saved" ? "Saved result" : "Priced just now"}
        {s.price.pricesAsOf ? ` · prices fetched ${s.price.pricesAsOf.slice(0, 10)}` : ""}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {winner && <StatusBadge status="healthy" label="Lowest list cost overall" />}
        {cheapest ? (
          <StatusBadge status="not-started" label={`Cheapest here: ${cloudName(cheapest)} ${perMonth(s.price.clouds[cheapest].totalMicros)}`} />
        ) : (
          <StatusBadge status="building" label="No cloud lists every part" />
        )}
      </div>
    </li>
  );
}

function CompareTable({ comparison }: { comparison: Comparison }) {
  const { scenarios, rows } = comparison;
  return (
    <>
      {/* A table from 640px up; below that the same numbers are grouped per cloud as cards. */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">List cost a month per cloud, one column per scenario</caption>
          <thead className="bg-background text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-semibold">
                Cloud
              </th>
              {scenarios.map((s) => (
                <th key={s.id} scope="col" className="max-w-56 px-3 py-2 font-semibold wrap-anywhere">
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.cloud}>
                <th scope="row" className="px-3 py-3 text-left align-top font-mono font-normal">
                  {row.label}
                </th>
                {row.cells.map((cell) => (
                  <td key={cell.scenarioId} className="px-3 py-3 align-top">
                    <span className={cell.best ? "font-semibold text-live" : ""}>{listCost(cell.summary)}</span>
                    {cell.summary.complete && (
                      <span className="block text-muted">
                        net {perMonth(cell.summary.netMicros)} · credit {usd(cell.summary.creditMicros)}
                      </span>
                    )}
                    {!cell.summary.complete && <span className="block text-muted">{notListed(cell.summary)}</span>}
                    {cell.best && <span className="sr-only">Lowest list cost on this cloud</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul aria-label="List cost a month per cloud" className="grid gap-3 sm:hidden">
        {rows.map((row) => (
          <li key={row.cloud} className="min-w-0 rounded-card border border-border bg-surface p-4">
            <h4 className="font-mono text-base font-medium">{row.label}</h4>
            <dl className="mt-2 space-y-2 text-sm">
              {row.cells.map((cell) => {
                const s = scenarios.find((x) => x.id === cell.scenarioId);
                return (
                  <div key={cell.scenarioId} className="min-w-0 border-t border-border pt-2 first:border-t-0 first:pt-0">
                    <dt className="min-w-0 text-muted wrap-anywhere">{s?.name ?? "Scenario"}</dt>
                    <dd className="min-w-0 wrap-anywhere">
                      <span className={cell.best ? "font-semibold text-live" : "font-semibold"}>{listCost(cell.summary)}</span>
                      {cell.best && " · lowest here"}
                      {cell.summary.complete && (
                        <span className="block text-muted">
                          net {perMonth(cell.summary.netMicros)} · credit {usd(cell.summary.creditMicros)}
                        </span>
                      )}
                      {!cell.summary.complete && <span className="block text-muted">{notListed(cell.summary)}</span>}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Compare 2–3 of the caller's own scenarios, cloud by cloud. The ids come from the URL (`?ids=a&ids=b`), so a
 * comparison can be bookmarked; `loadComparison` checks every id against the owner, so a borrowed id is just
 * "no longer exists".
 */
export default async function ComparePage({ searchParams }: PageProps<"/scenarios/compare">) {
  const user = await requireUserOrRedirect();
  const ids = parseCompareIds((await searchParams).ids);
  const view = await loadComparison(user, ids);

  if (!view.ok) {
    return (
      <>
        <PageIntro section="Scenarios" title="Compare scenarios" description="Pick the scenarios to compare on the scenarios page." />
        <p role="alert" className="mb-6 rounded-card border border-border bg-building-soft px-4 py-3 text-sm text-building wrap-anywhere">
          {view.message}
        </p>
        <Link href="/scenarios" className={buttonSecondary}>
          Back to scenarios
        </Link>
      </>
    );
  }

  const { comparison, freshness } = view;
  const winner = comparison.winner;
  const winnerName = winner ? comparison.scenarios.find((s) => s.id === winner.scenarioId)?.name : null;

  return (
    <>
      <PageIntro
        section="Scenarios"
        title="Side by side"
        description="List cost a month for each scenario on every cloud. A cloud missing a price is shown as incomplete and left out of the ranking."
        actions={
          <Link href="/scenarios" className={buttonSecondary}>
            Back to scenarios
          </Link>
        }
      />
      <PriceBanners freshness={freshness} />

      <p role="status" className="mb-6 rounded-card border border-border bg-surface px-4 py-3 text-sm wrap-anywhere">
        {winner && winnerName ? (
          <>
            <strong className="font-semibold">Lowest list cost:</strong> {winnerName} on {cloudName(winner.cloud)}
            {comparison.winnerMicros !== null ? `, ${perMonth(comparison.winnerMicros)}` : ""}.
          </>
        ) : comparison.winnerTied && comparison.winnerMicros !== null ? (
          <strong className="font-semibold">
            Two or more of these come to the same lowest list cost, {perMonth(comparison.winnerMicros)}, so none is named cheapest.
          </strong>
        ) : (
          <strong className="font-semibold">No scenario has a cloud with every part priced, so none is named cheapest.</strong>
        )}{" "}
        {DISCLAIMER}
      </p>

      {comparison.mixedPriceDates && (
        <p role="status" className="mb-6 rounded-card border border-border bg-building-soft px-4 py-3 text-sm text-building wrap-anywhere">
          <strong className="font-semibold">Different price dates.</strong> These scenarios were priced from price lists fetched on{" "}
          {comparison.priceDates.map((d) => d.slice(0, 10)).join(" and ")}. Open a scenario and price it again to put them on the same basis.
        </p>
      )}

      <Panel title="Scenarios" count={comparison.scenarios.length}>
        <ul aria-label="Scenarios being compared" className="grid min-w-0 gap-3 lg:grid-cols-3">
          {comparison.scenarios.map((s) => (
            <ScenarioCard key={s.id} s={s} winner={winner?.scenarioId === s.id} />
          ))}
        </ul>
      </Panel>

      <Panel title="List cost a month">
        <CompareTable comparison={comparison} />
      </Panel>
    </>
  );
}
