import { type Pico, picoToMicros, scale } from "./money";
import { RULES, type DirectRule, type Rule, SOURCE_CLOUD, SOURCE_GROUPS } from "./sku-map";
import { type NormalizedRow, type NotListed, type PriceSourceId, REGIONS, type RawPrice } from "./types";

/**
 * Raw vendor rows in, normalized rows out. Money stays exact (pico-dollars) until the single rounding to integer
 * micro-dollars. A rule that finds nothing, or finds conflicting prices, yields no row and is reported as "not
 * listed": the answer is never zero and never a guess.
 */
export type NormalizeInput = {
  source: PriceSourceId;
  /** The fetch groups that were read successfully. Rules of other groups are neither judged nor reported. */
  groupsRead: ReadonlySet<string>;
  rows: readonly RawPrice[];
};
export type NormalizeResult = { rows: NormalizedRow[]; notListed: NotListed[] };

/** Per-unit sanity bounds in micro-dollars: outside them a price is not stored (a quarantine). */
export const SANITY_BOUNDS: Record<string, readonly [number, number]> = {
  hour: [1, 100_000_000], // up to $100 an hour
  vcpu_hour: [1, 20_000_000],
  gb_hour: [1, 5_000_000],
  gb_month: [1, 2_000_000],
  gb: [1, 1_000_000],
  mau: [1, 100_000],
  million_requests: [1, 50_000_000],
  vcpu_second: [1, 10_000],
  gib_second: [1, 10_000],
};

export const inBounds = (unit: string, micros: number): boolean => {
  const b = SANITY_BOUNDS[unit];
  return b !== undefined && micros >= b[0] && micros <= b[1];
};

type Cell = { pico: Pico; tierStart: number; tierEnd: number | null; vendorSku: string; sourceUrl: string; sourceVersion: string | null };

export function normalize(input: NormalizeInput): NormalizeResult {
  const cloud = SOURCE_CLOUD[input.source];
  const sourceGroups = new Set(SOURCE_GROUPS[input.source]);
  const rules = RULES.filter((r) => r.cloud === cloud && ruleGroups(r).every((g) => sourceGroups.has(g)) && ruleGroups(r).every((g) => input.groupsRead.has(g)) && (r.kind === "absent" ? absentApplies(r, input.source) : true));
  const cells = new Map<string, Cell>();
  const out: NormalizedRow[] = [];
  const notListed: NotListed[] = [];

  for (const rule of rules) {
    if (rule.kind === "absent") {
      notListed.push({ cloud: rule.cloud, component: rule.component, skuKey: rule.key, reason: rule.reason });
      continue;
    }
    const cell = rule.kind === "direct" ? direct(rule, input.rows) : sum(rule, cells);
    if (cell.kind === "none") {
      notListed.push({ cloud: rule.cloud, component: rule.component, skuKey: rule.key, reason: cell.reason });
      continue;
    }
    const usdMicros = picoToMicros(cell.cell.pico);
    if (usdMicros < 1) {
      // A price that rounds to zero is not a price.
      notListed.push({ cloud: rule.cloud, component: rule.component, skuKey: rule.key, reason: "price rounds to zero micro-dollars" });
      continue;
    }
    cells.set(rule.key, cell.cell); // only a published price can feed a derived one
    out.push({
      cloud: rule.cloud,
      component: rule.component,
      skuKey: rule.key,
      region: REGIONS[rule.cloud],
      unit: rule.unit,
      usdMicros,
      tierStart: cell.cell.tierStart,
      tierEnd: cell.cell.tierEnd,
      vendorSku: cell.cell.vendorSku.slice(0, 120) || null,
      description: rule.description.slice(0, 200),
      sourceUrl: cell.cell.sourceUrl,
      sourceVersion: cell.cell.sourceVersion,
    });
  }
  return { rows: out, notListed };
}

const ruleGroups = (r: Rule): string[] => (r.kind === "direct" ? [r.group] : r.kind === "sum" ? r.groups : []);

/** An absent rule is judged with the source that owns its component's rows: the source whose groups cover it. */
function absentApplies(rule: Rule, source: PriceSourceId): boolean {
  // aws_ec2 owns only `vm`; aws_other owns the rest of AWS. Other clouds have one source.
  if (source === "aws_ec2") return rule.component === "vm";
  if (source === "aws_other") return rule.component !== "vm";
  return true;
}

type Found = { kind: "cell"; cell: Cell } | { kind: "none"; reason: string };

function direct(rule: DirectRule, rows: readonly RawPrice[]): Found {
  const matches = rows.filter((r) => r.cloud === rule.cloud && r.group === rule.group && rule.match(r));
  if (matches.length === 0) return { kind: "none", reason: "no matching SKU in the price list" };
  const sorted = [...matches].sort((x, y) => x.tierStart - y.tierStart);
  const floor = (rule.tier ?? "lowest") === "first_paid" ? sorted.find((r) => r.pico > 0n)?.tierStart : sorted[0].tierStart;
  if (floor === undefined) return { kind: "none", reason: "only free tiers listed" };
  const atFloor = sorted.filter((r) => r.tierStart === floor);
  if (new Set(atFloor.map((r) => r.pico)).size > 1) return { kind: "none", reason: "several SKUs matched with different prices" };
  const pick = atFloor[0];
  return {
    kind: "cell",
    cell: { pico: scale(pick.pico, rule.mul ?? 1n, rule.div ?? 1n), tierStart: pick.tierStart, tierEnd: pick.tierEnd, vendorSku: pick.vendorSku, sourceUrl: pick.sourceUrl, sourceVersion: pick.sourceVersion },
  };
}

function sum(rule: Extract<Rule, { kind: "sum" }>, cells: ReadonlyMap<string, Cell>): Found {
  let total = 0n;
  const skus: string[] = [];
  let first: Cell | undefined;
  for (const part of rule.parts) {
    const c = cells.get(part.key);
    if (!c) return { kind: "none", reason: `needs ${part.key}, which is not listed` };
    first ??= c;
    total += scale(c.pico, part.mul, part.div ?? 1n);
    skus.push(c.vendorSku);
  }
  return {
    kind: "cell",
    cell: { pico: total, tierStart: 0, tierEnd: null, vendorSku: skus.join("+"), sourceUrl: first!.sourceUrl, sourceVersion: first!.sourceVersion },
  };
}
