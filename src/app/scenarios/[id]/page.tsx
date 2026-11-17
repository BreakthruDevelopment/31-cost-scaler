import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PriceBanners } from "@/components/footprint/notices";
import { ScenarioBuilder } from "@/components/scenarios/builder";
import { PageIntro } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { HttpError } from "@/lib/errors";
import { type BuilderView, loadBuilder } from "@/lib/scenario-view";

export const metadata: Metadata = { title: "Scenario" };
export const dynamic = "force-dynamic";

/**
 * One of the caller's own scenarios. `loadBuilder` goes through `getScenario`, which scopes the query to the owner:
 * another user's id, a deleted one and a malformed one all answer 404 here, so an id tells a stranger nothing.
 */
export default async function ScenarioPage({ params }: PageProps<"/scenarios/[id]">) {
  const user = await requireUserOrRedirect();
  const { id } = await params;
  let view: BuilderView;
  try {
    view = await loadBuilder(user, id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  return (
    <>
      <PageIntro
        section="Scenarios"
        title={view.draft.name}
        description="Change what it runs, price it again on all four clouds, and save. Saving stores the result, so a comparison shows the numbers you saw."
      />
      <PriceBanners freshness={view.freshness} />
      <ScenarioBuilder scenario={view.scenario} initialDraft={view.draft} initialResult={view.result} apps={view.apps} />
    </>
  );
}
