import { FREE_TIERS } from "./free-tiers";
import { type Micros, type Ppm, mulDivRound, minBig, toPpm, toSafe, PPM } from "./money";
import { tieredCost } from "./table";
import { CLOUD_LABEL, type Cloud, type CloudPrice, type CreditLine, type LineComponent, type PriceLine, type PriceRow, type PriceTable, type PriceUnit, type Snap } from "./types";

/** Options every pricing function takes. */
export type PriceOptions = {
  /** Apply the 12-month new-account allowances too (default false: a list estimate never understates a bill). */
  conditionalCredits?: boolean;
};

export type Part = { key: string; unit: PriceUnit; qty: Ppm; optional?: boolean };
export type Usage = { skuKey: string; unit: PriceUnit; qty: Ppm };
/** What an instance line consumed, so an instance-hour allowance can be matched to it. */
export type InstanceMeta = { family: "vm" | "postgres"; vcpu: Ppm; memGb: Ppm; count: bigint; hoursPerInstance: Ppm };

export type LineBase = { id: string; component: LineComponent; label: string; detail: string; snap?: Snap | null; notes?: string[]; instance?: InstanceMeta };

/** A line while it is being computed: exact money plus what the free-tier step needs. */
export type Work = {
  id: string;
  component: LineComponent;
  label: string;
  detail: string;
  snap: Snap | null;
  notes: string[];
  status: "priced" | "not_listed";
  micros: Micros | null;
  rows: PriceRow[];
  usage: Usage[];
  instance?: InstanceMeta;
};

const dedupe = <T>(xs: T[]): T[] => [...new Set(xs)];

export function unlisted(cloud: Cloud, base: LineBase, missing: string[]): Work {
  return {
    id: base.id,
    component: base.component,
    label: base.label,
    detail: base.detail,
    snap: base.snap ?? null,
    notes: [...(base.notes ?? []), `Not listed: no price for ${missing.join(", ")} on ${CLOUD_LABEL[cloud]}. Left out of the total.`],
    status: "not_listed",
    micros: null,
    rows: [],
    usage: [],
  };
}

/** Price a line from its parts. Any required part with no row (or a row in the wrong unit) makes the whole line "not listed". */
export function priceWork(table: PriceTable, cloud: Cloud, base: LineBase, parts: Part[]): Work {
  const missing: string[] = [];
  let micros = 0n;
  const rows: PriceRow[] = [];
  const usage: Usage[] = [];
  for (const part of parts) {
    if (part.qty <= 0n) continue;
    const listed = table.rows(cloud, part.key);
    if (listed.length === 0 || listed[0].unit !== part.unit) {
      if (!part.optional) missing.push(part.key);
      continue;
    }
    const cost = tieredCost(listed, part.qty);
    micros += cost.micros;
    rows.push(...cost.used);
    usage.push({ skuKey: part.key, unit: part.unit, qty: part.qty });
  }
  if (missing.length > 0) return unlisted(cloud, base, missing);
  return { id: base.id, component: base.component, label: base.label, detail: base.detail, snap: base.snap ?? null, notes: base.notes ?? [], status: "priced", micros, rows, usage, instance: base.instance };
}

/** Split a shared line across `n` apps (half up, so the shares may differ from the whole by under n micros). */
export function shareWork(work: Work, n: bigint, what: string): Work {
  if (work.status !== "priced" || work.micros === null) return work;
  return { ...work, micros: mulDivRound(work.micros, 1n, n), detail: `1/${n} of ${what}: ${work.detail}` };
}

type CreditEntry = { id: string; label: string; micros: Micros; conditional: boolean; sourceUrl: string; rows: PriceRow[] };

/**
 * Free-tier credits as their own lines. A per-unit allowance offsets the units used (the first N units priced as the
 * sku's own tiers price them); an instance-hour allowance offsets the share of an eligible instance's line that its
 * hours cover. `divisor` splits a per-unit allowance evenly across that many apps (one account's allowance is shared).
 */
function creditsFor(cloud: Cloud, works: Work[], table: PriceTable, opts: PriceOptions, divisor: bigint): { entries: CreditEntry[]; skippedConditional: boolean } {
  const entries: CreditEntry[] = [];
  let skippedConditional = false;
  const used = new Map<string, Usage>();
  for (const w of works) {
    if (w.status !== "priced") continue;
    for (const u of w.usage) {
      const have = used.get(u.skuKey);
      used.set(u.skuKey, have ? { ...have, qty: have.qty + u.qty } : { ...u });
    }
  }
  const push = (tier: (typeof FREE_TIERS)[number], idSuffix: string, micros: Micros, rows: PriceRow[]) => {
    if (micros <= 0n) return;
    const conditional = tier.period === "12_months";
    if (conditional && !opts.conditionalCredits) {
      skippedConditional = true;
      return;
    }
    entries.push({ id: `credit.${cloud}.${idSuffix}`, label: tier.label, micros: -micros, conditional, sourceUrl: tier.sourceUrl, rows });
  };

  for (const tier of FREE_TIERS) {
    if (tier.cloud !== cloud) continue;
    if (tier.skuKey) {
      const u = used.get(tier.skuKey);
      const rows = table.rows(cloud, tier.skuKey);
      if (!u || rows.length === 0 || rows[0].unit !== tier.unit) continue;
      const allowed = toPpm(tier.quantity) / divisor;
      const cost = tieredCost(rows, minBig(u.qty, allowed));
      push(tier, tier.skuKey, cost.micros, cost.used);
      continue;
    }
    if (!tier.instance) continue;
    let remaining = toPpm(tier.quantity);
    const maxVcpu = toPpm(tier.instance.maxVcpu);
    const maxMem = toPpm(tier.instance.maxMemoryGb);
    for (const w of works) {
      const inst = w.instance;
      if (w.status !== "priced" || w.micros === null || !inst || inst.family !== tier.appliesTo || remaining <= 0n) continue;
      if (inst.vcpu > maxVcpu || inst.memGb > maxMem) continue;
      const perInstance = tier.instance.meter === "vcpu_hours" ? mulDivRound(inst.hoursPerInstance, inst.vcpu, PPM) : inst.hoursPerInstance;
      const consumed = perInstance * inst.count;
      if (consumed <= 0n) continue;
      const covered = minBig(consumed, remaining);
      remaining -= covered;
      push(tier, w.id, mulDivRound(w.micros, covered, consumed), w.rows);
    }
  }
  return { entries, skippedConditional };
}

const toLine = (w: Work): PriceLine => ({
  id: w.id,
  component: w.component,
  label: w.label,
  detail: w.detail,
  status: w.status,
  micros: w.micros === null ? null : toSafe(w.micros),
  priceIds: dedupe(w.rows.map((r) => r.id)),
  notes: w.notes,
  snap: w.snap,
});

/** Totals, credits and notes for one cloud from its computed lines. */
export function finishCloud(cloud: Cloud, works: Work[], table: PriceTable, opts: PriceOptions = {}, divisor: bigint = 1n): { price: CloudPrice; rows: PriceRow[] } {
  const total = works.reduce((sum, w) => sum + (w.micros ?? 0n), 0n);
  const { entries, skippedConditional } = creditsFor(cloud, works, table, opts, divisor);
  const credit = entries.reduce((sum, e) => sum + e.micros, 0n);
  const unlistedCount = works.filter((w) => w.status === "not_listed").length;
  const notes: string[] = [];
  if (unlistedCount > 0) notes.push(`${unlistedCount} line${unlistedCount === 1 ? "" : "s"} not listed on ${CLOUD_LABEL[cloud]}; left out of the total, so it is not comparable.`);
  if (skippedConditional) notes.push("New-account allowances (12 months) are not applied.");
  const creditLines: CreditLine[] = entries.map((e) => ({
    id: e.id,
    label: e.label,
    micros: toSafe(e.micros),
    conditional: e.conditional,
    sourceUrl: e.sourceUrl,
    priceIds: dedupe(e.rows.map((r) => r.id)),
  }));
  const rows = [...works.flatMap((w) => w.rows), ...entries.flatMap((e) => e.rows)];
  return {
    rows,
    price: {
      cloud,
      label: CLOUD_LABEL[cloud],
      lines: works.map(toLine),
      creditLines,
      totalMicros: toSafe(total),
      creditMicros: toSafe(credit),
      netMicros: toSafe(total + credit),
      complete: unlistedCount === 0,
      unlistedCount,
      notes,
    },
  };
}

/** The oldest fetch date among the rows a result used (ISO), or null when it used none. */
export function oldestFetch(rows: PriceRow[]): string | null {
  let oldest: number | null = null;
  for (const r of rows) {
    const t = new Date(r.fetchedAt).getTime();
    if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
  }
  return oldest === null ? null : new Date(oldest).toISOString();
}
