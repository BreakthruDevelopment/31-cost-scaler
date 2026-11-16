import "server-only";
import { count, desc, eq, sql } from "drizzle-orm";
import { type Actor } from "@/lib/auth/rbac";
import { assertCan } from "@/lib/access";
import { db, schema } from "@/lib/db";
import { advisorDailyModelCalls } from "@/lib/env";
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
