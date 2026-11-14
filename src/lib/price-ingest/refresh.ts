import "server-only";
import { eq, sql } from "drizzle-orm";
import { type Subject, assertCan } from "@/lib/access";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { ConflictError } from "@/lib/errors";
import { runFootprintRefresh, type TextFetcher } from "@/lib/footprint/refresh";
import { log } from "@/lib/log";
import { safeErrorFields } from "@/lib/safe-error";
import { consumeRate } from "@/lib/usage";
import { type PriceFetcher, fetchPriceSource } from "./fetch";
import { normalize } from "./normalize";
import { RUN_DEADLINE_MS, collectSource } from "./sources";
import { type PriceSourceId } from "./types";
import { MAX_QUARANTINE_NOTES, upsertPrices } from "./upsert";

/**
 * One refresh run = ONE source (the spec's Cloud Run budget and 300 s request timeout allow one slow source per
 * call; the scheduler calls five times a night). Which source: the stalest whose last SUCCESS is older than 20 h,
 * ordered by last ATTEMPT, so a source that keeps failing goes to the back of the line instead of starving the others.
 * A Postgres advisory lock keeps two runs from overlapping.
 */
export const REFRESH_SOURCES = ["aws_ec2", "aws_other", "azure", "gcp", "oci", "footprint"] as const;
export type RefreshSourceId = (typeof REFRESH_SOURCES)[number];
export const STALE_AFTER_HOURS = 20;
export const ADMIN_REFRESH_WINDOW_SECONDS = 600;
const LOCK_NAME = "price-refresh";

export type RefreshDeps = {
  fetch?: PriceFetcher;
  /** Overrides `COST_SCALER_GCP_PRICING_API_KEY` (tests). Pass `null` to simulate it being unset. */
  gcpApiKey?: string | null;
  footprintFetcher?: TextFetcher;
  now?: () => Date;
};

export type RefreshReport =
  | { ran: false; reason: "nothing_stale" }
  | {
      ran: true;
      source: RefreshSourceId;
      outcome: "ok" | "partial" | "failed" | "unavailable";
      upserted: number;
      missing: number;
      quarantined: number;
      bytes: number;
      seconds: number;
      errorCode: string | null;
    };

export async function runPriceRefresh(
  actor: Subject,
  trigger: "scheduler" | "admin",
  opts: { source?: RefreshSourceId; deps?: RefreshDeps } = {},
): Promise<RefreshReport> {
  assertCan(actor, "write", "price_refresh");
  assertCan(actor, "write", "price_point");
  assertCan(actor, "write", "footprint_app");
  const deps = opts.deps ?? {};
  const now = deps.now ?? (() => new Date());

  // An admin's button: one press per 10 minutes, counted in the shared rate ledger.
  if (trigger === "admin" && actor && actor.role === "admin") {
    const adminId = actor.id;
    await db().transaction((tx) => consumeRate(tx, adminId, "refresh", 1, "Prices were refreshed a moment ago. Try again in a few minutes.", { windowSeconds: ADMIN_REFRESH_WINDOW_SECONDS }));
  }

  // The lock lives on this transaction's connection for the whole run; the work itself uses the normal pool.
  return db().transaction(async (tx) => {
    const [{ ok }] = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${LOCK_NAME}, 0)) as ok`);
    if (!ok) throw new ConflictError("A price refresh is already running.");
    const gcpKey = deps.gcpApiKey === undefined ? env().COST_SCALER_GCP_PRICING_API_KEY : (deps.gcpApiKey ?? undefined);
    await recordGcpUnavailable(gcpKey, now());
    const source = opts.source ?? (await pickSource(now(), trigger, Boolean(gcpKey)));
    if (!source) return { ran: false, reason: "nothing_stale" } satisfies RefreshReport;
    if (source === "gcp" && !gcpKey) return unavailableReport(await recordUnavailable("gcp", trigger));
    if (source === "footprint") {
      const r = await runFootprintRefresh(actor, trigger, deps.footprintFetcher);
      return { ran: true, source, outcome: r.outcome, upserted: r.apps, missing: 0, quarantined: 0, bytes: r.bytes, seconds: 0, errorCode: r.errorCode } satisfies RefreshReport;
    }
    return runPriceSource(source, trigger, { fetch: deps.fetch ?? fetchPriceSource, gcpApiKey: gcpKey });
  });
}

type Ledger = { source: string; last_ok: Date | string | null; last_try: Date | string | null };
const ms = (v: Date | string | null | undefined) => (v ? new Date(v).getTime() : 0);

async function pickSource(now: Date, trigger: "scheduler" | "admin", hasGcpKey: boolean): Promise<RefreshSourceId | null> {
  const rows = await db().execute<Ledger>(sql`
    select source,
           max(finished_at) filter (where outcome in ('ok', 'partial')) as last_ok,
           max(finished_at) filter (where outcome <> 'running') as last_try
    from price_refresh group by source`);
  const bySource = new Map(rows.map((r) => [r.source, r]));
  const cutoff = now.getTime() - STALE_AFTER_HOURS * 3600_000;
  const candidates = REFRESH_SOURCES.filter((s) => s !== "gcp" || hasGcpKey)
    .map((s) => ({ s, ok: ms(bySource.get(s)?.last_ok), tried: ms(bySource.get(s)?.last_try) }))
    // The scheduler only runs what is stale; an admin pressing "Refresh now" gets the stalest source regardless.
    .filter((c) => trigger === "admin" || c.ok < cutoff);
  // Never attempted first, then by last attempt, so repeated failures rotate instead of starving the rest.
  candidates.sort((x, y) => x.tried - y.tried || x.ok - y.ok);
  return candidates[0]?.s ?? null;
}

/** "Prices unavailable" for Google Cloud while its key is unset: recorded once per stale window, no fetch. */
async function recordGcpUnavailable(key: string | undefined, now: Date): Promise<void> {
  if (key) return;
  const [last] = await db().select({ at: schema.priceRefresh.startedAt, outcome: schema.priceRefresh.outcome }).from(schema.priceRefresh).where(eq(schema.priceRefresh.source, "gcp")).orderBy(sql`started_at desc`).limit(1);
  if (last && last.outcome === "unavailable" && now.getTime() - last.at.getTime() < STALE_AFTER_HOURS * 3600_000) return;
  await recordUnavailable("gcp", "scheduler");
}

async function recordUnavailable(source: "gcp", trigger: "scheduler" | "admin") {
  await db().insert(schema.priceRefresh).values({ source, trigger, outcome: "unavailable", errorCode: "api_key_missing", finishedAt: new Date() });
  return source;
}

const unavailableReport = (source: "gcp"): RefreshReport => ({ ran: true, source, outcome: "unavailable", upserted: 0, missing: 0, quarantined: 0, bytes: 0, seconds: 0, errorCode: "api_key_missing" });

async function runPriceSource(source: PriceSourceId, trigger: "scheduler" | "admin", ctx: { fetch: PriceFetcher; gcpApiKey?: string }): Promise<RefreshReport> {
  const { priceRefresh } = schema;
  const started = performance.now();
  const [run] = await db().insert(priceRefresh).values({ source, trigger }).returning({ id: priceRefresh.id });
  let report: Extract<RefreshReport, { ran: true }>;
  let detail: Record<string, unknown> = {};
  try {
    const signal = AbortSignal.timeout(RUN_DEADLINE_MS);
    const got = await collectSource(source, { fetch: ctx.fetch, signal, gcpApiKey: ctx.gcpApiKey });
    const normalized = normalize({ source, groupsRead: got.groupsRead, rows: got.rows });
    const written = await upsertPrices(db(), normalized.rows);
    const seconds = Math.round(((performance.now() - started) / 1000) * 10) / 10;
    const failedAll = got.groupsRead.size === 0;
    const outcome = failedAll ? "failed" : got.failed.length ? "partial" : "ok";
    // One short code on the row; the per-group list (codes only) is in `detail`.
    const errorCode = got.failed[0]?.code ?? null;
    detail = {
      seconds,
      bytesByGroup: got.bytesByGroup,
      failed: got.failed,
      skippedRows: got.skipped,
      notListed: normalized.notListed.slice(0, 100).map((n) => ({ cloud: n.cloud, skuKey: n.skuKey, reason: n.reason })),
      quarantined: written.quarantined.slice(0, MAX_QUARANTINE_NOTES),
    };
    report = { ran: true, source, outcome, upserted: written.upserted, missing: normalized.notListed.length, quarantined: written.quarantined.length, bytes: got.bytes, seconds, errorCode };
  } catch (err) {
    log.error("price.refresh.error", { source, ...safeErrorFields(err) });
    const seconds = Math.round(((performance.now() - started) / 1000) * 10) / 10;
    // Fixed code only: never the message, which could carry a URL or database parameters.
    report = { ran: true, source, outcome: "failed", upserted: 0, missing: 0, quarantined: 0, bytes: 0, seconds, errorCode: "internal" };
    detail = { seconds };
  }
  await db()
    .update(priceRefresh)
    .set({ finishedAt: new Date(), outcome: report.outcome, rowsUpserted: report.upserted, rowsMissing: report.missing, rowsQuarantined: report.quarantined, bytes: report.bytes, errorCode: report.errorCode, detail })
    .where(eq(priceRefresh.id, run.id));
  log.info("price.refresh", { source, outcome: report.outcome, bytes: report.bytes, seconds: report.seconds, upserted: report.upserted, missing: report.missing, quarantined: report.quarantined, errorCode: report.errorCode });
  return report;
}
