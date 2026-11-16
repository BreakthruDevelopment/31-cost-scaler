import "server-only";
import { z } from "zod";
import { assertCan } from "@/lib/access";
import { type AnyToolDef, ToolError, defineTool } from "@/lib/ai";
import type { Actor } from "@/lib/auth/rbac";
import { CLOUDS, COMPONENTS } from "@/lib/db/schema";
import { HttpError, NotFoundError } from "@/lib/errors";
import { listFootprint } from "@/lib/footprint/refresh";
import { REGIONS } from "@/lib/price-ingest/types";
import { listPricePoints } from "@/lib/prices";
import { loadPriceTable, moveAdvice } from "@/lib/pricing/data";
import { priceFootprintAppEverywhere } from "@/lib/pricing/footprint";
import { TEN_X_PRESET } from "@/lib/pricing/presets";
import { priceScenario as priceScenarioSpec } from "@/lib/pricing/scenario";
import { footprintName, scenarioSpec } from "@/lib/pricing/spec";
import { CLOUD_ORDER, type Cloud, type PriceTable } from "@/lib/pricing/types";
import { getScenario } from "@/lib/scenarios";

/**
 * The advisor's four tools (split between the pricing and migration specialists by `pricingTools`/`migrationTools`). Read-only, and closed over the acting user: the model supplies arguments, never who is
 * asking. Every result is small (dollars to the cent, never the whole pricing result) so it can be cited by path, and
 * carries no free text the user or a scenario owner wrote (scenario names stay out), only codes and our own wording.
 * An unknown or someone else's scenario id is the same `ToolError("not found")`.
 */

/** Dollars to the cent from integer micro-dollars. */
export const usd = (micros: number | bigint): number => Math.round(Number(micros) / 10_000) / 100;

const cloudEnum = z.enum(CLOUDS);

/** Tool failures the model may read: our own 4xx wording, and "not found" for every kind of missing or foreign row. */
function toToolError(err: unknown): never {
  if (err instanceof ToolError) throw err;
  if (err instanceof NotFoundError) throw new ToolError("not found");
  if (err instanceof HttpError && err.status < 500) throw new ToolError(err.message);
  throw err;
}

type ToolSet = { getFootprint: AnyToolDef; getPrices: AnyToolDef; priceScenario: AnyToolDef; migrationBreakEven: AnyToolDef };

function buildTools(actor: Actor): ToolSet {
  let tablePromise: Promise<PriceTable> | null = null;
  const table = () => (tablePromise ??= loadPriceTable(actor));

  const getFootprint = defineTool({
    name: "getFootprint",
    description: "One portfolio app: the clouds it runs on, whether it uses object storage, its per-app secret count, and its monthly list cost on each of the four clouds (null where a price is not listed).",
    args: z.strictObject({ app: footprintName }),
    kind: "read",
    async run({ app }) {
      try {
        assertCan(actor, "read", "footprint_app");
        const apps = await listFootprint();
        const found = apps.find((a) => a.name === app);
        if (!found) throw new NotFoundError();
        const costs = priceFootprintAppEverywhere({ app: found, apps, table: await table() });
        const monthlyListUsd = Object.fromEntries(CLOUD_ORDER.map((c) => [c, costs[c].complete ? usd(costs[c].totalMicros) : null]));
        return { name: found.name, title: found.title.slice(0, 60), clouds: found.clouds, storage: found.storage, secretCount: found.secretCount, monthlyListUsd };
      } catch (err) {
        return toToolError(err);
      }
    },
  });

  const getPrices = defineTool({
    name: "getPrices",
    description: "List prices (dollars per unit) for one component on one cloud, at most 10 rows, each with its sku key and unit.",
    args: z.strictObject({ cloud: cloudEnum, component: z.enum(COMPONENTS) }),
    kind: "read",
    async run({ cloud, component }) {
      try {
        assertCan(actor, "read", "price_point");
        const rows = (await listPricePoints({ cloud, component })).filter((r) => r.region === REGIONS[r.cloud]);
        return {
          cloud,
          component,
          rowCount: rows.length,
          rows: rows.slice(0, 10).map((r) => ({ skuKey: r.skuKey.slice(0, 60), unit: r.unit, usd: Number(r.usdMicros) / 1_000_000, tierStart: r.tierStart })),
        };
      } catch (err) {
        return toToolError(err);
      }
    },
  });

  const priceScenario = defineTool({
    name: "priceScenario",
    description:
      "Price a scenario on all four clouds (list price, and after always-free allowances). Give exactly one of: scenarioId (one of the user's own saved scenarios), preset \"10x_users\" (the base scenario at ten times the users), or a full spec.",
    args: z
      .strictObject({ scenarioId: z.string().max(64).optional(), preset: z.literal("10x_users").optional(), spec: scenarioSpec.optional() })
      .refine((a) => [a.scenarioId, a.preset, a.spec].filter((v) => v !== undefined).length === 1, "Give exactly one of scenarioId, preset or spec"),
    kind: "read",
    async run(args) {
      try {
        assertCan(actor, "read", "price_point");
        let source: "scenario" | "preset" | "spec";
        let spec;
        if (args.scenarioId !== undefined) {
          source = "scenario";
          spec = scenarioSpec.parse((await getScenario(actor, args.scenarioId)).spec); // owner only: 404 for anyone else's
        } else if (args.preset !== undefined) {
          source = "preset";
          spec = TEN_X_PRESET;
        } else {
          source = "spec";
          spec = args.spec!;
        }
        const price = priceScenarioSpec(spec, await table());
        const clouds = Object.fromEntries(
          CLOUD_ORDER.map((c) => {
            const p = price.clouds[c];
            // An incomplete total is missing a part and is not comparable: null, never a partial figure.
            return [c, { listUsd: p.complete ? usd(p.totalMicros) : null, netUsd: p.complete ? usd(p.netMicros) : null, complete: p.complete, unlistedLines: p.unlistedCount }];
          }),
        ) as Record<Cloud, { listUsd: number | null; netUsd: number | null; complete: boolean; unlistedLines: number }>;
        return { source, pricesAsOf: price.pricesAsOf, cheapest: price.cheapest, clouds };
      } catch (err) {
        return toToolError(err);
      }
    },
  });

  const migrationBreakEven = defineTool({
    name: "migrationBreakEven",
    description:
      "Should this app move to another cloud? Monthly list cost now on each cloud, the one-time cost of moving, months to pay it back, blockers, and the verdict (move, consider, stay, blocked or not_enough_data). The verdict is final. Optionally price a scenarioId of the user's own.",
    args: z.strictObject({ app: footprintName, to: cloudEnum, from: cloudEnum.optional(), scenarioId: z.string().max(64).optional() }),
    kind: "read",
    async run({ app, to, from, scenarioId }) {
      try {
        const r = await moveAdvice(actor, { app, to, from, scenario: scenarioId });
        const side = r.atScenario ?? r.now;
        return {
          app: r.app,
          from: r.from,
          to: r.to,
          basis: r.basis,
          verdict: r.verdict,
          blockers: r.blockers.map((b) => ({ code: b.code, reason: b.reason })),
          reasons: r.reasons.slice(0, 3),
          monthlyFromUsd: side.fromComplete ? usd(side.from) : null,
          monthlyToUsd: side.toComplete ? usd(side.to) : null,
          monthlySavingUsd: r.monthlySavingMicros === null ? null : usd(r.monthlySavingMicros),
          oneTimeUsd: r.oneTimeTotalMicros === null ? null : usd(r.oneTimeTotalMicros),
          breakEvenMonths: r.breakEvenMonths,
        };
      } catch (err) {
        return toToolError(err);
      }
    },
  });

  return { getFootprint, getPrices, priceScenario, migrationBreakEven };
}

/** All four tools: the single agent, the `generate()` fallback and the demo script use these. */
export function advisorTools(actor: Actor): AnyToolDef[] {
  const t = buildTools(actor);
  return [t.getFootprint, t.getPrices, t.priceScenario, t.migrationBreakEven];
}

/** The pricing specialist's tools: footprint, list prices and scenario pricing. */
export function pricingTools(actor: Actor): AnyToolDef[] {
  const t = buildTools(actor);
  return [t.getFootprint, t.getPrices, t.priceScenario];
}

/** The migration specialist's tools: the move analysis, and the footprint it needs to name the app's clouds. */
export function migrationTools(actor: Actor): AnyToolDef[] {
  const t = buildTools(actor);
  return [t.migrationBreakEven, t.getFootprint];
}

/** The three sets over one set of tool objects, so the team shares one price-table load per question. */
export function advisorToolset(actor: Actor): { all: AnyToolDef[]; pricing: AnyToolDef[]; migration: AnyToolDef[] } {
  const t = buildTools(actor);
  return { all: [t.getFootprint, t.getPrices, t.priceScenario, t.migrationBreakEven], pricing: [t.getFootprint, t.getPrices, t.priceScenario], migration: [t.migrationBreakEven, t.getFootprint] };
}
