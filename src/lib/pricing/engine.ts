import { FREE_TIERS, type FreeTier } from "./free-tiers";
import { type Micros, type Ppm, mulDivRound, minBig, toPpm, toSafe, PPM } from "./money";
import { tieredCost } from "./table";
import { CLOUD_LABEL, type Cloud, type CloudPrice, type CreditLine, type LineComponent, type PriceLine, type PriceRow, type PriceTable, type PriceUnit, type Snap } from "./types";

/** Options every pricing function takes. */
export type PriceOptions = {
  /** Apply the 12-month new-account allowances too (default false: a list estimate never understates a bill). */
  conditionalCredits?: boolean;
};

/** `noAllowance`: a separate usage bucket, so no free-tier allowance for this sku is consumed by it. */
export type Part = { key: string; unit: PriceUnit; qty: Ppm; optional?: boolean; noAllowance?: boolean };
export type Usage = { skuKey: string; unit: PriceUnit; qty: Ppm };
/** What an instance line consumed, so an instance-hour allowance can be matched to it. */
export type InstanceMeta = { family: "vm" | "postgres"; vcpu: Ppm; memGb: Ppm; count: bigint; hoursPerInstance: Ppm;
  /**
   * Full copies inside `count` (2 for multi-AZ or multi-region, 1 otherwise). Vendor database allowances cover one
   * single-AZ copy only. Required: an omitted value used to mean "one copy", which silently credited both copies of a
   * two-copy line, and 0 or a negative value threw out of the credit step. The engine also clamps it to at least 1.
   */
  copies: bigint;
};

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

/** What "net" means, shown beside every net figure. */
export const NET_LABEL = "after always-free allowances";

const dedupe = <T>(xs: T[]): T[] => [...new Set(xs)];

/** Lexicographic order for sku keys and line ids: the tie-break that makes every ordering in this file a total one. */
const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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
    if (!part.noAllowance) usage.push({ skuKey: part.key, unit: part.unit, qty: part.qty });
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

/*
 * One allowance, more than one claimant: the engine spends it on the CHEAPEST units first.
 *
 * Two allowances in `FREE_TIERS` are shared rather than per-sku: tiers naming the same `pool` draw from one quantity
 * (AWS gives x86 and arm64 Lambda one 400,000 GB-second pool), and one instance-hour quantity can cover more than one
 * eligible line. Whichever claimant draws first keeps the credit, so the order decides the bill. It used to be the
 * order the tiers were declared in and the order the lines happened to be built in — neither is a fact about pricing.
 *
 * The rule, chosen rather than inherited: credit the cheapest units first, so the expensive usage is what stays
 * billed. `PriceOptions` states the engine's contract — a list estimate never understates a bill — and crediting the
 * dearest units first maximises the credit and minimises the net, which is exactly the understating direction. The
 * cheapest-first split is the smallest credit the allowance can defensibly produce, so a vendor that turns out to be
 * more generous can only make the real bill smaller than the estimate. Being wrong that way round is survivable.
 *
 * Order comes from the price table, never from file order, map order or the order the lines were built: ties are
 * settled by sku key or line id, so every permutation of the inputs gives the same credit (`pricing.test.ts`).
 */
type PoolClaim = { index: number; skuKey: string; unitMicros: Micros; qty: Ppm; quantity: Ppm };

/**
 * Units each pooled tier may credit, keyed by its index in `tiers`. The pool is the smallest quantity its tiers
 * declare (they should all declare the same one — `price-ingest.test.ts` asserts it); meters are ranked by the price
 * of their first unit, cheapest first, with graduated skus ranked on their first band.
 */
function poolDraws(tiers: readonly FreeTier[], cloud: Cloud, table: PriceTable, used: Map<string, Usage>, divisor: bigint): Map<number, Ppm> {
  const byPool = new Map<string, PoolClaim[]>();
  tiers.forEach((tier, index) => {
    if (tier.cloud !== cloud || !tier.pool || !tier.skuKey) return;
    const u = used.get(tier.skuKey);
    const rows = table.rows(cloud, tier.skuKey);
    if (!u || u.qty <= 0n || rows.length === 0 || rows[0].unit !== tier.unit) return;
    const claim: PoolClaim = { index, skuKey: tier.skuKey, unitMicros: tieredCost(rows, PPM).micros, qty: u.qty, quantity: toPpm(tier.quantity) / divisor };
    const claims = byPool.get(tier.pool);
    if (claims) claims.push(claim);
    else byPool.set(tier.pool, [claim]);
  });
  const draws = new Map<number, Ppm>();
  for (const claims of byPool.values()) {
    const cheapestFirst = [...claims].sort((a, b) => (a.unitMicros === b.unitMicros ? cmpText(a.skuKey, b.skuKey) : a.unitMicros < b.unitMicros ? -1 : 1));
    let left = claims.reduce((min, c) => minBig(min, c.quantity), claims[0].quantity);
    for (const c of cheapestFirst) {
      const take = minBig(c.qty, left);
      draws.set(c.index, take);
      left -= take;
    }
  }
  return draws;
}

type InstanceClaim = { id: string; micros: Micros; rows: PriceRow[]; consumed: Ppm; eligible: Ppm };

/**
 * The lines one instance-hour allowance may cover, cheapest per hour first (ties by line id). `consumed` is the hours
 * the line bills, `eligible` the hours the allowance may pay for (a single-copy allowance covers one copy only).
 */
function instanceClaims(works: readonly Work[], tier: FreeTier, shape: NonNullable<FreeTier["instance"]>): InstanceClaim[] {
  const maxVcpu = toPpm(shape.maxVcpu);
  const maxMem = toPpm(shape.maxMemoryGb);
  const claims: InstanceClaim[] = [];
  for (const w of works) {
    const inst = w.instance;
    if (w.status !== "priced" || w.micros === null || !inst || inst.family !== tier.appliesTo) continue;
    if (inst.vcpu > maxVcpu || inst.memGb > maxMem) continue;
    const perInstance = shape.meter === "vcpu_hours" ? mulDivRound(inst.hoursPerInstance, inst.vcpu, PPM) : inst.hoursPerInstance;
    const consumed = perInstance * inst.count;
    if (consumed <= 0n) continue;
    // A single-AZ allowance covers one copy only: the second copy of a multi-AZ or multi-region database stays paid.
    const copies = inst.copies > 0n ? inst.copies : 1n;
    const eligible = shape.singleCopy ? perInstance * (inst.count / copies) : consumed;
    if (eligible <= 0n) continue;
    claims.push({ id: w.id, micros: w.micros, rows: w.rows, consumed, eligible });
  }
  // Cheapest hour first: a.micros / a.consumed vs b.micros / b.consumed, cross-multiplied (both consumed > 0).
  return claims.sort((a, b) => {
    const left = a.micros * b.consumed;
    const right = b.micros * a.consumed;
    return left === right ? cmpText(a.id, b.id) : left < right ? -1 : 1;
  });
}

/**
 * Free-tier credits as their own lines. A per-unit allowance offsets the units used (the first N units priced as the
 * sku's own tiers price them); an instance-hour allowance offsets the share of an eligible instance's line that its
 * hours cover. `divisor` splits a per-unit allowance evenly across that many apps (one account's allowance is shared).
 */
function creditsFor(cloud: Cloud, works: Work[], table: PriceTable, opts: PriceOptions, divisor: bigint, tiers: readonly FreeTier[]): { entries: CreditEntry[]; skippedConditional: boolean } {
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
  const push = (tier: FreeTier, idSuffix: string, micros: Micros, rows: PriceRow[]) => {
    if (micros <= 0n) return;
    const conditional = tier.period === "12_months";
    if (conditional && !opts.conditionalCredits) {
      skippedConditional = true;
      return;
    }
    entries.push({ id: `credit.${cloud}.${idSuffix}`, label: tier.label, micros: -micros, conditional, sourceUrl: tier.sourceUrl, rows });
  };

  // Pooled allowances are shared out before anything is written, so the split never depends on where we are in the loop.
  const draws = poolDraws(tiers, cloud, table, used, divisor);
  for (const [index, tier] of tiers.entries()) {
    if (tier.cloud !== cloud) continue;
    if (tier.skuKey) {
      const u = used.get(tier.skuKey);
      const rows = table.rows(cloud, tier.skuKey);
      if (!u || rows.length === 0 || rows[0].unit !== tier.unit) continue;
      const allowed = tier.pool ? (draws.get(index) ?? 0n) : toPpm(tier.quantity) / divisor;
      const cost = tieredCost(rows, minBig(u.qty, allowed));
      push(tier, tier.skuKey, cost.micros, cost.used);
      continue;
    }
    if (!tier.instance) continue;
    let remaining = toPpm(tier.quantity);
    for (const claim of instanceClaims(works, tier, tier.instance)) {
      if (remaining <= 0n) break;
      const covered = minBig(claim.eligible, remaining);
      remaining -= covered;
      push(tier, claim.id, mulDivRound(claim.micros, covered, claim.consumed), claim.rows);
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

/**
 * Totals, credits and notes for one cloud from its computed lines. `tiers` is the allowance list: production always
 * uses the checked-in `FREE_TIERS`, and the tests pass permutations of it to prove the result does not depend on the
 * order they are declared in.
 */
export function finishCloud(cloud: Cloud, works: Work[], table: PriceTable, opts: PriceOptions = {}, divisor: bigint = 1n, tiers: readonly FreeTier[] = FREE_TIERS): { price: CloudPrice; rows: PriceRow[] } {
  const total = works.reduce((sum, w) => sum + (w.micros ?? 0n), 0n);
  const { entries, skippedConditional } = creditsFor(cloud, works, table, opts, divisor, tiers);
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
      netLabel: opts.conditionalCredits ? "after free-tier allowances, including new-account ones" : NET_LABEL,
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
