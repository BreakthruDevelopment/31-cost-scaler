"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { requireRole } from "@/lib/auth/session";
import { HttpError } from "@/lib/errors";
import { runPriceRefresh } from "@/lib/price-ingest/refresh";

export type RefreshReportView = { ran: boolean; source: string | null; outcome: string | null; upserted: number; quarantined: number; errorCode: string | null };
export type RefreshActionState = { ok: true; report: RefreshReportView } | { ok: false; error: string };

/**
 * "Refresh now": refresh the stalest price source. Admin only, and `runPriceRefresh` authorizes again
 * (`assertCan`) before it touches anything.
 *
 * Not something a double tap can duplicate: the run takes a Postgres advisory lock (a second press while one is
 * running is a conflict, not a second fetch), the upserts are keyed on (cloud, sku, region, tier) so a rerun
 * rewrites the same rows, and an admin may only press it once per 10 minutes. The limit is only spent once a run
 * actually starts, so a press that lost the lock does not burn the slot.
 */
export async function refreshPricesAction(): Promise<RefreshActionState> {
  try {
    const admin = await requireRole("admin");
    const report = await runPriceRefresh(admin, "admin");
    revalidatePath("/admin");
    return {
      ok: true,
      report: report.ran
        ? { ran: true, source: report.source, outcome: report.outcome, upserted: report.upserted, quarantined: report.quarantined, errorCode: report.errorCode }
        : { ran: false, source: null, outcome: null, upserted: 0, quarantined: 0, errorCode: null },
    };
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, error: err.issues[0]?.message ?? "Invalid input" };
    // A known failure (not admin, too soon, already running) is a message; anything else is thrown so the client
    // shows its generic error and the server logs the real one. A server action is a public endpoint, so a plain
    // user who posts to it directly gets the refusal here, not a stack trace.
    if (err instanceof HttpError || err instanceof ForbiddenError || err instanceof UnauthorizedError) return { ok: false, error: err.message };
    throw err;
  }
}
