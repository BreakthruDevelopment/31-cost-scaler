import { BadRequestError } from "@/lib/errors";
import { priceFootprintApp, DEFAULT_FOOTPRINT_USAGE, appsOnCloud, type FootprintApp } from "./footprint";
import { type PriceOptions } from "./engine";
import { type Micros, type Ppm, PPM, costMicros, decimalToPpm, mulDivRound, ppmToText, toPpm, toSafe } from "./money";
import { priceScenarioCloud } from "./scenario";
import type { ScenarioSpec } from "./spec";
import { tieredCost } from "./table";
import { CLOUD_LABEL, type Cloud, type PriceTable } from "./types";

/**
 * "Should this app move?": monthly cost now and at a scenario on both clouds, the one-time cost of moving, the months
 * it takes the saving to pay that back, blockers, and a verdict computed here (never by a model).
 *
 * Effort rule table (checked in; hours at the user's hourly rate, $100 by default):
 *   add the cloud in apps.yaml 2 h; move the database 4 h + 0.05 h per GB; each per-app secret 0.5 h; object storage 2 h.
 * Plus the one-time egress of the data out of the source cloud at its list rate.
 * Verdict (Michael, 2026-11-14): move = pays back in 6 months or less AND saves at least $10 a month;
 * consider = pays back in 18 months or less; otherwise stay. All comparisons are exact integer arithmetic.
 * The saving is measured on LIST totals (Claude, 2026-11-15): free allowances are one account's pool and change with
 * what else it runs, so they never decide a move. Net (after always-free allowances) is returned beside the list
 * figures for display only.
 */
export const EFFORT_RULES = {
  addCloudHours: "2",
  databaseBaseHours: "4",
  databaseHoursPerGb: "0.05",
  perSecretHours: "0.5",
  objectStorageHours: "2",
} as const;
export const DEFAULT_HOURLY_RATE_USD = 100;
export const MOVE_MAX_MONTHS = 6;
export const CONSIDER_MAX_MONTHS = 18;
/** $10 a month, in micro-dollars. */
export const MOVE_MIN_SAVING_MICROS = 10_000_000n;

export type Verdict = "move" | "consider" | "stay" | "blocked" | "not_enough_data";
export type Blocker = { code: "object_storage_gcp_only" | "oci_no_app_secrets"; reason: string };

export type EffortLine = { label: string; hours: string; micros: number };
/** List cost per cloud (what the saving uses) and net beside it (display only). */
export type MoveSide = { from: number; to: number; fromComplete: boolean; toComplete: boolean; fromNet: number; toNet: number };
export type MoveResult = {
  app: string;
  from: Cloud;
  to: Cloud;
  /** What the saving is measured on: the scenario when one is given, else the app as it runs now. */
  basis: "scenario" | "now";
  hourlyRateMicros: number;
  /** LIST monthly cost of the app as it runs today (shared parts split across the apps on each cloud). */
  now: MoveSide;
  /** LIST monthly cost of the scenario on each cloud, or null without one. */
  atScenario: MoveSide | null;
  /** Wording for every `net*` figure. */
  netLabel: string;
  monthlySavingMicros: number | null;
  effort: { lines: EffortLine[]; hours: string; micros: number };
  oneTimeEgress: { gb: string; micros: number | null };
  oneTimeTotalMicros: number | null;
  /** Hundredths of a month (display); the verdict uses the exact amounts. */
  breakEvenMonthsHundredths: number | null;
  breakEvenMonths: number | null;
  blockers: Blocker[];
  verdict: Verdict;
  reasons: string[];
  notes: string[];
  priceIds: string[];
};

export function blockersFor(app: FootprintApp, to: Cloud): Blocker[] {
  const out: Blocker[] = [];
  if (app.storage && to !== "gcp") out.push({ code: "object_storage_gcp_only", reason: "This app uses object storage (storage: true), which runs only on Google Cloud." });
  if (to === "oci" && app.secretCount > 0) out.push({ code: "oci_no_app_secrets", reason: "Oracle Cloud does not read per-app secrets, and this app has them." });
  return out;
}

/** The verdict from exact amounts. `saving` is micros a month, `oneTime` micros; months are compared as oneTime <= months x saving. */
export function verdictFor(saving: Micros, oneTime: Micros): { verdict: "move" | "consider" | "stay"; months: { hundredths: bigint } | null } {
  if (saving <= 0n) return { verdict: "stay", months: null };
  const hundredths = mulDivRound(oneTime, 100n, saving);
  const within = (months: number) => oneTime <= BigInt(months) * saving;
  if (within(MOVE_MAX_MONTHS) && saving >= MOVE_MIN_SAVING_MICROS) return { verdict: "move", months: { hundredths } };
  if (within(CONSIDER_MAX_MONTHS)) return { verdict: "consider", months: { hundredths } };
  return { verdict: "stay", months: { hundredths } };
}

export type MoveInput = {
  app: FootprintApp;
  apps: readonly FootprintApp[];
  from: Cloud;
  to: Cloud;
  table: PriceTable;
  scenario?: ScenarioSpec;
  hourlyRateUsd?: number;
  opts?: PriceOptions;
};

export function migrationBreakEven(input: MoveInput): MoveResult {
  const { app, apps, from, to, table, scenario } = input;
  if (from === to) throw new BadRequestError("Pick a different cloud to move to");
  const rate = toPpm(input.hourlyRateUsd ?? DEFAULT_HOURLY_RATE_USD); // dollars as ppm is micros per hour
  const cost = (cloud: Cloud) => priceFootprintApp({ app, cloud, n: appsOnCloud(apps, app, cloud), usage: DEFAULT_FOOTPRINT_USAGE, table, opts: input.opts });
  const nowFrom = cost(from);
  const nowTo = cost(to);
  const scenFrom = scenario ? priceScenarioCloud(scenario, from, table, input.opts) : null;
  const scenTo = scenario ? priceScenarioCloud(scenario, to, table, input.opts) : null;

  const notes: string[] = [];
  const reasons: string[] = [];
  const blockers = blockersFor(app, to);

  // Effort hours, exact (ppm of an hour).
  const gb: Ppm = scenario ? toPpm(scenario.database.storageGb) : 0n;
  if (!scenario) notes.push("No scenario: the database size is unknown, so only the fixed database hours are counted.");
  const lines: { label: string; hours: Ppm }[] = [
    { label: "Add the cloud in apps.yaml", hours: decimalToPpm(EFFORT_RULES.addCloudHours) },
    { label: `Move the database (${EFFORT_RULES.databaseBaseHours} h + ${EFFORT_RULES.databaseHoursPerGb} h per GB, ${ppmToText(gb)} GB)`, hours: decimalToPpm(EFFORT_RULES.databaseBaseHours) + mulDivRound(gb, decimalToPpm(EFFORT_RULES.databaseHoursPerGb), PPM) },
  ];
  if (app.secretCount > 0) lines.push({ label: `Per-app secrets (${app.secretCount} x ${EFFORT_RULES.perSecretHours} h)`, hours: decimalToPpm(EFFORT_RULES.perSecretHours) * BigInt(app.secretCount) });
  if (app.storage) lines.push({ label: "Object storage", hours: decimalToPpm(EFFORT_RULES.objectStorageHours) });
  const effortLines: EffortLine[] = lines.map((l) => ({ label: l.label, hours: ppmToText(l.hours), micros: toSafe(costMicros(rate, l.hours)) }));
  const hours = lines.reduce((s, l) => s + l.hours, 0n);
  const effortMicros = lines.reduce((s, l) => s + costMicros(rate, l.hours), 0n);

  // One-time egress of the data leaving the source cloud, at its list rate (no free allowance: it is a one-off).
  const moveGb = gb + (scenario ? toPpm(scenario.storage.objectGb) : 0n);
  if (!scenario && app.storage) notes.push("The object-storage bucket size is unknown, so its one-time egress is not counted.");
  let egressMicros: Micros | null = 0n;
  const egressIds: string[] = [];
  if (moveGb > 0n) {
    const rows = table.rows(from, "egress.gb");
    if (rows.length === 0 || rows[0].unit !== "gb") {
      egressMicros = null;
      notes.push(`No internet egress price is listed on ${CLOUD_LABEL[from]}, so the one-time egress is not priced.`);
    } else {
      const c = tieredCost(rows, moveGb);
      egressMicros = c.micros;
      egressIds.push(...c.used.map((r) => r.id));
    }
  }

  // Monthly figures and the basis for the saving.
  const basis: MoveResult["basis"] = scenario ? "scenario" : "now";
  const fromSide = scenFrom ?? { price: nowFrom };
  const toSide = scenTo ?? { price: nowTo };
  const complete = fromSide.price.complete && toSide.price.complete;
  const saving = BigInt(fromSide.price.totalMicros) - BigInt(toSide.price.totalMicros);
  const oneTime = egressMicros === null ? null : effortMicros + egressMicros;

  let verdict: Verdict;
  let months: bigint | null = null;
  if (blockers.length > 0) {
    verdict = "blocked";
    reasons.push(...blockers.map((b) => b.reason));
  } else if (!complete || oneTime === null) {
    verdict = "not_enough_data";
    if (!fromSide.price.complete) reasons.push(`Some prices are not listed on ${CLOUD_LABEL[from]}, so its total is incomplete.`);
    if (!toSide.price.complete) reasons.push(`Some prices are not listed on ${CLOUD_LABEL[to]}, so its total is incomplete.`);
    if (oneTime === null) reasons.push("The one-time egress could not be priced.");
  } else {
    const v = verdictFor(saving, oneTime);
    verdict = v.verdict;
    months = v.months ? v.months.hundredths : null;
    if (saving <= 0n) reasons.push("Moving does not lower the monthly cost.");
    else if (verdict === "move") reasons.push(`Pays back within ${MOVE_MAX_MONTHS} months and saves at least $10 a month.`);
    else if (verdict === "consider") reasons.push(saving < MOVE_MIN_SAVING_MICROS ? `Pays back within ${CONSIDER_MAX_MONTHS} months, but saves under $10 a month.` : `Pays back in more than ${MOVE_MAX_MONTHS} and at most ${CONSIDER_MAX_MONTHS} months.`);
    else reasons.push(`Takes more than ${CONSIDER_MAX_MONTHS} months to pay back.`);
  }

  type P = { price: { totalMicros: number; netMicros: number; complete: boolean } };
  const side = (a: P, b: P): MoveSide => ({
    from: a.price.totalMicros,
    to: b.price.totalMicros,
    fromComplete: a.price.complete,
    toComplete: b.price.complete,
    fromNet: a.price.netMicros,
    toNet: b.price.netMicros,
  });
  const priceIds = [...new Set([...nowFrom.lines, ...nowTo.lines, ...(scenFrom?.price.lines ?? []), ...(scenTo?.price.lines ?? [])].flatMap((l) => l.priceIds).concat(egressIds))];
  return {
    app: app.name,
    from,
    to,
    basis,
    hourlyRateMicros: toSafe(rate),
    now: side({ price: nowFrom }, { price: nowTo }),
    atScenario: scenFrom && scenTo ? side(scenFrom, scenTo) : null,
    netLabel: nowFrom.netLabel,
    monthlySavingMicros: complete ? toSafe(saving) : null,
    effort: { lines: effortLines, hours: ppmToText(hours), micros: toSafe(effortMicros) },
    oneTimeEgress: { gb: ppmToText(moveGb), micros: egressMicros === null ? null : toSafe(egressMicros) },
    oneTimeTotalMicros: oneTime === null ? null : toSafe(oneTime),
    breakEvenMonthsHundredths: months === null ? null : Number(months),
    breakEvenMonths: months === null ? null : Number(months) / 100,
    blockers,
    verdict,
    reasons,
    notes,
    priceIds,
  };
}
