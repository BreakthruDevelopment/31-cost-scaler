import type { Metadata } from "next";
import Link from "next/link";
import { ScenarioRowActions } from "@/components/scenarios/row-actions";
import { PageIntro, Panel, buttonPrimary, buttonSecondary } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { loadScenarioList } from "@/lib/scenario-view";

export const metadata: Metadata = { title: "Scenarios" };
export const dynamic = "force-dynamic";

/**
 * The signed-in user's own scenarios. `requireUserOrRedirect()` first, and `listScenarios` scopes the query to the
 * owner, so there is no way to land here with someone else's rows.
 *
 * Picking scenarios to compare is a plain GET form: the checkboxes submit `?ids=…&ids=…` and the compare page reads
 * them from the URL, so it works without JavaScript and a comparison can be linked to.
 */
export default async function ScenariosPage() {
  const user = await requireUserOrRedirect();
  const { rows, max, atCap, minCompare, maxCompare } = await loadScenarioList(user);

  return (
    <>
      <PageIntro
        section="Scenarios"
        title="Price what you are about to run."
        description="Describe the users, compute, database and storage you expect, price it on AWS, Azure, Google Cloud and Oracle at list price, and compare your scenarios side by side."
        actions={
          <Link href="/scenarios/new" className={buttonPrimary}>
            New scenario
          </Link>
        }
      />

      {atCap && (
        <p role="status" className="mb-6 rounded-card border border-border bg-building-soft px-4 py-3 text-sm text-building">
          <strong className="font-semibold">You have {max} scenarios.</strong> That is the limit per user: delete one before saving another.
        </p>
      )}

      <Panel title="Your scenarios" count={rows.length}>
        {rows.length === 0 ? (
          <div className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">
            <p>No scenarios yet.</p>
            <Link href="/scenarios/new" className="mt-2 inline-flex min-h-11 items-center font-semibold text-accent hover:underline">
              Build your first one
            </Link>
          </div>
        ) : (
          <form method="get" action="/scenarios/compare" className="min-w-0">
            <ul aria-label="Your scenarios" className="grid min-w-0 gap-3 lg:grid-cols-2">
              {rows.map((s) => (
                <li key={s.id} className="min-w-0 rounded-card border border-border bg-surface p-4">
                  <h3 className="font-semibold wrap-anywhere">
                    <Link href={`/scenarios/${s.id}`} className="text-accent hover:underline">
                      {s.name}
                    </Link>
                  </h3>
                  <p className="mt-0.5 text-sm text-muted wrap-anywhere">
                    {s.baseApp ? `Based on ${s.baseApp} · ` : ""}
                    Updated {s.updatedAt.toISOString().slice(0, 10)}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-card border border-border px-3 text-sm font-semibold">
                      <input type="checkbox" name="ids" value={s.id} className="size-4" aria-label={`Compare ${s.name}`} />
                      <span>Compare</span>
                    </label>
                    <Link href={`/scenarios/${s.id}`} className={buttonSecondary}>
                      Open
                    </Link>
                    <ScenarioRowActions id={s.id} name={s.name} />
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="submit" className={buttonPrimary}>
                Compare selected
              </button>
              <p className="text-sm text-muted wrap-anywhere">
                Tick {minCompare} to {maxCompare} scenarios, then compare their totals on every cloud.
              </p>
            </div>
          </form>
        )}
      </Panel>
    </>
  );
}
