import type { Metadata } from "next";
import { PriceBanners } from "@/components/footprint/notices";
import { ScenarioBuilder } from "@/components/scenarios/builder";
import { PageIntro } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { loadBuilder } from "@/lib/scenario-view";

export const metadata: Metadata = { title: "New scenario" };
export const dynamic = "force-dynamic";

/** The builder with nothing saved yet: the starting spec, priced on all four clouds so the first paint shows numbers. */
export default async function NewScenarioPage() {
  const user = await requireUserOrRedirect();
  const view = await loadBuilder(user, null);
  return (
    <>
      <PageIntro
        section="Scenarios"
        title="New scenario"
        description="Set what you expect to run, price it on all four clouds, then save it so you can compare it later."
      />
      <PriceBanners freshness={view.freshness} />
      <ScenarioBuilder scenario={null} initialDraft={view.draft} initialResult={view.result} apps={view.apps} />
    </>
  );
}
