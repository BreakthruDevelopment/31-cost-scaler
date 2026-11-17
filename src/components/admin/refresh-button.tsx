"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { refreshPricesAction, type RefreshReportView } from "@/app/admin/actions";
import { buttonPrimary } from "@/components/ui";
import { useAsyncAction } from "@/lib/use-async-action";

/**
 * "Refresh now": one source per press (the stalest), which can take minutes on the AWS EC2 file.
 * `useAsyncAction` resets the button in `finally` and shows a message for any throw, so a failed refresh never
 * leaves it disabled. A second press while one is running is refused by the server's advisory lock, and an admin
 * gets one press per 10 minutes; both come back as the server's own wording.
 */
export function RefreshButton() {
  const router = useRouter();
  const [report, setReport] = useState<RefreshReportView | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const work = useCallback(async () => {
    setReport(null);
    setRefused(null);
    const result = await refreshPricesAction();
    if (result.ok) {
      setReport(result.report);
      router.refresh(); // the counts and the per-source table above are now out of date
    } else {
      setRefused(result.error);
    }
  }, [router]);

  const { run, pending, error } = useAsyncAction(work, "Couldn't start a refresh. Try again in a moment.");

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={run} disabled={pending} className={buttonPrimary}>
          {pending ? "Refreshing…" : "Refresh now"}
        </button>
        {pending && (
          <p role="status" className="min-w-0 text-sm text-muted wrap-anywhere">
            Fetching one source. The AWS EC2 price file is hundreds of megabytes, so this can take a few minutes.
          </p>
        )}
      </div>
      {(error || refused) && (
        <p role="alert" className="mt-3 rounded-card border border-border bg-blocked-soft px-4 py-3 text-sm text-blocked wrap-anywhere">
          {error ?? refused}
        </p>
      )}
      {report && (
        <p role="status" className="mt-3 rounded-card border border-border bg-background px-4 py-3 text-sm wrap-anywhere">
          {report.ran
            ? `${report.source}: ${report.outcome}. ${report.upserted} rows written, ${report.quarantined} quarantined${report.errorCode ? `, error code ${report.errorCode}` : ""}.`
            : "Nothing was stale enough to refresh."}
        </p>
      )}
    </div>
  );
}
