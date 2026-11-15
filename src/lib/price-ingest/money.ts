/**
 * Money, exactly. Vendor prices are decimal strings or tiny numbers ("0.0000166667" per GB-second); floating point
 * would drift. A price is held as integer PICO-dollars (1e-12 USD) while it is parsed and scaled, and rounded once,
 * half up, to integer micro-dollars (1e-6 USD) when it is stored. A JSON number is turned into text with 13 decimals
 * (`toFixed`, never exponent notation) and then parsed as a decimal string, so it never goes through float arithmetic.
 */
export type Pico = bigint;

const SCALE = 12;

/** Parse a plain decimal string ("0.0000166667", "12"; no sign, no exponent) into pico-dollars. Throws on anything else. */
export function decimalToPico(value: string | number): Pico {
  const text = typeof value === "number" ? numberText(value) : value.trim();
  const m = /^(\d{1,15})(?:\.(\d{1,30}))?$/.exec(text);
  if (!m) throw new RangeError("not a price");
  const frac = (m[2] ?? "").padEnd(SCALE + 1, "0");
  const base = BigInt(m[1]) * 10n ** BigInt(SCALE) + BigInt(frac.slice(0, SCALE));
  return frac.charCodeAt(SCALE) >= 53 ? base + 1n : base; // round half up on the 13th digit
}

function numberText(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 1e15) throw new RangeError("not a price");
  return n.toFixed(SCALE + 1);
}

/** Google's `{ units: "0", nanos: 24000 }` (units is a string of whole dollars, nanos is billionths). */
export function nanosToPico(units: string | number, nanos: number): Pico {
  if (!/^\d{1,15}$/.test(String(units)) || !Number.isInteger(nanos) || nanos < 0 || nanos > 999_999_999) throw new RangeError("not a price");
  return BigInt(units) * 10n ** 12n + BigInt(nanos) * 1000n;
}

/** pico * mul / div, rounded half up. */
export function scale(value: Pico, mul: bigint = 1n, div: bigint = 1n): Pico {
  if (div <= 0n || mul < 0n) throw new RangeError("bad scale");
  return (value * mul * 2n + div) / (div * 2n);
}

/** Round pico-dollars to integer micro-dollars as a safe JS number (half up). */
export function picoToMicros(value: Pico): number {
  const micros = (value + 500_000n) / 1_000_000n;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("price too large");
  return Number(micros);
}
