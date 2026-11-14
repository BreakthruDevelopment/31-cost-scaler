import "server-only";
import { count, desc, eq, sql } from "drizzle-orm";
import { type Actor } from "@/lib/auth/rbac";
import { assertCan } from "@/lib/access";
import { db, schema } from "@/lib/db";
import { dailyCount } from "@/lib/usage";

/** App-wide advisor budget per UTC day (spec: `AI_DAILY_CAP` 200). */
export const AI_DAILY_CAP = Number(process.env.AI_DAILY_CAP) > 0 ? Number(process.env.AI_DAILY_CAP) : 200;

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
    .select({
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
    .orderBy(desc(priceRefresh.startedAt))
    .limit(60);
  const bySource = new Map<string, (typeof latest)[number]>();
  for (const r of latest) if (!bySource.has(r.source)) bySource.set(r.source, r);

  return {
    users: users.n,
    scenarios: scenarios.n,
    savedResults: results.n,
    advice: adviceRows.n,
    advisor: { today: advisorToday, dailyCap: AI_DAILY_CAP },
    footprintApps: footprint.n,
    prices: { active: prices.n, quarantined: quarantined.n },
    refresh: [...bySource.values()],
  };
}
