/**
 * Money and quantities, exactly. No floating point touches a price: money is an integer number of micro-dollars
 * (1e-6 USD, a BigInt while it is computed), and a fractional quantity (0.25 vCPU, 730 hours, 0.1 busy) is held as
 * an integer number of millionths ("ppm"). A line cost is `price micros x quantity ppm / 1e6`, rounded half up once.
 * Results leave the engine as safe-integer micros (`Number`), which JSON and jsonb carry without loss.
 * A test (`pricing.test.ts`) fails if an engine file uses `Math.` or `parseFloat`.
 */
export type Micros = bigint;
export type Ppm = bigint;

export const MICROS_PER_USD = 1_000_000n;
export const PPM = 1_000_000n;
/** Billing hours in a month (365 x 24 / 12), the convention every cloud's pricing calculator uses. */
export const HOURS_PER_MONTH = 730n;
export const HOURS_PER_MONTH_PPM: Ppm = HOURS_PER_MONTH * PPM;

/** A decimal string such as "0.25" or "730" as millionths. At most 6 decimals, so nothing is rounded away. */
export function decimalToPpm(text: string): Ppm {
  const m = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) throw new RangeError("not a quantity");
  return BigInt(m[1]) * PPM + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** A user-chosen number (already bounded by the scenario schema) as millionths, through its decimal text. */
export function toPpm(n: number): Ppm {
  if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new RangeError("quantity out of range");
  return decimalToPpm(n.toFixed(6));
}

/** A whole count as millionths. */
export const countPpm = (n: number | bigint): Ppm => BigInt(n) * PPM;

/** a * b / d, rounded half up; the sign of `a` is kept (b and d are positive). */
export function mulDivRound(a: bigint, b: bigint, d: bigint): bigint {
  if (d <= 0n || b < 0n) throw new RangeError("bad scale");
  const neg = a < 0n;
  const abs = neg ? -a : a;
  const q = (abs * b * 2n + d) / (2n * d);
  return neg ? -q : q;
}

/** Cost in micros of `qty` (ppm) at `priceMicros` per unit. */
export const costMicros = (priceMicros: Micros, qty: Ppm): Micros => mulDivRound(priceMicros, qty, PPM);

/** Product of two ppm quantities, as ppm. */
export const qmul = (a: Ppm, b: Ppm): Ppm => mulDivRound(a, b, PPM);

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n || a < 0n) throw new RangeError("bad division");
  return (a + b - 1n) / b;
}

export const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** Micros as a safe-integer number for JSON. Throws instead of silently losing digits. */
export function toSafe(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("amount too large");
  return Number(value);
}

/** Display only: "$1,234.57" (half up to the cent, negatives as "-$0.50"). Not used in any calculation. */
export function formatUsd(micros: number | bigint): string {
  const v = typeof micros === "bigint" ? micros : BigInt(micros);
  const neg = v < 0n;
  const cents = mulDivRound(neg ? -v : v, 1n, 10_000n);
  const dollars = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg && cents > 0n ? "-" : ""}$${dollars}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** Millionths as plain text without trailing zeros: 250000 -> "0.25", 8000000 -> "8". */
export function ppmToText(q: Ppm): string {
  const whole = q / PPM;
  const frac = (q % PPM).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
