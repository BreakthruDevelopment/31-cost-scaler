import { describe, expect, it } from "vitest";
import type { AppCost } from "@/lib/pricing/footprint";
import { buildPriceTable } from "@/lib/pricing/table";
import { CLOUD_ORDER, type Cloud, type PriceRow } from "@/lib/pricing/types";
import { type CloudCost, STALE_AFTER_HOURS, cheapestCloud, cloudTotals, priceFreshness, safeHref } from "./footprint-calc";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const row = (cloud: Cloud, fetchedAt: string, id = `${cloud}-1`): PriceRow => ({
  id,
  cloud,
  component: "vm",
  skuKey: "vm.1vcpu-1gb",
  unit: "hour",
  usdMicros: 1000,
  tierStart: 0,
  tierEnd: null,
  sourceUrl: "https://example.test/p",
  fetchedAt,
});

/** A table with one row on each cloud at the same age. */
const tableAt = (h: number, clouds: Cloud[] = [...CLOUD_ORDER]) => buildPriceTable(clouds.map((c) => row(c, hoursAgo(h))));

const cc = (cloud: Cloud, o: { total?: number; credit?: number; complete?: boolean; unavailable?: boolean } = {}): CloudCost => {
  const total = o.total ?? 1_000_000;
  const credit = o.credit ?? -100_000;
  return {
    cloud,
    runsHere: true,
    unavailable: o.unavailable ?? false,
    cost: { totalMicros: total, creditMicros: credit, netMicros: total + credit, complete: o.complete ?? true } as AppCost,
    outgrows: null,
    sources: [],
  };
};

describe("priceFreshness", () => {
  it("is not stale at exactly 72 hours and is stale just past it", () => {
    expect(priceFreshness(tableAt(STALE_AFTER_HOURS), NOW).stale).toBe(false);
    expect(priceFreshness(tableAt(STALE_AFTER_HOURS + 0.01), NOW).stale).toBe(true);
    expect(priceFreshness(tableAt(1), NOW).stale).toBe(false);
  });
  it("judges each cloud by its newest row and flags one stale cloud", () => {
    const table = buildPriceTable([row("aws", hoursAgo(100), "a-old"), row("aws", hoursAgo(2), "a-new"), row("azure", hoursAgo(100))]);
    const f = priceFreshness(table, NOW);
    expect(f.clouds.find((c) => c.cloud === "aws")?.newest).toBe(hoursAgo(2));
    expect(f.stale).toBe(true);
    expect(f.oldestAgeHours).toBe(100);
  });
  it("marks a cloud with no rows unavailable and never stale-by-absence", () => {
    const f = priceFreshness(tableAt(1, ["aws"]), NOW);
    expect(f.clouds.filter((c) => c.unavailable).map((c) => c.cloud)).toEqual(["azure", "gcp", "oci"]);
    expect(f.stale).toBe(false);
    const none = priceFreshness(buildPriceTable([]), NOW);
    expect(none.clouds.every((c) => c.unavailable)).toBe(true);
    expect(none.oldestAgeHours).toBeNull();
    expect(none.stale).toBe(false);
  });
});

describe("cloudTotals", () => {
  const fresh = priceFreshness(tableAt(1, ["aws", "azure", "gcp"]), NOW); // oci has no rows
  it("covers the three unusable states and sums only complete prices", () => {
    const items = [
      { clouds: [cc("aws", { total: 3_000_000, credit: -500_000 }), cc("gcp", { complete: false, total: 0, credit: 0 })] },
      { clouds: [cc("aws", { total: 1_000_000, credit: -100_000 }), cc("gcp", { complete: false, total: 0, credit: 0 }), cc("oci", { unavailable: true, complete: false })] },
    ];
    const t = Object.fromEntries(cloudTotals(items, fresh).map((x) => [x.cloud, x]));
    expect(t.aws).toMatchObject({ state: "priced", apps: 2, counted: 2, listMicros: 4_000_000, creditMicros: -600_000, netMicros: 3_400_000 });
    expect(t.azure).toMatchObject({ state: "no_apps", apps: 0 }); // has rows, nothing runs there
    expect(t.gcp).toMatchObject({ state: "unpriced", apps: 2, counted: 0 }); // rows and apps, no complete price
    expect(t.oci.state).toBe("unavailable"); // no rows at all
  });
  it("counts only the complete apps on a partly priced cloud", () => {
    const items = [{ clouds: [cc("aws", { total: 2_000_000 })] }, { clouds: [cc("aws", { complete: false, total: 9_000_000 })] }];
    const aws = cloudTotals(items, fresh).find((x) => x.cloud === "aws");
    expect(aws).toMatchObject({ state: "priced", apps: 2, counted: 1, listMicros: 2_000_000 });
  });
  it("is unavailable even when apps exist, if the cloud has no rows", () => {
    const t = cloudTotals([{ clouds: [cc("oci")] }], fresh).find((x) => x.cloud === "oci");
    expect(t?.state).toBe("unavailable");
  });
});

describe("cheapestCloud", () => {
  it("ranks on list total, not net", () => {
    // aws is cheaper on list; gcp is cheaper on net because of a bigger credit.
    const aws = cc("aws", { total: 1_000_000, credit: 0 });
    const gcp = cc("gcp", { total: 2_000_000, credit: -2_000_000 });
    expect(cheapestCloud([aws, gcp])).toBe("aws");
  });
  it("never picks an unavailable or incomplete cloud, even at $0", () => {
    const zeroIncomplete = cc("gcp", { total: 0, credit: 0, complete: false });
    const zeroUnavailable = cc("oci", { total: 0, credit: 0, unavailable: true, complete: false });
    expect(cheapestCloud([zeroIncomplete, zeroUnavailable, cc("azure", { total: 5_000_000 })])).toBe("azure");
    expect(cheapestCloud([zeroIncomplete, zeroUnavailable])).toBeNull();
    expect(cheapestCloud([])).toBeNull();
  });
});

describe("safeHref", () => {
  it("allows https only", () => {
    expect(safeHref("https://aws.amazon.com/lambda/pricing/")).toBe("https://aws.amazon.com/lambda/pricing/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "http://example.test", "//example.test", "/relative", "", "https://"]) {
      expect(safeHref(bad)).toBeNull();
    }
  });
});
