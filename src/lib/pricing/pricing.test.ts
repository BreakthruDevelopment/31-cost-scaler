import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureRowsWithIds } from "../../../test/fixtures/pricing-table";
import { finishCloud, type Work } from "./engine";
import { type FootprintApp, outgrowsFreeTier, priceFootprintApp, priceFootprintAppEverywhere } from "./footprint";
import { FREE_TIERS, type FreeTier } from "./free-tiers";
import { HOURS_PER_MONTH_PPM, costMicros, decimalToPpm, formatUsd, mulDivRound, ppmToText, toPpm, toSafe } from "./money";
import { CONSIDER_MAX_MONTHS, MOVE_MIN_SAVING_MICROS, blockersFor, migrationBreakEven, verdictFor } from "./move";
import { TEN_X_PRESET } from "./presets";
import { likeForLikeOf, pickCheapest, priceScenario, priceScenarioCloud } from "./scenario";
import { BASE_SPEC, type ScenarioSpec } from "./spec";
import { buildPriceTable, listedSizes, snapUp, tieredCost } from "./table";
import { CLOUD_ORDER, type Cloud, type CloudPrice, type PriceRow, type PriceTable } from "./types";

const ROWS = fixtureRowsWithIds();
const T = buildPriceTable(ROWS);
const spec = (over: Partial<ScenarioSpec>): ScenarioSpec => ({ ...BASE_SPEC, ...over });
const one = (s: ScenarioSpec, cloud: Cloud, opts = {}) => priceScenarioCloud(s, cloud, T, opts).price;
const line = (s: ScenarioSpec, cloud: Cloud, id: string) => {
  const l = one(s, cloud).lines.find((x) => x.id === id);
  if (!l) throw new Error(`no line ${id}`);
  return l;
};
/** A priced line whose only usage is `gbHours` on one GB-hour meter, costed from the table. */
const gbHourWork = (id: string, skuKey: string, gbHours: number, table: PriceTable = T, cloud: Cloud = "aws"): Work => {
  const qty = toPpm(gbHours);
  const cost = tieredCost(table.rows(cloud, skuKey), qty);
  return { id, component: "compute", label: id, detail: "", snap: null, notes: [], status: "priced", micros: cost.micros, rows: cost.used, usage: [{ skuKey, unit: "gb_hour", qty }] };
};
/** Every ordering of `xs` (used to prove a result does not depend on the order its inputs arrive in). */
const permutations = <X,>(xs: readonly X[]): X[][] => (xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));

describe("money stays in integer micro-dollars", () => {
  it("parses quantities exactly", () => {
    expect(decimalToPpm("0.25")).toBe(250_000n);
    expect(toPpm(0.1)).toBe(100_000n);
    expect(toPpm(730)).toBe(730_000_000n);
    expect(ppmToText(250_000n)).toBe("0.25");
    expect(ppmToText(8_000_000n)).toBe("8");
    expect(() => decimalToPpm("1e3")).toThrow();
    expect(() => toPpm(-1)).toThrow();
  });
  it("rounds half up, once per line, keeping the sign", () => {
    expect(mulDivRound(5n, 1n, 2n)).toBe(3n);
    expect(mulDivRound(-5n, 1n, 2n)).toBe(-3n);
    expect(costMicros(4445n, 36_500_000n)).toBe(162_243n); // 162,242.5
  });
  it("displays to the cent, half up", () => {
    expect(formatUsd(5_000)).toBe("$0.01");
    expect(formatUsd(4_999)).toBe("$0.00");
    expect(formatUsd(1_234_567_890)).toBe("$1,234.57");
    expect(formatUsd(-500_000)).toBe("-$0.50");
  });
  it("refuses an amount that doesn't fit a safe integer", () => {
    expect(() => toSafe(2n ** 60n)).toThrow(RangeError);
  });
  it("uses no Math.* or parseFloat in the engine, and every result amount is a safe integer", () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && n !== "spec.ts" && !n.endsWith(".test.ts"))) {
      const src = readFileSync(path.join(dir, f), "utf8").replace(/\/\*[^]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/\bMath\.|parseFloat|toFixed\(\s*[0-9]+\s*\)\s*\*/);
    }
    const r = priceScenario(spec({ users: { mau: 10_000_000, requestsPerUser: 10_000 } }), T);
    for (const c of CLOUD_ORDER) {
      const p = r.clouds[c];
      for (const n of [p.totalMicros, p.creditMicros, p.netMicros, ...p.lines.map((l) => l.micros ?? 0), ...p.creditLines.map((l) => l.micros)]) expect(Number.isSafeInteger(n)).toBe(true);
    }
  });
});

describe("price table helpers", () => {
  it("prices graduated tiers, the first row from unit zero", () => {
    const rows = T.rows("aws", "egress.gb");
    expect(tieredCost(rows, toPpm(500)).micros).toBe(45_000_000n);
    expect(tieredCost(rows, toPpm(20_000)).micros).toBe(10_240n * 90_000n + 9_760n * 85_000n);
    expect(tieredCost(rows, 0n).micros).toBe(0n);
    // a "first paid tier" row that starts at 10,000 still prices every unit
    expect(tieredCost(T.rows("aws", "identity.mau"), toPpm(200_000)).micros).toBe(100_000n * 5_500n + 100_000n * 4_600n);
  });
  it("snaps sizes up, or to copies of the largest", () => {
    const sizes = listedSizes(T, "aws", "vm");
    expect(sizes.map((s) => s.key)).toEqual(["vm.2vcpu-8gb", "vm.4vcpu-16gb"]);
    expect(snapUp(sizes, toPpm(1), toPpm(4))).toMatchObject({ size: { key: "vm.2vcpu-8gb" }, multiple: 1n });
    expect(snapUp(sizes, toPpm(3), toPpm(12))).toMatchObject({ size: { key: "vm.4vcpu-16gb" }, multiple: 1n });
    expect(snapUp(sizes, toPpm(2), toPpm(12))).toMatchObject({ size: { key: "vm.4vcpu-16gb" }, multiple: 1n }); // memory forces the bigger size
    expect(snapUp(sizes, toPpm(8), toPpm(32))).toMatchObject({ size: { key: "vm.4vcpu-16gb" }, multiple: 2n });
    expect(snapUp([], toPpm(1), toPpm(1))).toBeNull();
    expect(listedSizes(T, "aws", "postgres").map((s) => s.key)).toEqual(["postgres.2vcpu-1gb", "postgres.2vcpu-8gb", "postgres.4vcpu-16gb"]); // .ha keys are not sizes
  });
});

describe("components", () => {
  it("serverless compute on each cloud: vCPU-hours, GB-hours, requests", () => {
    // 1 instance x 1 vCPU x 0.1 busy x 730 h = 73 vCPU-h; 0.5 GB -> 36.5 GB-h; 500 users x 200 = 0.1M requests
    expect(line(BASE_SPEC, "gcp", "compute").micros).toBe(73 * 86_400 + 328_500 + 40_000);
    expect(line(BASE_SPEC, "azure", "compute").micros).toBe(73 * 86_400 + 394_200 + 40_000);
    expect(line(BASE_SPEC, "aws", "compute").micros).toBe(73 * 40_480 + 162_243); // no per-request price on Fargate
    expect(line(BASE_SPEC, "oci", "compute").micros).toBe(73 * 12_500 + 54_750);
    expect(line(BASE_SPEC, "aws", "compute").notes.join(" ")).toMatch(/No per-request price is listed on AWS/);
  });
  it("VM compute: instances x hours at the snapped size, with a snapped note", () => {
    const vm = (vcpu: number, memoryGb: number, instances = 2) => spec({ compute: { kind: "vm", instances, vcpu, memoryGb, busyFraction: 1 } });
    expect(line(vm(2, 8), "aws", "compute").micros).toBe(2 * 730 * 96_000);
    expect(line(vm(2, 8), "gcp", "compute").micros).toBe(2 * 730 * 67_000);
    expect(line(vm(2, 8), "oci", "compute").micros).toBe(2 * 730 * 55_000);
    expect(line(vm(2, 8), "aws", "compute").snap).toBeNull();
    const snapped = line(vm(1, 4), "aws", "compute");
    expect(snapped.micros).toBe(2 * 730 * 96_000);
    expect(snapped.snap).toEqual({ requested: "1 vCPU / 4 GB", listed: "2 vCPU / 8 GB", skuKey: "vm.2vcpu-8gb" });
    expect(snapped.notes.join(" ")).toMatch(/Snapped up from 1 vCPU \/ 4 GB to the listed 2 vCPU \/ 8 GB/);
    expect(line(vm(8, 32, 1), "aws", "compute").micros).toBe(2 * 730 * 192_000);
  });
  it("containers: count x serverless size", () => {
    const s = spec({ containers: { count: 3, vcpu: 0.25, memoryGb: 0.5, busyFraction: 0.5 } });
    expect(line(s, "azure", "containers").micros).toBe(23_652_000 + 5_913_000);
    expect(one(BASE_SPEC, "azure").lines.some((l) => l.id === "containers")).toBe(false);
  });
  it("database: instance + storage, snapped up, replicas = n x instance", () => {
    const d = line(BASE_SPEC, "gcp", "database"); // 1 vCPU / 1 GB snaps to 2 / 8
    expect(d.micros).toBe(730 * 117_000 + 20 * 170_000);
    expect(d.snap?.listed).toBe("2 vCPU / 8 GB");
    const s = spec({ database: { vcpu: 2, memoryGb: 8, storageGb: 100, readReplicas: 2 } });
    expect(line(s, "aws", "database").micros).toBe(730 * 178_000 + 100 * 115_000);
    expect(line(s, "aws", "read_replicas").micros).toBe(2 * 730 * 178_000);
  });
  it("object storage, egress (tiered), identity (tiered), load balancer", () => {
    const s = spec({ storage: { objectGb: 1000, egressGb: 20_000 }, identity: { mau: 200_000 }, loadBalancers: 2 });
    expect(line(s, "aws", "object_storage").micros).toBe(23_000_000);
    expect(line(s, "aws", "egress").micros).toBe(10_240 * 90_000 + 9_760 * 85_000);
    expect(line(s, "aws", "identity").micros).toBe(1_010_000_000);
    expect(line(s, "aws", "load_balancer").micros).toBe(2 * 730 * (22_500 + 8_000)); // hours + one capacity unit per hour
    expect(line(s, "gcp", "load_balancer").micros).toBe(2 * 730 * 25_000 + 20_000 * 8_000); // hours + data processed
    expect(line(s, "oci", "load_balancer").micros).toBe(2 * 730 * 12_000);
  });
});

describe("redundancy", () => {
  const red = (over: Partial<ScenarioSpec["redundancy"]>) => spec({ redundancy: { ...BASE_SPEC.redundancy, ...over } });
  const db = { vcpu: 2, memoryGb: 8, storageGb: 100, readReplicas: 0 };
  it("multi-AZ database uses the HA rate where listed (Google Cloud, AWS)", () => {
    expect(line(red({ database: "multi_az" }), "gcp", "database").micros).toBe(730 * 234_000 + 20 * 340_000);
    expect(line(spec({ database: db, redundancy: { ...BASE_SPEC.redundancy, database: "multi_az" } }), "aws", "database").micros).toBe(730 * 356_000 + 100 * 230_000);
  });
  it("multi-AZ database is 2x the instance (and storage) where there is no HA rate (Azure)", () => {
    const l = line(spec({ database: db, redundancy: { ...BASE_SPEC.redundancy, database: "multi_az" } }), "azure", "database");
    expect(l.micros).toBe(2 * 730 * 180_000 + 2 * 100 * 115_000);
    expect(l.notes.join(" ")).toMatch(/2x the instance/);
  });
  it("inter-region transfer is its own usage: it does not use up the internet-egress allowance", () => {
    const s = spec({ storage: { objectGb: 1000, egressGb: 40 }, redundancy: { ...BASE_SPEC.redundancy, storage: "multi_region" } });
    const p = one(s, "aws");
    expect(p.creditLines.find((c) => c.id.endsWith("egress.gb"))?.micros).toBe(-40 * 90_000); // only the 40 GB of internet egress, not 1,040
    expect(p.lines.find((l) => l.id === "inter_region_transfer")?.micros).toBe(1000 * 90_000); // the 1,000 GB bucket, replicated once
  });
  it("a second load balancer under multi-region is documented in the line and the assumptions", () => {
    const lb = (r: "single" | "multi_region") => spec({ loadBalancers: 1, redundancy: { ...BASE_SPEC.redundancy, loadBalancers: r } });
    const doubled = line(lb("multi_region"), "aws", "load_balancer");
    expect(doubled.micros).toBe(2 * (line(lb("single"), "aws", "load_balancer").micros ?? 0));
    expect(doubled.notes.join(" ")).toMatch(/second load balancer/);
    expect(priceScenario(lb("multi_region"), T).assumptions.join(" ")).toMatch(/second balancer in the other region/);
  });
  it("multi-AZ VM is 2x the instance; serverless adds nothing", () => {
    const vm = spec({ compute: { kind: "vm", instances: 1, vcpu: 2, memoryGb: 8, busyFraction: 1 }, redundancy: { ...BASE_SPEC.redundancy, compute: "multi_az" } });
    expect(line(vm, "aws", "compute").micros).toBe(2 * 730 * 96_000);
    expect(line(red({ compute: "multi_az" }), "gcp", "compute").micros).toBe(line(BASE_SPEC, "gcp", "compute").micros);
  });
  it("multi-region doubles compute, containers, database and storage, and adds inter-region transfer at the egress rate", () => {
    const s = spec({
      compute: { kind: "vm", instances: 1, vcpu: 2, memoryGb: 8, busyFraction: 1 },
      containers: { count: 1, vcpu: 1, memoryGb: 1, busyFraction: 1 },
      database: db,
      storage: { objectGb: 1000, egressGb: 0 },
      loadBalancers: 1,
      redundancy: { compute: "multi_region", containers: "multi_region", database: "multi_region", storage: "multi_region", identity: "single", loadBalancers: "single" },
    });
    const single = spec({ ...s, redundancy: BASE_SPEC.redundancy });
    for (const id of ["compute", "containers", "database", "object_storage"]) expect(line(s, "aws", id).micros).toBe(2 * (line(single, "aws", id).micros ?? 0));
    // (100 GB database + 1000 GB objects) replicated once, at the first egress tier
    expect(line(s, "aws", "inter_region_transfer").micros).toBe(1100 * 90_000);
    expect(one(single, "aws").lines.some((l) => l.id === "inter_region_transfer")).toBe(false);
    expect(line(spec({ ...s, redundancy: { ...s.redundancy, compute: "multi_region", database: "single", storage: "single" } }), "aws", "load_balancer").micros).toBe(line(single, "aws", "load_balancer").micros);
  });
  it("read replicas are n x the database instance at the single rate", () => {
    const s = spec({ database: { ...db, readReplicas: 3 } });
    expect(line(s, "gcp", "read_replicas").micros).toBe(3 * 730 * 117_000);
  });
});

describe("missing prices", () => {
  it("a line with no listed price is 'not listed': null, never zero, excluded from the total, with a visible note", () => {
    const oci = one(BASE_SPEC, "oci");
    for (const id of ["database", "identity"]) {
      const l = oci.lines.find((x) => x.id === id)!;
      expect(l.status).toBe("not_listed");
      expect(l.micros).toBeNull();
      expect(l.priceIds).toEqual([]);
      expect(l.notes.join(" ")).toMatch(/Not listed: no price for .* on Oracle Cloud/);
    }
    const pricedSum = oci.lines.reduce((s, l) => s + (l.micros ?? 0), 0);
    expect(oci.totalMicros).toBe(pricedSum);
    expect(oci.complete).toBe(false);
    expect(oci.unlistedCount).toBe(2);
    expect(oci.notes.join(" ")).toMatch(/2 lines not listed on Oracle Cloud/);
  });
  it("a row in the wrong unit counts as not listed", () => {
    const bad = ROWS.map((r) => (r.cloud === "gcp" && r.skuKey === "object_storage.gb" ? { ...r, unit: "gb" as const } : r));
    const p = priceScenarioCloud(BASE_SPEC, "gcp", buildPriceTable(bad)).price;
    expect(p.lines.find((l) => l.id === "object_storage")?.status).toBe("not_listed");
  });
  it("an empty table prices nothing and picks no cheapest", () => {
    const r = priceScenario(BASE_SPEC, buildPriceTable([]));
    expect(r.cheapest).toBeNull();
    for (const c of CLOUD_ORDER) expect(r.clouds[c].totalMicros).toBe(0);
    expect(r.pricesAsOf).toBeNull();
  });
});

describe("priceScenario", () => {
  const r = priceScenario(BASE_SPEC, T);
  it("returns all four clouds and picks the cheapest LIST total among complete clouds", () => {
    expect(Object.keys(r.clouds)).toEqual([...CLOUD_ORDER]);
    expect(r.clouds.oci.complete).toBe(false);
    expect(r.cheapestIsComplete).toBe(true);
    const completes = CLOUD_ORDER.filter((c) => r.clouds[c].complete);
    expect(completes).toEqual(["aws", "azure", "gcp"]);
    expect(r.cheapest).toBe([...completes].sort((a, b) => r.clouds[a].totalMicros - r.clouds[b].totalMicros)[0]);
  });
  it("ranks on list totals even when allowances would reorder the nets", () => {
    // Identity at 40,000 MAU: AWS's 10,000 free MAU cut its bill more than Google's list price would suggest.
    const s = spec({ identity: { mau: 40_000 }, users: { mau: 40_000, requestsPerUser: 1 } });
    const p = priceScenario(s, T);
    const complete = CLOUD_ORDER.filter((c) => p.clouds[c].complete);
    const byList = [...complete].sort((a, b) => p.clouds[a].totalMicros - p.clouds[b].totalMicros || CLOUD_ORDER.indexOf(a) - CLOUD_ORDER.indexOf(b))[0];
    expect(p.cheapest).toBe(byList);
    for (const c of CLOUD_ORDER) expect(p.clouds[c].netLabel).toBe("after always-free allowances");
    expect(priceScenario(s, T, { conditionalCredits: true }).clouds.aws.netLabel).toMatch(/new-account/);
  });
  it("offers a like-for-like subtotal when a cloud lacks a line, and it never changes the cheapest", () => {
    expect(r.likeForLike).not.toBeNull();
    const l = r.likeForLike!;
    expect(l.label).toBe("compared without Database (PostgreSQL): not listed on Oracle Cloud; Identity: not listed on Oracle Cloud");
    expect(l.leftOut.map((x) => x.id)).toEqual(["database", "identity"]);
    expect(l.comparedLineIds).not.toContain("database");
    for (const c of CLOUD_ORDER) {
      const expected = r.clouds[c].lines.filter((x) => l.comparedLineIds.includes(x.id)).reduce((sum, x) => sum + (x.micros ?? 0), 0);
      expect(l.totalsMicros[c]).toBe(expected);
    }
    expect(r.cheapest).not.toBe("oci"); // Oracle is incomplete: the subtotal cannot make it cheapest
  });
  it("ranks by list total, not net, and ties go to the fixed cloud order (synthetic totals)", () => {
    const mk = (cloud: Cloud, total: number, net: number, complete = true): CloudPrice => ({ cloud, label: cloud, lines: [], creditLines: [], totalMicros: total, creditMicros: net - total, netMicros: net, netLabel: "", complete, unlistedCount: complete ? 0 : 1, notes: [] });
    const clouds = { aws: mk("aws", 100, 0), azure: mk("azure", 50, 40), gcp: mk("gcp", 50, 10), oci: mk("oci", 1, 1, false) };
    expect(pickCheapest(clouds)).toEqual({ cheapest: "azure", complete: true }); // list tie azure/gcp -> cloud order; gcp's lower net is ignored; oci incomplete
    expect(pickCheapest({ ...clouds, aws: mk("aws", 100, 0, false), azure: mk("azure", 5, 5, false), gcp: mk("gcp", 5, 5, false) })).toEqual({ cheapest: null, complete: false });
  });
  it("like-for-like covers only lines every cloud lists, and is absent when all clouds are complete", () => {
    const line = (id: string, micros: number | null) => ({ id, component: "compute" as const, label: id === "database" ? "Database (PostgreSQL)" : id, detail: "", status: micros === null ? ("not_listed" as const) : ("priced" as const), micros, priceIds: [], notes: [], snap: null });
    const mk = (cloud: Cloud, lines: ReturnType<typeof line>[]): CloudPrice => ({ cloud, label: cloud, lines, creditLines: [], totalMicros: 0, creditMicros: 0, netMicros: 0, netLabel: "", complete: lines.every((l) => l.micros !== null), unlistedCount: lines.filter((l) => l.micros === null).length, notes: [] });
    const full = (c: Cloud, n: number) => mk(c, [line("compute", n), line("database", n * 2)]);
    expect(likeForLikeOf({ aws: full("aws", 1), azure: full("azure", 2), gcp: full("gcp", 3), oci: full("oci", 4) })).toBeNull();
    const l = likeForLikeOf({ aws: full("aws", 1), azure: full("azure", 2), gcp: full("gcp", 3), oci: mk("oci", [line("compute", 4), line("database", null)]) })!;
    expect(l.label).toBe("compared without Database (PostgreSQL): not listed on Oracle Cloud");
    expect(l.totalsMicros).toEqual({ aws: 1, azure: 2, gcp: 3, oci: 4 });
    expect(l.cheapest).toBe("aws");
    // Nothing is priced everywhere (Oracle lacks compute, AWS never had a database line): no subtotal to offer.
    const noCommon = { aws: mk("aws", [line("compute", 1)]), azure: full("azure", 2), gcp: full("gcp", 3), oci: mk("oci", [line("compute", null), line("database", 4)]) };
    expect(likeForLikeOf(noCommon)).toBeNull();
  });
  it("is deterministic and reports the oldest fetch date", () => {
    expect(priceScenario(BASE_SPEC, T)).toEqual(r);
    expect(r.pricesAsOf).toBe("2026-11-14T03:00:00.000Z");
    const older = ROWS.map((x) => (x.cloud === "aws" && x.skuKey === "serverless.vcpu" ? { ...x, fetchedAt: "2026-11-01T00:00:00.000Z" } : x));
    expect(priceScenario(BASE_SPEC, buildPriceTable(older)).pricesAsOf).toBe("2026-11-01T00:00:00.000Z");
    expect(r.disclaimer).toMatch(/List price estimate/);
  });
  it("names nobody cheapest when no cloud lists every line", () => {
    const noPg = buildPriceTable(ROWS.filter((x) => x.component !== "postgres"));
    const p = priceScenario(BASE_SPEC, noPg);
    expect(p.cheapestIsComplete).toBe(false);
    expect(p.cheapest).toBeNull();
    expect(p.likeForLike?.comparedLineIds).toEqual(["compute", "object_storage", "egress"]); // informational: still no verdict or cheapest from it
    expect(p.likeForLike?.leftOut.map((l) => l.id)).toEqual(["database", "identity"]);
  });
});

describe("free-tier credits", () => {
  it("are their own negative lines with a source, offsetting the units used", () => {
    const p = one(BASE_SPEC, "gcp");
    const credit = (suffix: string) => p.creditLines.find((c) => c.id.endsWith(suffix))!;
    expect(credit("serverless.vcpu").micros).toBe(-50 * 86_400); // 50 of the 73 vCPU-hours are free
    expect(credit("serverless.gb").micros).toBe(-328_500);
    expect(credit("serverless.requests").micros).toBe(-40_000);
    expect(credit("identity.mau").micros).toBe(-500 * 15_000);
    expect(credit("object_storage.gb").micros).toBe(-5 * 20_000);
    for (const c of p.creditLines) {
      expect(c.micros).toBeLessThan(0);
      expect(c.sourceUrl).toMatch(/^https:\/\//);
    }
    expect(p.netMicros).toBe(p.totalMicros + p.creditMicros);
  });
  it("never exceed the list cost of what they offset", () => {
    for (const c of CLOUD_ORDER) expect(one(spec({ users: { mau: 10, requestsPerUser: 1 } }), c).netMicros).toBeGreaterThanOrEqual(0);
  });
  it("an Always Free A1 instance covers an eligible Oracle VM, and not a bigger one", () => {
    const vm = (vcpu: number, memoryGb: number) => spec({ compute: { kind: "vm", instances: 1, vcpu, memoryGb, busyFraction: 1 } });
    const small = one(vm(2, 8), "oci");
    expect(small.creditLines.find((c) => c.id.endsWith("compute"))?.micros).toBe(-(730 * 55_000)); // 1,460 of 3,000 OCPU-hours
    expect(one(vm(8, 32), "oci").creditLines.some((c) => c.id.endsWith("compute"))).toBe(false);
  });
  it("new-account (12 month) allowances apply only when asked, and say so", () => {
    const aws: FootprintApp = { name: "a", clouds: ["aws"], storage: false, secretCount: 0 };
    const off = priceFootprintApp({ app: aws, cloud: "aws", n: 1, table: T });
    const on = priceFootprintApp({ app: aws, cloud: "aws", n: 1, table: T, opts: { conditionalCredits: true } });
    expect(off.creditLines.some((c) => c.conditional)).toBe(false);
    expect(off.notes.join(" ")).toMatch(/12 months/);
    expect(on.creditLines.some((c) => c.conditional)).toBe(true);
    expect(on.netMicros).toBe(0);
    expect(off.netMicros).toBe(13_980_000); // db.t4g.micro is listed, so it prices at its real size
  });
});

describe("footprint cost per app", () => {
  const apps: FootprintApp[] = [
    { name: "a", clouds: ["aws"], storage: false, secretCount: 0 },
    { name: "b", clouds: ["aws", "gcp"], storage: true, secretCount: 2 },
    { name: "c", clouds: ["gcp"], storage: false, secretCount: 0 },
  ];
  it("splits the shared database evenly across the apps on that cloud and prices the micro at its real size", () => {
    const cost = priceFootprintApp({ app: apps[0], cloud: "aws", n: 2, table: T });
    const shared = cost.lines.find((l) => l.id === "shared")!;
    expect(shared.micros).toBe((730 * 16_000 + 20 * 115_000) / 2);
    expect(shared.snap).toBeNull();
    expect(shared.detail).toMatch(/2 vCPU \/ 1 GB/);
    expect(shared.notes.join(" ")).not.toMatch(/upper bound/);
    expect(cost.appsOnCloud).toBe(2);
  });
  it("prices the Azure B1ms, the Google e2-micro and the Oracle A1 at their listed sizes", () => {
    const az = priceFootprintApp({ app: apps[0], cloud: "azure", n: 1, table: T }).lines.find((l) => l.id === "shared")!;
    expect(az.micros).toBe(730 * 25_000 + 32 * 115_000);
    expect(az.snap).toBeNull();
    const gcp = priceFootprintApp({ app: apps[0], cloud: "gcp", n: 1, table: T }).lines.find((l) => l.id === "shared")!;
    expect(gcp.micros).toBe(730 * 8_000);
    expect(gcp.snap).toBeNull();
    const oci = priceFootprintApp({ app: apps[0], cloud: "oci", n: 1, table: T });
    expect(oci.lines.find((l) => l.id === "shared")!.micros).toBe(730 * (2 * 10_000 + 12 * 1_000)); // 2 OCPU + 12 GB, not an E4 size
    expect(oci.creditLines.some((c) => c.id.endsWith("shared"))).toBe(true); // inside the Always Free A1 allowance
    expect(oci.netMicros).toBe(0);
  });
  it("falls back to the smallest listed size that holds it, and says the cost is an upper bound", () => {
    const noMicro = buildPriceTable(ROWS.filter((x) => x.skuKey !== "postgres.2vcpu-1gb"));
    const shared = priceFootprintApp({ app: apps[0], cloud: "aws", n: 2, table: noMicro }).lines.find((l) => l.id === "shared")!;
    expect(shared.micros).toBe((730 * 178_000 + 20 * 115_000) / 2);
    expect(shared.snap?.requested).toBe("2 vCPU / 1 GB");
    expect(shared.notes.join(" ")).toMatch(/upper bound/);
  });
  it("prices the app on all four clouds, counting itself on a cloud it isn't on yet", () => {
    const all = priceFootprintAppEverywhere({ app: apps[2], apps, table: T });
    expect(all.aws.appsOnCloud).toBe(3); // a, b and c
    expect(all.gcp.appsOnCloud).toBe(2);
    expect(all.oci.appsOnCloud).toBe(1);
    expect(all.oci.lines.map((l) => l.id)).toEqual(["shared"]);
    expect(all.oci.notes.concat(all.oci.lines.flatMap((l) => l.notes)).join(" ")).toMatch(/boot volume is not priced/);
    expect(priceFootprintApp({ app: apps[1], cloud: "gcp", n: 2, table: T }).notes.join(" ")).toMatch(/storage: true/);
  });
  it("finds the MAU where net first turns positive", () => {
    const gcp = outgrowsFreeTier({ app: apps[2], cloud: "gcp", n: 2, requestsPerUser: 200, table: T });
    expect(gcp).toEqual({ status: "at", mau: 1801 }); // 25 vCPU-hours (half of 50) are free: 360,000 requests at 0.25 s
    const net = (mau: number) => priceFootprintApp({ app: apps[2], cloud: "gcp", n: 2, usage: { mau, requestsPerUser: 200 }, table: T }).netMicros;
    expect(net(1800)).toBe(0);
    expect(net(1801)).toBeGreaterThan(0);
    expect(outgrowsFreeTier({ app: apps[0], cloud: "aws", n: 2, requestsPerUser: 200, table: T })).toEqual({ status: "already_paying", mau: 0 });
    expect(outgrowsFreeTier({ app: apps[0], cloud: "aws", n: 2, requestsPerUser: 200, table: T, opts: { conditionalCredits: true } })).toEqual({ status: "at", mau: 2501 });
    expect(outgrowsFreeTier({ app: apps[0], cloud: "gcp", n: 2, requestsPerUser: 1, table: T })).toMatchObject({ status: "at" });
  });
});

describe("migrationBreakEven", () => {
  const apps: FootprintApp[] = [
    { name: "plain", clouds: ["aws"], storage: false, secretCount: 0 },
    { name: "files", clouds: ["aws"], storage: true, secretCount: 2 },
    { name: "other", clouds: ["gcp"], storage: false, secretCount: 0 },
  ];
  const move = (app: FootprintApp, to: Cloud, extra: Partial<Parameters<typeof migrationBreakEven>[0]> = {}) =>
    migrationBreakEven({ app, apps, from: "aws", to, table: T, scenario: TEN_X_PRESET, ...extra });

  it("blocks object storage anywhere but Google Cloud", () => {
    expect(blockersFor(apps[1], "azure").map((b) => b.code)).toEqual(["object_storage_gcp_only"]);
    expect(blockersFor(apps[1], "gcp")).toEqual([]);
    const r = move(apps[1], "azure");
    expect(r.verdict).toBe("blocked");
    expect(r.reasons.join(" ")).toMatch(/runs only on Google Cloud/);
  });
  it("blocks a move to Oracle for an app with per-app secrets, not for one without", () => {
    expect(blockersFor({ ...apps[1], storage: false }, "oci").map((b) => b.code)).toEqual(["oci_no_app_secrets"]);
    expect(blockersFor(apps[0], "oci")).toEqual([]);
    expect(blockersFor(apps[1], "oci").map((b) => b.code)).toEqual(["object_storage_gcp_only", "oci_no_app_secrets"]);
    expect(move({ ...apps[1], storage: false }, "oci").verdict).toBe("blocked");
  });
  it("counts effort from the rule table at the hourly rate, which is editable", () => {
    const s: ScenarioSpec = { ...TEN_X_PRESET, database: { ...TEN_X_PRESET.database, storageGb: 100 } };
    const r = move(apps[1], "gcp", { scenario: s });
    // 2 (apps.yaml) + 4 + 0.05 x 100 (database) + 2 x 0.5 (secrets) + 2 (object storage) = 14 h
    expect(r.effort.hours).toBe("14");
    expect(r.effort.micros).toBe(1_400_000_000);
    expect(r.hourlyRateMicros).toBe(100_000_000);
    expect(move(apps[1], "gcp", { scenario: s, hourlyRateUsd: 150 }).effort.micros).toBe(2_100_000_000);
    expect(r.effort.lines.map((l) => l.hours)).toEqual(["2", "9", "1", "2"]);
  });
  it("prices the one-time egress of database and bucket data at the source's rate", () => {
    const r = move(apps[0], "gcp");
    expect(r.oneTimeEgress).toEqual({ gb: "30", micros: 30 * 90_000 }); // 20 GB database + 10 GB objects
    expect(r.oneTimeTotalMicros).toBe(r.effort.micros + 30 * 90_000);
  });
  it("compares the app now and at the scenario on both clouds, and carries price ids", () => {
    const r = move(apps[0], "gcp");
    expect(r.basis).toBe("scenario");
    expect(r.now.from).toBeGreaterThan(0);
    expect(r.atScenario).not.toBeNull();
    expect(r.priceIds.length).toBeGreaterThan(0);
    expect(r.monthlySavingMicros).toBe(r.atScenario!.from - r.atScenario!.to); // list totals
    expect(r.netLabel).toBe("after always-free allowances");
    expect(r.atScenario!.fromNet).toBeLessThanOrEqual(r.atScenario!.from);
    expect(r.atScenario!.toNet).toBeLessThanOrEqual(r.atScenario!.to);
    const noScenario = migrationBreakEven({ app: apps[0], apps, from: "aws", to: "gcp", table: T });
    expect(noScenario.basis).toBe("now");
    expect(noScenario.atScenario).toBeNull();
    expect(noScenario.notes.join(" ")).toMatch(/No scenario/);
  });
  it("says 'not enough data' rather than guessing when a side's prices are not all listed", () => {
    const r = move(apps[0], "oci"); // Oracle lists no database or identity price
    expect(r.verdict).toBe("not_enough_data");
    expect(r.monthlySavingMicros).toBeNull();
    expect(r.breakEvenMonths).toBeNull();
  });
  it("measures the saving on list totals, not on net after allowances", () => {
    const r = move(apps[0], "gcp", { scenario: spec({ users: { mau: 500, requestsPerUser: 200 } }) });
    const listSaving = one(spec({ users: { mau: 500, requestsPerUser: 200 } }), "aws").totalMicros - one(spec({ users: { mau: 500, requestsPerUser: 200 } }), "gcp").totalMicros;
    expect(r.monthlySavingMicros).toBe(listSaving);
    const netSaving = r.atScenario!.fromNet - r.atScenario!.toNet;
    expect(netSaving).not.toBe(listSaving);
  });
  it("rejects moving to the same cloud", () => {
    expect(() => move(apps[0], "aws")).toThrow();
  });
  it("ends in a verdict from code that is consistent with the numbers", () => {
    const r = move(apps[0], "gcp");
    const saving = r.monthlySavingMicros!;
    const v = verdictFor(BigInt(saving), BigInt(r.oneTimeTotalMicros!));
    expect(r.verdict).toBe(v.verdict);
  });
});

describe("verdict boundaries", () => {
  const S = MOVE_MIN_SAVING_MICROS; // $10 a month
  it("move at exactly 6 months and $10 a month, consider one micro-dollar over", () => {
    expect(verdictFor(S, 6n * S).verdict).toBe("move");
    expect(verdictFor(S, 6n * S + 1n).verdict).toBe("consider");
    expect(verdictFor(S, 0n).verdict).toBe("move");
  });
  it("consider at exactly 18 months, stay one micro-dollar over", () => {
    expect(verdictFor(S, BigInt(CONSIDER_MAX_MONTHS) * S).verdict).toBe("consider");
    expect(verdictFor(S, BigInt(CONSIDER_MAX_MONTHS) * S + 1n).verdict).toBe("stay");
  });
  it("$9.99 a month is not enough to move, $10 is", () => {
    expect(verdictFor(9_990_000n, 0n).verdict).toBe("consider");
    expect(verdictFor(9_999_999n, 0n).verdict).toBe("consider");
    expect(verdictFor(10_000_000n, 0n).verdict).toBe("move");
  });
  it("no saving, or a loss, is stay with no break-even", () => {
    expect(verdictFor(0n, 5n)).toEqual({ verdict: "stay", months: null });
    expect(verdictFor(-1n, 0n)).toEqual({ verdict: "stay", months: null });
  });
  it("reports break-even months in hundredths", () => {
    expect(verdictFor(S, 6n * S).months?.hundredths).toBe(600n);
    expect(verdictFor(S, S / 4n).months?.hundredths).toBe(25n);
  });
});

describe("rows from the database shape", () => {
  it("accepts bigint micros", () => {
    const rows: PriceRow[] = ROWS.map((r) => ({ ...r, usdMicros: BigInt(r.usdMicros) }));
    expect(priceScenario(BASE_SPEC, buildPriceTable(rows))).toEqual(priceScenario(BASE_SPEC, T));
  });
});

describe("engine follow-ups from the 31.3 review", () => {
  const dbSpec = (database: ScenarioSpec["redundancy"]["database"]) => spec({ redundancy: { ...BASE_SPEC.redundancy, database } });
  const dbCredit = (database: ScenarioSpec["redundancy"]["database"]) => one(dbSpec(database), "aws", { conditionalCredits: true }).creditLines.find((c) => c.id === "credit.aws.database")?.micros;

  it("x86 and arm64 Lambda share one 400,000 GB-second pool, spent on the cheaper meter first", () => {
    const { price } = finishCloud("aws", [gbHourWork("x86", "serverless.lambda.gb", 100), gbHourWork("arm", "serverless.lambda.gb.arm64", 100)], T);
    const credit = (suffix: string) => price.creditLines.find((c) => c.id.endsWith(suffix))!.micros;
    // One 111 GB-hour pool for both meters. arm64 is the cheaper one ($0.048), so it draws its 100 hours first and
    // only the 11 left over are credited against x86 at $0.06: the dearer usage is what stays billed.
    expect(credit("serverless.lambda.gb.arm64")).toBe(-100 * 48_000);
    expect(credit("serverless.lambda.gb")).toBe(-11 * 60_000);
    expect(price.creditMicros).toBe(-5_460_000);
  });
  it("a single-AZ 12-month database allowance does not cover the second copy of a multi-AZ database", () => {
    const single = dbCredit("single");
    expect(single).toBe(-13_980_000); // the whole single-AZ line: 730 h x $0.016 + 20 GB x $0.115
    expect(dbCredit("multi_az")).toBe(single); // the multi-AZ line is twice that; only one copy is free
    expect(dbCredit("multi_region")).toBe(single);
    const multi = one(dbSpec("multi_az"), "aws", { conditionalCredits: true });
    expect(multi.creditMicros).toBeGreaterThan(-multi.lines.find((l) => l.id === "database")!.micros!);
    // The one-copy credit is the line x 1/copies, which is exact only while the multi-AZ line is exactly 2x the
    // single one. That holds because the eligible micro size has no HA rate; if one is ever listed, this fails.
    expect(T.rows("aws", "postgres.2vcpu-1gb.ha")).toHaveLength(0);
    expect(line(dbSpec("multi_az"), "aws", "database").micros).toBe(2 * line(dbSpec("single"), "aws", "database").micros!);
  });
  it("gives a like-for-like saving on a move to Oracle, informational only", () => {
    const apps: FootprintApp[] = [{ name: "plain", clouds: ["aws"], storage: false, secretCount: 0 }];
    const r = migrationBreakEven({ app: apps[0], apps, from: "aws", to: "oci", table: T, scenario: TEN_X_PRESET });
    expect(r.verdict).toBe("not_enough_data");
    expect(r.monthlySavingMicros).toBeNull();
    const l = r.likeForLike!;
    expect(l.leftOut.length).toBeGreaterThan(0);
    expect(l.leftOut.every((x) => x.notListedOn.includes("oci") && !x.notListedOn.includes("aws"))).toBe(true);
    expect(l.savingMicros).toBe(l.fromMicros - l.toMicros);
    expect(l.label).toMatch(/^compared without .*not listed on Oracle Cloud/);
    // The verdict inputs are untouched by it.
    expect(r.breakEvenMonths).toBeNull();
  });
  it("has no like-for-like figure when both sides are complete", () => {
    const apps: FootprintApp[] = [{ name: "plain", clouds: ["aws"], storage: false, secretCount: 0 }];
    expect(migrationBreakEven({ app: apps[0], apps, from: "aws", to: "gcp", table: T, scenario: TEN_X_PRESET }).likeForLike).toBeNull();
  });
});

/**
 * An allowance that more than one meter or line can claim has to be spent somewhere, and the choice changes the
 * money. It used to be spent on whichever claimant came first in `FREE_TIERS` or in the array of lines — so the bill
 * depended on file layout. The engine now spends it on the cheapest units first (see `engine.ts`): the smallest
 * credit the allowance can defensibly give, so a list estimate still never understates a bill.
 */
describe("pooled free-tier credit is order-independent and conservative (#18)", () => {
  const LAMBDA_POOL = "aws.lambda.gb";
  const creditOf = (cloud: Cloud, works: Work[], table: PriceTable = T, tiers: readonly FreeTier[] = FREE_TIERS) => finishCloud(cloud, works, table, {}, 1n, tiers).price.creditMicros;

  it("credits the same whichever order the two Lambda meters are declared in", () => {
    const pooled = FREE_TIERS.filter((t) => t.pool === LAMBDA_POOL);
    expect(pooled).toHaveLength(2);
    const swapped = FREE_TIERS.map((t) => (t.pool === LAMBDA_POOL ? (t === pooled[0] ? pooled[1] : pooled[0]) : t));
    expect(swapped.filter((t) => t.pool === LAMBDA_POOL)).toEqual([pooled[1], pooled[0]]); // really the other way round
    const works = [gbHourWork("x86", "serverless.lambda.gb", 100), gbHourWork("arm", "serverless.lambda.gb.arm64", 100)];
    // 100 GB-hours on each meter, one 111 GB-hour pool: arm64 ($0.048) draws first, x86 ($0.06) keeps the remaining 11.
    for (const tiers of [FREE_TIERS, swapped]) for (const order of permutations(works)) expect(creditOf("aws", order, T, tiers)).toBe(-5_460_000);
  });

  it("gives one answer for every permutation of four pooled meters, and it is the smallest any order could give", () => {
    const PRICES: Record<string, number> = { "pooled.a": 7_000, "pooled.b": 11_000, "pooled.c": 3_000, "pooled.d": 11_000 }; // b and d tie on price
    const USED = 30; // GB-hours on each meter: 120 in all
    const QUANTITY = 100; // one pool, smaller than the usage, so the split decides the money
    const keys = Object.keys(PRICES);
    const table = buildPriceTable(
      keys.map((skuKey): PriceRow => ({ id: `aws:${skuKey}:0`, cloud: "aws", component: "serverless", skuKey, unit: "gb_hour", usdMicros: PRICES[skuKey], tierStart: 0, tierEnd: null, sourceUrl: "https://example.test/pool", fetchedAt: "2026-11-14T03:00:00.000Z" })),
    );
    const tiers = keys.map((skuKey): FreeTier => ({ cloud: "aws", appliesTo: "serverless", skuKey, label: skuKey, quantity: QUANTITY, unit: "gb_hour", period: "always", pool: "test.pool", sourceUrl: "https://example.test/pool" }));
    const works = keys.map((skuKey) => gbHourWork(skuKey, skuKey, USED, table));

    // Every order the pool could be drawn in, costed by hand. The engine must return the smallest of them.
    const byHand = (order: string[]) => {
      let left = QUANTITY;
      return order.reduce((sum, k) => {
        const take = Math.min(USED, left);
        left -= take;
        return sum - take * PRICES[k];
      }, 0);
    };
    const hands = permutations(keys).map(byHand);
    const cheapestFirst = Math.max(...hands); // credits are negative, so the smallest credit is the least negative
    expect(cheapestFirst).toBe(-(30 * 3_000 + 30 * 7_000 + 30 * 11_000 + 10 * 11_000)); // c, a, then the b/d tie by sku key
    expect(Math.min(...hands)).toBe(-(30 * 11_000 + 30 * 11_000 + 30 * 7_000 + 10 * 3_000)); // dearest first: $0.16 more credit
    for (const ts of permutations(tiers)) for (const ws of permutations(works)) expect(creditOf("aws", ws, table, ts)).toBe(cheapestFirst);
  });

  it("spends an instance-hour allowance on the cheapest eligible line first, whatever order the lines were built in", () => {
    const vm = (id: string, micros: bigint): Work => ({ id, component: "compute", label: id, detail: "", snap: null, notes: [], status: "priced", micros, rows: [], usage: [], instance: { family: "vm", vcpu: toPpm(4), memGb: toPpm(24), count: 1n, hoursPerInstance: HOURS_PER_MONTH_PPM, copies: 1n } });
    // Oracle's Always Free A1 is 3,000 OCPU-hours; each line burns 4 x 730 = 2,920, so one line and a sliver fit.
    const works = [vm("cheap", 2_000_000n), vm("dear", 10_000_000n)];
    for (const order of permutations(works)) {
      expect(creditOf("oci", order)).toBe(-(2_000_000 + 273_973)); // all of the cheap line, then 80 of the dear line's 2,920 hours
    }
  });

  it("clamps a bad `copies` count to one copy instead of throwing out of the credit step", () => {
    const db = (copies: bigint): Work => ({ id: "database", component: "database", label: "db", detail: "", snap: null, notes: [], status: "priced", micros: 13_980_000n, rows: [], usage: [], instance: { family: "postgres", vcpu: toPpm(2), memGb: toPpm(1), count: 1n, hoursPerInstance: HOURS_PER_MONTH_PPM, copies } });
    const credit = (copies: bigint) => finishCloud("aws", [db(copies)], T, { conditionalCredits: true }).price.creditMicros;
    expect(credit(1n)).toBe(-13_980_000); // the 12-month RDS allowance covers the whole single-copy line
    for (const bad of [0n, -2n]) expect(credit(bad)).toBe(credit(1n));
  });

  it("is not reachable from today's producers: only one meter of the Lambda pool is ever used", () => {
    // The fix changes no figure the app shows today, which is why it needs its own tests: the scenario builder
    // (31.6) is what makes a second pooled meter reachable.
    const pooled = new Set(FREE_TIERS.filter((t) => t.pool).map((t) => t.skuKey));
    const apps: FootprintApp[] = [{ name: "a", clouds: ["aws"], storage: false, secretCount: 0 }];
    const used = new Set<string>();
    for (const cloud of CLOUD_ORDER) {
      for (const p of [priceFootprintApp({ app: apps[0], cloud, n: 1, table: T }), priceScenarioCloud(BASE_SPEC, cloud, T).price]) {
        for (const c of p.creditLines) used.add(c.id);
      }
    }
    const pooledCredits = [...used].filter((id) => [...pooled].some((k) => k && id.endsWith(k)));
    expect(pooledCredits).toEqual(["credit.aws.serverless.lambda.gb.arm64"]);
  });
});
