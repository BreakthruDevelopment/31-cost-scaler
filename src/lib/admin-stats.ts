import "server-only";
import { count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Actor } from "@/lib/auth/rbac";
import { type Subject, assertCan } from "@/lib/access";
import { db, schema } from "@/lib/db";
import { advisorDailyModelCalls } from "@/lib/env";
import { latestFootprintRefresh } from "@/lib/footprint/refresh";
import { trimmed } from "@/lib/text";
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

/** How far back the quarantine notes are read: a quarantine often dates from an earlier run than the latest. */
export const QUARANTINE_RUNS_SCANNED = 40;

export const QUARANTINE_REASON: Record<string, string> = {
  out_of_bounds: "outside the sanity bounds for its unit",
  jump_over_3x: "more than 3x its last value",
};

export type QuarantineRejection = { rejectedMicros: number; previousMicros: number | null; reason: string; at: Date };

/** Keyed the way a note identifies a row: cloud and normalized SKU. */
export const quarantineKey = (row: { cloud: string; skuKey: string }) => `${row.cloud}|${row.skuKey}`;

const quarantineNote = z.object({
  cloud: trimmed(20),
  skuKey: trimmed(140),
  /** What was stored when the fetch was refused; null when the SKU was new (no row was written at all). */
  oldMicros: z.number().int().nullable().catch(null),
  /** The refused price. Required: a note without it tells an admin nothing, so it is dropped on its own. */
  newMicros: z.number().int(),
  reason: trimmed(40).catch(""),
});

/**
 * The value each quarantine actually refused, which the price row itself does not hold, keyed by {@link quarantineKey}.
 *
 * `upsertPrices` quarantines by flipping the row's `status` and nothing else, so `usd_micros` and `fetched_at` stay
 * at the last **accepted** price: reading them as "the rejected value" prints the old, valid number and never the
 * one that tripped the 3x rule. The refused price is in the run's `detail.quarantined` notes (`newMicros`), matched
 * back to the row by cloud and normalized SKU — the only key a note carries.
 *
 * The newest {@link QUARANTINE_RUNS_SCANNED} runs that recorded any notes are scanned, newest first, and the first
 * note for a key wins. A row quarantined before that window has no note, and the page then says the refused value
 * was not recorded rather than showing a number that is not it.
 */
export async function quarantineRejections(actor: Subject): Promise<Map<string, QuarantineRejection>> {
  assertCan(actor, "read", "admin_stats");
  const { priceRefresh } = schema;
  const runs = await db()
    .select({ startedAt: priceRefresh.startedAt, notes: sql<unknown>`${priceRefresh.detail} -> 'quarantined'` })
    .from(priceRefresh)
    .where(sql`jsonb_typeof(${priceRefresh.detail} -> 'quarantined') = 'array'`)
    .orderBy(desc(priceRefresh.startedAt))
    .limit(QUARANTINE_RUNS_SCANNED);

  const found = new Map<string, QuarantineRejection>();
  for (const run of runs) {
    // Each note is parsed on its own: one note written in a shape we don't know must not hide the others, the way
    // a `.catch([])` around the whole array would.
    for (const raw of Array.isArray(run.notes) ? run.notes : []) {
      const note = quarantineNote.safeParse(raw);
      if (!note.success) continue;
      const key = quarantineKey(note.data);
      if (found.has(key)) continue; // newest run first
      found.set(key, { rejectedMicros: note.data.newMicros, previousMicros: note.data.oldMicros, reason: note.data.reason, at: run.startedAt });
    }
  }
  return found;
}

/**
 * The drift report the footprint refresh stores in `detail`, re-parsed (jsonb is never trusted by shape).
 *
 * Lengths are trimmed here, never used to reject: a length cap on a mismatch would make ONE odd row empty the
 * whole array, and the admin would read "no drift" on a page whose only job is to say there is some. Measured:
 * a 70-character profile key against a `.max(60)` silently hid two real mismatches. `trimmed` is shared with
 * `src/lib/advice-view.ts`, which reads the other jsonb column this app renders.
 */
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
