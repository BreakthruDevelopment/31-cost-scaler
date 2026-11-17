import type { Metadata } from "next";
import { RefreshButton } from "@/components/admin/refresh-button";
import { COMPONENT_LABEL, UNIT_LABEL, cloudLabel, fetchedOn, formatUnitUsd, safeSourceHref, sourceHost } from "@/components/prices/format";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile, StatusBadge, type Status } from "@/components/ui";
import {
  MAX_QUARANTINED_SHOWN,
  QUARANTINE_REASON,
  QUARANTINE_RUNS_SCANNED,
  adminStats,
  listQuarantinedPrices,
  profileDrift,
  quarantineKey,
  quarantineRejections,
} from "@/lib/admin-stats";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { ADMIN_REFRESH_WINDOW_SECONDS, STALE_AFTER_HOURS } from "@/lib/price-ingest/refresh";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";
// "Refresh now" runs one source inline; the service's request timeout for this app is 300 s (issue 31.8).
export const maxDuration = 300;

const SOURCE_LABEL: Record<string, string> = {
  aws_ec2: "AWS — EC2 price file",
  aws_other: "AWS — other services",
  azure: "Azure retail prices",
  gcp: "Google Cloud billing catalog",
  oci: "Oracle price list",
  footprint: "Portfolio footprint (apps.yaml)",
};

const OUTCOME: Record<string, { status: Status; label: string }> = {
  ok: { status: "healthy", label: "OK" },
  partial: { status: "degraded", label: "Partial" },
  failed: { status: "failed", label: "Failed" },
  running: { status: "building", label: "Running" },
  unavailable: { status: "not-started", label: "Unavailable" },
};

/** A timestamp an admin can act on: the date and the time, in UTC, with no locale guessing. */
function stamp(at: Date | null): string {
  return at ? `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC` : "—";
}

export default async function AdminPage() {
  const admin = await requireRoleOrRedirect("admin");
  const [stats, quarantined, rejected, drift] = await Promise.all([
    adminStats(admin),
    listQuarantinedPrices(admin),
    quarantineRejections(admin),
    profileDrift(admin),
  ]);

  type RefreshRow = (typeof stats.refresh)[number];
  const refreshColumns: Column<RefreshRow>[] = [
    {
      key: "source",
      header: "Source",
      primary: true,
      cell: (r) => <span className="wrap-anywhere">{SOURCE_LABEL[r.source] ?? r.source}</span>,
    },
    {
      key: "outcome",
      header: "Last run",
      cell: (r) => {
        const o = OUTCOME[r.outcome] ?? { status: "not-started" as Status, label: r.outcome };
        return <StatusBadge status={o.status} label={o.label} />;
      },
    },
    { key: "started", header: "Started", className: "whitespace-nowrap", cell: (r) => <span className="text-sm">{stamp(r.startedAt)}</span> },
    { key: "finished", header: "Finished", className: "whitespace-nowrap", cell: (r) => <span className="text-sm">{stamp(r.finishedAt)}</span> },
    {
      key: "rows",
      header: "Rows",
      cell: (r) => (
        <span className="text-sm tabular-nums wrap-anywhere">
          {r.rowsUpserted} written · {r.rowsMissing} not listed · {r.rowsQuarantined} quarantined
        </span>
      ),
    },
    { key: "error", header: "Error code", cell: (r) => <span className="font-mono text-sm wrap-anywhere">{r.errorCode ?? "—"}</span> },
  ];

  type QuarantinedRow = (typeof quarantined)[number];
  const quarantinedColumns: Column<QuarantinedRow>[] = [
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
    { key: "cloud", header: "Cloud", cell: (r) => <span className="wrap-anywhere">{cloudLabel(r.cloud)}</span> },
    { key: "component", header: "Component", cell: (r) => <span className="wrap-anywhere">{COMPONENT_LABEL[r.component]}</span> },
    {
      key: "rejected",
      header: "Rejected value",
      cell: (r) => {
        // Never r.usdMicros: quarantining changes the row's status only, so that field is the old accepted value.
        const note = rejected.get(quarantineKey(r));
        if (!note) {
          return (
            <span className="block min-w-0 text-sm text-muted wrap-anywhere">
              Not recorded in the last {QUARANTINE_RUNS_SCANNED} runs. Check the source.
            </span>
          );
        }
        return (
          <span className="block min-w-0">
            <span className="block font-semibold tabular-nums text-blocked wrap-anywhere">{formatUnitUsd(note.rejectedMicros)}</span>
            <span className="block text-sm text-muted wrap-anywhere">
              {UNIT_LABEL[r.unit]} · {QUARANTINE_REASON[note.reason] ?? "refused by a sanity check"} · refused {fetchedOn(note.at)}
            </span>
          </span>
        );
      },
    },
    {
      key: "kept",
      header: "Last accepted, not in estimates",
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block font-semibold tabular-nums wrap-anywhere">{formatUnitUsd(r.usdMicros)}</span>
          <span className="block text-sm text-muted wrap-anywhere">{UNIT_LABEL[r.unit]} · accepted {fetchedOn(r.fetchedAt)} · kept for reference only</span>
        </span>
      ),
    },
    {
      key: "source",
      header: "Source",
      cell: (r) => {
        const href = safeSourceHref(r.sourceUrl);
        return href ? (
          <a href={href} rel="noopener noreferrer" className="text-accent hover:underline wrap-anywhere">
            {sourceHost(r.sourceUrl)}
          </a>
        ) : (
          <span className="wrap-anywhere">{sourceHost(r.sourceUrl)}</span>
        );
      },
    },
  ];

  const driftFiles = drift ? Object.entries(drift.files) : [];
  const unchecked = driftFiles.filter(([, state]) => state === "unavailable").map(([cloud]) => cloud);

  return (
    <>
      <PageIntro
        section="Admin"
        title="Counts and price health."
        description="Totals, how each price source is doing and what the sanity checks rejected. No scenario, result or advice content is shown here, and none is readable by an admin."
      />

      <StatGrid>
        <StatTile value={stats.users} label="Users" tone="accent" />
        <StatTile value={stats.scenarios} label="Scenarios" />
        <StatTile value={stats.advice} label="Advisor answers" />
        <StatTile value={stats.footprintApps} label="Apps in the footprint" />
      </StatGrid>
      <StatGrid>
        <StatTile value={stats.prices.active} label="Active price rows" />
        <StatTile value={stats.prices.quarantined} label="Quarantined price rows" tone={stats.prices.quarantined > 0 ? "blocked" : "default"} />
        <StatTile value={stats.savedResults} label="Saved results" />
        {stats.advisor.dailyModelCalls > 0 && (
          <StatTile
            value={`${stats.advisor.today} / ${stats.advisor.dailyModelCalls}`}
            label="Advisor model calls today"
            tone={stats.advisor.today >= stats.advisor.dailyModelCalls ? "blocked" : "default"}
          />
        )}
      </StatGrid>

      <Panel title="Price refresh" count={stats.refresh.length} action={<RefreshButton />}>
        <p className="mb-4 text-sm text-muted">
          One source per run, the stalest whose last success is more than {STALE_AFTER_HOURS} hours old, under a
          database lock so two runs never overlap. The scheduler fires five times a night; this button is for one run
          now and works once every {ADMIN_REFRESH_WINDOW_SECONDS / 60} minutes. Rerunning rewrites the same rows, so
          pressing it twice cannot double anything.
        </p>
        <DataList
          caption="The latest run of each price source"
          rows={stats.refresh}
          rowKey={(r) => r.source}
          columns={refreshColumns}
          empty="No refresh has run yet. Press “Refresh now”, or wait for tonight's scheduler."
        />
      </Panel>

      <Panel title="Quarantined prices" count={stats.prices.quarantined}>
        <p className="mb-4 text-sm text-muted">
          A fetched price outside its sanity bounds, or more than 3x the last accepted value, is quarantined. The row
          keeps that last accepted value for reference, but it is not used in estimates: while a row is quarantined,
          the component it priced is unpriced, and nothing is shown as $0. Both numbers are below, what was refused and
          what was last accepted, so they can be compared. A later fetch within 3x of the last accepted value clears the
          quarantine by itself. If the price has really moved, it trips the 3x rule on every run and stays quarantined
          until the bounds are widened, so check the source link and act then: the next refresh after that will take it.
        </p>
        <DataList
          caption="Quarantined price rows"
          rows={quarantined}
          rowKey={(r) => r.id}
          columns={quarantinedColumns}
          empty="Nothing is quarantined. Every fetched price passed its bounds."
        />
        {stats.prices.quarantined > quarantined.length && (
          <p className="mt-3 text-sm text-muted">
            Showing the {MAX_QUARANTINED_SHOWN} most recent of {stats.prices.quarantined}.
          </p>
        )}
      </Panel>

      <Panel title="Stack profile drift">
        {!drift ? (
          <div className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">
            The footprint import has not stored a drift check yet. It runs with the footprint source.
          </div>
        ) : (
          <>
            <p className="mb-4 text-sm text-muted wrap-anywhere">
              The sizes the estimates assume, checked against each cloud&apos;s{" "}
              <span className="font-mono">main.tf</span> in the infrastructure repo. Checked {fetchedOn(drift.checkedAt)}.
              {unchecked.length > 0 ? ` Not checked this run: ${unchecked.join(", ")} (the file could not be read).` : ""}
            </p>
            {drift.mismatches.length === 0 ? (
              <p role="status" className="rounded-card border border-border bg-live-soft px-4 py-3 text-sm text-live">
                No drift: every value in the checked-in profiles still matches the stacks.
              </p>
            ) : (
              <div role="alert" className="rounded-card border border-border bg-blocked-soft px-4 py-3 text-sm text-blocked">
                <p className="font-semibold">
                  {drift.mismatches.length} value{drift.mismatches.length === 1 ? "" : "s"} no longer match the stacks.
                  Every estimate that uses {drift.mismatches.length === 1 ? "it" : "them"} is wrong until the profile
                  is updated.
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {drift.mismatches.map((m) => (
                    <li key={m.key} className="wrap-anywhere">
                      <span className="font-mono">{m.key}</span>: profile says {m.expected}, the stack says{" "}
                      {m.actual ?? "nothing we could find"}.
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Panel>
    </>
  );
}
