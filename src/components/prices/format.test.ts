import { describe, expect, it } from "vitest";
import { COMPONENTS, PRICE_UNITS } from "@/lib/db/schema";
import { COMPONENT_LABEL, UNIT_LABEL, fetchedOn, formatUnitUsd, safeSourceHref, sourceHost, tierRange } from "./format";

describe("formatUnitUsd", () => {
  it("shows a unit price far below a cent instead of rounding it to $0.00", () => {
    // A Cloud Run vCPU-second is about 24 micro-dollars: rounding to cents would print "$0.00" for every
    // serverless row and make the table useless.
    expect(formatUnitUsd(24)).toBe("$0.000024");
    expect(formatUnitUsd(1)).toBe("$0.000001");
  });

  it("keeps at least two decimals and groups thousands", () => {
    expect(formatUnitUsd(0)).toBe("$0.00");
    expect(formatUnitUsd(1_000_000)).toBe("$1.00");
    expect(formatUnitUsd(46_200_000)).toBe("$46.20");
    expect(formatUnitUsd(1_234_567_000_000)).toBe("$1,234,567.00");
  });

  it("takes a bigint and keeps a negative sign", () => {
    expect(formatUnitUsd(9_500_000n)).toBe("$9.50");
    expect(formatUnitUsd(-2_500_000)).toBe("-$2.50");
  });

  it("does not lose digits on a value past Number.MAX_SAFE_INTEGER as a bigint", () => {
    expect(formatUnitUsd(9_007_199_254_740_993n)).toBe("$9,007,199,254.740993");
  });
});

describe("tierRange", () => {
  it("is null when the price has no tiers", () => {
    expect(tierRange(0, null)).toBeNull();
  });
  it("describes a bounded and an open-ended tier", () => {
    expect(tierRange(0, 10_240)).toBe("0 – 10,240");
    expect(tierRange(10_240, null)).toBe("10,240 and above");
  });
});

describe("source links", () => {
  it("only links https, and shows the host", () => {
    expect(safeSourceHref("https://prices.azure.com/api")).toBe("https://prices.azure.com/api");
    expect(safeSourceHref("http://prices.azure.com/api")).toBeNull();
    expect(safeSourceHref("javascript:alert(1)")).toBeNull();
    expect(safeSourceHref("/relative")).toBeNull();
    expect(sourceHost("https://www.oracle.com/a/b")).toBe("oracle.com");
    expect(sourceHost("not a url")).toBe("source");
  });
});

describe("fetchedOn", () => {
  it("is the date part, and says so when there is none", () => {
    expect(fetchedOn(new Date("2026-11-14T03:05:00Z"))).toBe("2026-11-14");
    expect(fetchedOn("2026-11-14T03:05:00.000Z")).toBe("2026-11-14");
    expect(fetchedOn(null)).toBe("never");
    expect(fetchedOn("not a date")).toBe("unknown");
  });
});

describe("labels", () => {
  it("names every component and unit the schema allows, so a new one can't render as a blank cell", () => {
    for (const c of COMPONENTS) expect(COMPONENT_LABEL[c]).toBeTruthy();
    for (const u of PRICE_UNITS) expect(UNIT_LABEL[u]).toBeTruthy();
  });
});
