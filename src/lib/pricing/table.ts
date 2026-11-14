import { type Micros, type Ppm, ceilDiv, costMicros, decimalToPpm, toPpm } from "./money";
import type { Cloud, PriceRow, PriceTable } from "./types";

/** Build the engine's price input from rows (the active `price_point` rows in the app, a fixture in tests). */
export function buildPriceTable(rows: Iterable<PriceRow>): PriceTable {
  const byKey = new Map<string, PriceRow[]>();
  const keys = new Map<Cloud, Set<string>>();
  for (const row of rows) {
    const k = `${row.cloud}|${row.skuKey}`;
    const list = byKey.get(k);
    if (list) list.push(row);
    else byKey.set(k, [row]);
    const set = keys.get(row.cloud);
    if (set) set.add(row.skuKey);
    else keys.set(row.cloud, new Set([row.skuKey]));
  }
  for (const list of byKey.values()) list.sort((a, b) => a.tierStart - b.tierStart || a.id.localeCompare(b.id));
  const none: readonly PriceRow[] = [];
  return {
    rows: (cloud, skuKey) => byKey.get(`${cloud}|${skuKey}`) ?? none,
    skuKeys: (cloud) => [...(keys.get(cloud) ?? [])].sort(),
  };
}

export const rowMicros = (row: PriceRow): Micros => BigInt(row.usdMicros);

/**
 * Graduated cost of `qty` units over a sku's tiers (rows ordered by `tierStart`). The first row prices from unit 0
 * (a "first paid tier" row stores where payment starts, but the free allowance is its own credit line, so the list
 * cost prices every unit); each later row takes over at its own `tierStart`. Returns the rows that priced a unit.
 */
export function tieredCost(rows: readonly PriceRow[], qty: Ppm): { micros: Micros; used: PriceRow[] } {
  let micros = 0n;
  const used: PriceRow[] = [];
  for (let i = 0; i < rows.length && qty > 0n; i++) {
    const from = i === 0 ? 0n : toPpm(rows[i].tierStart);
    const to = i + 1 < rows.length ? toPpm(rows[i + 1].tierStart) : null;
    if (qty <= from) break;
    const inBand = (to !== null && qty > to ? to : qty) - from;
    if (inBand <= 0n) continue;
    micros += costMicros(rowMicros(rows[i]), inBand);
    used.push(rows[i]);
  }
  return { micros, used };
}

export type ListedSize = { key: string; vcpu: Ppm; memGb: Ppm; label: string };

/** The instance sizes a cloud lists for `vm` or `postgres`, from keys such as `vm.2vcpu-8gb`, smallest first. */
export function listedSizes(table: PriceTable, cloud: Cloud, family: "vm" | "postgres"): ListedSize[] {
  const re = new RegExp(`^${family}\\.(\\d+(?:\\.\\d+)?)vcpu-(\\d+(?:\\.\\d+)?)gb$`);
  const out: ListedSize[] = [];
  for (const key of table.skuKeys(cloud)) {
    const m = re.exec(key);
    if (!m) continue;
    out.push({ key, vcpu: decimalToPpm(m[1]), memGb: decimalToPpm(m[2]), label: `${m[1]} vCPU / ${m[2]} GB` });
  }
  return out.sort((a, b) => (a.vcpu === b.vcpu ? (a.memGb < b.memGb ? -1 : a.memGb > b.memGb ? 1 : 0) : a.vcpu < b.vcpu ? -1 : 1));
}

/**
 * Snap a requested size UP to the smallest listed size that has at least that many vCPUs and that much memory. When
 * the request is bigger than every listed size, use whole copies of the largest one (`multiple`).
 */
export function snapUp(sizes: readonly ListedSize[], vcpu: Ppm, memGb: Ppm): { size: ListedSize; multiple: bigint } | null {
  if (sizes.length === 0) return null;
  const fit = sizes.find((s) => s.vcpu >= vcpu && s.memGb >= memGb);
  if (fit) return { size: fit, multiple: 1n };
  const largest = sizes[sizes.length - 1];
  const a = ceilDiv(vcpu, largest.vcpu);
  const b = ceilDiv(memGb, largest.memGb);
  return { size: largest, multiple: a > b ? a : b };
}
