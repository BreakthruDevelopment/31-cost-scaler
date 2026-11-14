import "server-only";
import { asc, desc, eq } from "drizzle-orm";
import { ZodError } from "zod";
import { type Subject, assertCan } from "@/lib/access";
import { db, schema } from "@/lib/db";
import { log } from "@/lib/log";
import { SafeFetchError, safeFetch } from "@/lib/safe-fetch";
import { parseAppsYaml } from "./apps-yaml";
import { type CloudId, type DriftReport, STACK_PROFILES, checkProfileDrift } from "./stack-profiles";
import { replaceFootprint } from "./store";

/**
 * The portfolio's current environment, read from the infra repo. The host and paths are constants: nothing a user
 * sends ever becomes part of these URLs, and `safeFetch` still refuses redirects, non-public addresses and big bodies.
 */
const RAW = "https://raw.githubusercontent.com/BreakthruDevelopment/30-apps-infra/main";
export const APPS_YAML_URL = `${RAW}/apps.yaml`;
export const stackFileUrl = (cloud: CloudId) => `${RAW}/${STACK_PROFILES[cloud].file}`;

const MAX_STACK_FILE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** Fetches one of the fixed URLs above and returns its text. Tests inject a fake; production uses `safeFetch`. */
export type TextFetcher = (url: string, maxBytes: number) => Promise<{ status: number; text: string }>;

export const defaultFetcher: TextFetcher = async (url, maxBytes) => {
  // maxRedirects 0: a redirect would leave the fixed host, so it is treated as a failure (status 3xx).
  const res = await safeFetch(url, { maxBytes, timeoutMs: FETCH_TIMEOUT_MS, maxRedirects: 0, headers: { accept: "text/plain" } });
  return { status: res.status, text: res.body.toString("utf8") };
};

/** Public read: every app in the current footprint, by name. */
export async function listFootprint(): Promise<(typeof schema.footprintApp.$inferSelect)[]> {
  assertCan(null, "read", "footprint_app");
  return db().select().from(schema.footprintApp).orderBy(asc(schema.footprintApp.name));
}

export type FootprintRefreshResult = { id: string; outcome: "ok" | "partial" | "failed"; apps: number; bytes: number; errorCode: string | null; drift: DriftReport | null };

/**
 * Refresh the `footprint` source: import `apps.yaml`, replace `footprint_app` in one transaction, then check the
 * stack profiles against `stacks/<cloud>/main.tf` and record the drift report. One `price_refresh` row records the
 * run. The 31.2 refresh route calls this for source `footprint`, after taking its advisory lock; `actor` is
 * `SYSTEM` (scheduler bearer token) or an admin. Errors become fixed codes: no URL, key or response text is stored or logged.
 *
 * `outcome`: `ok`; `partial` when a stack file couldn't be read (apps imported, drift unchecked for that cloud);
 * `failed` when `apps.yaml` couldn't be fetched or validated (the previous footprint stays).
 */
export async function runFootprintRefresh(actor: Subject, trigger: "scheduler" | "admin", fetcher: TextFetcher = defaultFetcher): Promise<FootprintRefreshResult> {
  assertCan(actor, "write", "price_refresh");
  assertCan(actor, "write", "footprint_app");
  const { priceRefresh } = schema;
  const [run] = await db().insert(priceRefresh).values({ source: "footprint", trigger }).returning({ id: priceRefresh.id });
  let bytes = 0;
  const finish = async (r: Omit<FootprintRefreshResult, "id" | "bytes">) => {
    await db()
      .update(priceRefresh)
      .set({
        finishedAt: new Date(),
        outcome: r.outcome,
        rowsUpserted: r.apps,
        rowsMissing: r.drift ? Object.values(r.drift.files).filter((f) => f === "unavailable").length : 0,
        bytes,
        errorCode: r.errorCode,
        detail: r.drift ? { drift: r.drift, checkedAt: new Date().toISOString() } : null,
      })
      .where(eq(priceRefresh.id, run.id));
    log.info("footprint.refresh", { outcome: r.outcome, apps: r.apps, bytes, errorCode: r.errorCode, driftCount: r.drift?.mismatches.length ?? null });
    return { id: run.id, bytes, ...r };
  };

  try {
    const yamlRes = await fetcher(APPS_YAML_URL, 256 * 1024);
    bytes += Buffer.byteLength(yamlRes.text);
    if (yamlRes.status !== 200) return await finish({ outcome: "failed", apps: 0, errorCode: `http_${yamlRes.status}`, drift: null });
    const parsed = parseAppsYaml(yamlRes.text);
    await replaceFootprint(db(), parsed.apps, parsed.sourceCommit);

    const files: Record<CloudId, string | null> = { aws: null, azure: null, gcp: null, oci: null };
    for (const cloud of Object.keys(files) as CloudId[]) {
      try {
        const res = await fetcher(stackFileUrl(cloud), MAX_STACK_FILE_BYTES);
        bytes += Buffer.byteLength(res.text);
        files[cloud] = res.status === 200 ? res.text : null;
      } catch {
        files[cloud] = null; // an unreadable stack file is "unchecked", never a failed import
      }
    }
    const drift = checkProfileDrift(files);
    const unchecked = Object.values(drift.files).includes("unavailable");
    return await finish({ outcome: unchecked ? "partial" : "ok", apps: parsed.apps.length, errorCode: unchecked ? "stack_file_unavailable" : null, drift });
  } catch (err) {
    return await finish({ outcome: "failed", apps: 0, errorCode: errorCode(err), drift: null });
  }
}

function errorCode(err: unknown): string {
  if (err instanceof SafeFetchError) return `fetch_${err.code}`;
  if (err instanceof ZodError) return "invalid_apps_yaml";
  if (err instanceof Error && err.name.startsWith("YAML")) return "invalid_yaml";
  if (err instanceof Error && err.message === "apps.yaml too large") return "too_large";
  return "internal";
}

/** Admin/system read: the latest footprint refresh (counts, outcome and drift report). */
export async function latestFootprintRefresh(actor: Subject) {
  assertCan(actor, "read", "price_refresh");
  const { priceRefresh } = schema;
  const [row] = await db().select().from(priceRefresh).where(eq(priceRefresh.source, "footprint")).orderBy(desc(priceRefresh.startedAt)).limit(1);
  return row ?? null;
}
