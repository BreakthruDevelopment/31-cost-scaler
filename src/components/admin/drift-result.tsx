import { cloudLabel } from "@/components/prices/format";
import type { CloudId, DriftReport } from "@/lib/footprint/stack-profiles";

/**
 * The drift result. A green all-clear needs every stack file to have been checked: "no mismatches" over files we
 * could not read is not "no drift". None checked is "unknown" and shows no result at all.
 */
export function DriftResult({ drift, checkedOn }: { drift: DriftReport; checkedOn: string }) {
  const entries = Object.entries(drift.files) as [CloudId, "checked" | "unavailable"][];
  const checked = entries.filter(([, s]) => s === "checked").map(([c]) => cloudLabel(c));
  const unchecked = entries.filter(([, s]) => s !== "checked").map(([c]) => cloudLabel(c));

  if (checked.length === 0) {
    return (
      <p role="status" className="rounded-card border border-border bg-background px-4 py-3 text-sm text-muted">
        Drift is unknown: none of the stack files could be read on the last check ({checkedOn}), so nothing was compared.
      </p>
    );
  }

  return (
    <>
      <p className="mb-4 text-sm text-muted wrap-anywhere">
        The sizes the estimates assume, checked against each cloud&apos;s <span className="font-mono">main.tf</span> in the
        infrastructure repo. Checked {checkedOn}.
        {unchecked.length > 0 ? ` Not checked this run: ${unchecked.join(", ")} (the file could not be read).` : ""}
      </p>
      {drift.mismatches.length > 0 && (
        <div role="alert" className="rounded-card border border-border bg-blocked-soft px-4 py-3 text-sm text-blocked">
          <p className="font-semibold">
            {drift.mismatches.length} value{drift.mismatches.length === 1 ? "" : "s"} no longer match the stacks. Every
            estimate that uses {drift.mismatches.length === 1 ? "it" : "them"} is wrong until the profile is updated.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {drift.mismatches.map((m) => (
              <li key={m.key} className="wrap-anywhere">
                <span className="font-mono">{m.key}</span>: profile says {m.expected}, the stack says {m.actual ?? "nothing we could find"}.
              </li>
            ))}
          </ul>
        </div>
      )}
      {drift.mismatches.length === 0 && unchecked.length === 0 && (
        <p role="status" className="rounded-card border border-border bg-live-soft px-4 py-3 text-sm text-live">
          No drift: every value in the checked-in profiles still matches the stacks.
        </p>
      )}
      {drift.mismatches.length === 0 && unchecked.length > 0 && (
        <p role="status" className="rounded-card border border-border bg-background px-4 py-3 text-sm text-muted">
          Incomplete: no drift in {checked.join(", ")}, but {unchecked.join(", ")} could not be checked, so the other
          profiles may have drifted.
        </p>
      )}
    </>
  );
}
