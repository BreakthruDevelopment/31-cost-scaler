import "server-only";
import { count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Actor } from "@/lib/auth/rbac";
import { type Subject, assertCan } from "@/lib/access";
import { db, schema } from "@/lib/db";
import { advisorDailyModelCalls } from "@/lib/env";
import { latestFootprintRefresh } from "@/lib/footprint/refresh";
import { dailyCount } from "@/lib/usage";

/**
 * What an admin may see: counts, refresh status and the profile-drift flag. Never a scenario, a result, an advice
 * row or a user's name. Admin only (403 for anyone else).
 */
export async function adminStats(actor: Actor) {
  assertCan(actor, "read", "admin_stats");
  const [[users], [scenarios], [results], [adviceRows], [footprint], [prices], [quarantined]] = await Promise.all([
    db().select({ n: count() }).from(schema.user),
    db().select({ n: count() }).from(schema.scenario),
    db().select({ n: count() }).from(schema.scenarioResult),
    db().select({ n: count() }).from(schema.advice),
    db().select({ n: count() }).from(schema.footprintApp),
    db().select({ n: count() }).from(schema.pricePoint).where(eq(schema.pricePoint.status, "active")),
    db().select({ n: count() }).from(schema.pricePoint).where(eq(schema.pricePoint.status, "quarantined")),
  ]);
  const advisorToday = await dailyCount("ai");

  // The latest run per source: status only.
  const { priceRefresh } = schema;
  const latest = await db()
    .selectDistinctOn([priceRefresh.source], {
      source: priceRefresh.source,
      outcome: priceRefresh.outcome,
      startedAt: priceRefresh.startedAt,
      finishedAt: priceRefresh.finishedAt,
      rowsUpserted: priceRefresh.rowsUpserted,
      rowsMissing: priceRefresh.rowsMissing,
      rowsQuarantined: priceRefresh.rowsQuarantined,
      errorCode: priceRefresh.errorCode,
      driftCount: sql<number | null>`jsonb_array_length(${priceRefresh.detail} -> 'drift' -> 'mismatches')`,
    })
    .from(priceRefresh)
    .orderBy(priceRefresh.source, desc(priceRefresh.startedAt));

  return {
    users: users.n,
    scenarios: scenarios.n,
    savedResults: results.n,
    advice: adviceRows.n,
    // Model calls used today (reserved, then settled on requests sent) against ADVISOR_DAILY_MODEL_CALLS.
    advisor: { today: advisorToday, dailyCap: advisorDailyModelCalls(), dailyModelCalls: advisorDailyModelCalls() },
    footprintApps: footprint.n,
    prices: { active: prices.n, quarantined: quarantined.n },
    refresh: latest,
  };
}

/**
 * The quarantined price rows themselves (admin). A quarantined row is public price data that failed a sanity bound
 * or moved more than 3x since the last fetch: the old value is still being used, and an admin has to look at it.
 * Public data, so this is not a privacy step up from `adminStats`; it is capped so a bad feed can't flood the page.
 */
export const MAX_QUARANTINED_SHOWN = 50;

export async function listQuarantinedPrices(actor: Subject) {
  assertCan(actor, "read", "admin_stats");
  const p = schema.pricePoint;
  return db().select().from(p).where(eq(p.status, "quarantined")).orderBy(desc(p.fetchedAt)).limit(MAX_QUARANTINED_SHOWN);
}

/**
 * The drift report the footprint refresh stores in `detail`, re-parsed (jsonb is never trusted by shape).
 *
 * Lengths are trimmed here, never used to reject: a length cap on a mismatch would make ONE odd row empty the
 * whole array, and the admin would read "no drift" on a page whose only job is to say there is some. Measured:
 * a 70-character profile key against a `.max(60)` silently hid two real mismatches.
 */
const trimmed = (max: number) => z.string().transform((s) => s.slice(0, max));
const driftMismatch = z.object({ key: trimmed(120), expected: trimmed(60), actual: trimmed(60).nullable() });
const driftReport = z.object({
  files: z.record(z.string(), z.enum(["checked", "unavailable"])).catch({}),
  mismatches: z.array(driftMismatch).max(200).catch([]),
});

export type ProfileDrift = { checkedAt: string | null; files: Record<string, "checked" | "unavailable">; mismatches: { key: string; expected: string; actual: string | null }[] } | null;

/** Profile drift from the latest footprint refresh: null when it has never run or stored no report. */
export async function profileDrift(actor: Subject): Promise<ProfileDrift> {
  const row = await latestFootprintRefresh(actor);
  const parsed = driftReport.safeParse(row?.detail?.drift);
  if (!parsed.success) return null;
  const checkedAt = typeof row?.detail?.checkedAt === "string" ? row.detail.checkedAt : (row?.finishedAt?.toISOString() ?? null);
  return { checkedAt, files: parsed.data.files, mismatches: parsed.data.mismatches };
}
