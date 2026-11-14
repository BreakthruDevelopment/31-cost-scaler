import type { Metadata } from "next";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { MAX_SCENARIOS_PER_USER, listScenarios } from "@/lib/scenarios";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

type Row = Awaited<ReturnType<typeof listScenarios>>[number];

// A placeholder until the scenario screens (issue 31.6) replace it: your own scenarios, newest change first.
export default async function DashboardPage() {
  const user = await requireUserOrRedirect();
  const scenarios = await listScenarios(user);
  const columns: Column<Row>[] = [
    { key: "name", header: "Scenario", primary: true, cell: (s) => <span className="font-semibold break-words">{s.name}</span> },
    { key: "base", header: "Based on", cell: (s) => <span className="text-muted break-words">{s.baseApp ?? "—"}</span> },
    { key: "updated", header: "Updated", className: "whitespace-nowrap", cell: (s) => s.updatedAt.toISOString().slice(0, 10) },
  ];
  return (
    <>
      <PageIntro section="Dashboard" title={`Hi, ${user.name}`} description={`Signed in as ${user.email}. Role: ${user.role}.`} />
      <StatGrid>
        <StatTile value={scenarios.length} label="Your scenarios" tone="accent" />
        <StatTile value={MAX_SCENARIOS_PER_USER} label="Limit per user" />
      </StatGrid>
      <Panel title="Your scenarios" count={scenarios.length}>
        <DataList caption="Scenarios" rows={scenarios} rowKey={(s) => s.id} columns={columns} empty="No scenarios yet." />
      </Panel>
    </>
  );
}
