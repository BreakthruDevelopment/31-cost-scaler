import "server-only";
import { z } from "zod";
import { type Subject, assertCan } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { listFootprint } from "@/lib/footprint/refresh";
import { REGIONS } from "@/lib/price-ingest/types";
import { listPricePoints } from "@/lib/prices";
import { getScenario } from "@/lib/scenarios";
import { jsonHasNul } from "@/lib/text";
import { consumeRate } from "@/lib/usage";
import { priceScenario, type ScenarioPrice } from "./scenario";
import { type MoveResult, migrationBreakEven } from "./move";
import { TEN_X_PRESET } from "./presets";
import { footprintName, scenarioSpec, type ScenarioSpec } from "./spec";
import { buildPriceTable } from "./table";
import { CLOUD_ORDER, type Cloud, type PriceTable } from "./types";

/** Pricing runs per user per hour (the engine is pure and cheap; this just stops a loop). */
export const PRICE_RUNS_PER_HOUR = 120;
const PRICE_RUN_MESSAGE = "Too many pricing runs this hour. Try again later.";

/**
 * The active price rows as the engine's input. Public data: anyone may read it. Only each cloud's reference region
 * (`REGIONS`, the one price ingestion reads) is used, so a stray row from another region can never be priced.
 */
export async function loadPriceTable(subject: Subject = null): Promise<PriceTable> {
  assertCan(subject, "read", "price_point");
  const rows = await listPricePoints();
  return buildPriceTable(
    rows.filter((r) => r.region === REGIONS[r.cloud]).map((r) => ({
      id: r.id,
      cloud: r.cloud,
      component: r.component,
      skuKey: r.skuKey,
      unit: r.unit,
      usdMicros: r.usdMicros,
      tierStart: r.tierStart,
      tierEnd: r.tierEnd,
      sourceUrl: r.sourceUrl,
      fetchedAt: r.fetchedAt,
    })),
  );
}

async function chargeRun(actor: Actor): Promise<void> {
  await db().transaction((tx) => consumeRate(tx, actor.id, "price_run", PRICE_RUNS_PER_HOUR, PRICE_RUN_MESSAGE));
}

export const priceInput = z.strictObject({ spec: scenarioSpec, conditionalCredits: z.boolean().optional() });

/** Price an unsaved spec (the builder's preview) on all four clouds. 120 runs per user per hour. */
export async function priceSpec(actor: Actor, input: unknown): Promise<ScenarioPrice> {
  assertCan(actor, "read", "price_point");
  if (jsonHasNul(input)) throw new BadRequestError("Text can't contain null characters");
  const data = priceInput.parse(input);
  await chargeRun(actor);
  return priceScenario(data.spec, await loadPriceTable(actor), { conditionalCredits: data.conditionalCredits });
}

export const moveQuery = z.strictObject({
  app: footprintName,
  to: z.enum(CLOUD_ORDER as [Cloud, ...Cloud[]]),
  from: z.enum(CLOUD_ORDER as [Cloud, ...Cloud[]]).optional(),
  scenario: z.string().optional(),
  rate: z.coerce.number().min(0).max(10_000).optional(),
});
export type MoveQuery = z.input<typeof moveQuery>;

/**
 * "Should this app move?". Without `scenario` anyone may ask (the 10x preset is priced). With one, the actor must be
 * signed in and own it: another user's id, a malformed id and a missing id are all 404.
 */
export async function moveAdvice(actor: Actor | null, query: unknown): Promise<MoveResult> {
  const q = moveQuery.parse(query);
  assertCan(actor, "read", "price_point");
  assertCan(actor, "read", "footprint_app");
  let spec: ScenarioSpec = TEN_X_PRESET;
  if (q.scenario !== undefined) {
    if (!actor) throw new NotFoundError();
    const row = await getScenario(actor, q.scenario); // owner only, 404 otherwise
    spec = scenarioSpec.parse(row.spec);
    await chargeRun(actor);
  }
  const apps = await listFootprint();
  const app = apps.find((a) => a.name === q.app);
  if (!app) throw new NotFoundError();
  const from = q.from ?? (app.clouds[0] as Cloud | undefined);
  if (!from || !app.clouds.includes(from)) throw new BadRequestError("The app does not run on that cloud");
  if (app.clouds.includes(q.to)) throw new BadRequestError("The app already runs on that cloud");
  return migrationBreakEven({
    app,
    apps,
    from,
    to: q.to,
    table: await loadPriceTable(actor),
    scenario: spec,
    hourlyRateUsd: q.rate,
  });
}
