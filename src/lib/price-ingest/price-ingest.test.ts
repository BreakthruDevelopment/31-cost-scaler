import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { csvRecords, lines, parseCsvLine } from "./csv";
import { PriceFetchError } from "./fetch";
import { createFixtureFetcher } from "./fixture-fetcher";
import { FREE_TIERS } from "./free-tiers";
import { decimalToPico, nanosToPico, picoToMicros, scale } from "./money";
import { SANITY_BOUNDS, inBounds, normalize } from "./normalize";
import { parseAwsCsv, parseAzureItems, parseGcpSkus, parseOciItems } from "./parsers";
import { AWS_NEEDLES, OCI_PART_NUMBERS, REFERENCE_SIZES, REQUIRED_KEYS, RULES, SOURCE_CLOUD, SOURCE_GROUPS } from "./sku-map";
import { collectSource } from "./sources";
import { bearerMatches } from "./token";
import type { NormalizedRow, NotListed, PriceSourceId, RawPrice } from "./types";
import { jumped } from "./upsert";

const fixture = (name: string) => readFileSync(new URL(`../../../test/fixtures/prices/${name}`, import.meta.url));
const SOURCES = ["aws_ec2", "aws_other", "azure", "gcp", "oci"] as const satisfies readonly PriceSourceId[];
const signal = () => new AbortController().signal;

async function run(source: PriceSourceId, opts: Parameters<typeof createFixtureFetcher>[0] = {}) {
  const { fetcher, requests } = createFixtureFetcher(opts);
  const got = await collectSource(source, { fetch: fetcher, signal: signal(), gcpApiKey: "k" });
  return { got, requests, ...normalize({ source, groupsRead: got.groupsRead, rows: got.rows }) };
}

describe("money", () => {
  it("parses decimals exactly and rounds once, half up, to micro-dollars", () => {
    expect(picoToMicros(decimalToPico("0.096"))).toBe(96_000);
    expect(picoToMicros(decimalToPico("0.0000166667"))).toBe(17); // why serverless is stored per hour
    expect(picoToMicros(scale(decimalToPico("0.0000166667"), 3600n))).toBe(60_000);
    expect(picoToMicros(decimalToPico("0.0000005"))).toBe(1); // half up
    expect(picoToMicros(decimalToPico("0.0000004999"))).toBe(0);
    expect(decimalToPico(0.000024)).toBe(24_000_000n);
    expect(decimalToPico("12")).toBe(12_000_000_000_000n);
  });
  it("converts Google's units and nanos", () => {
    expect(picoToMicros(nanosToPico("0", 21_811_000))).toBe(21_811);
    expect(picoToMicros(nanosToPico("2", 500_000_000))).toBe(2_500_000);
  });
  it.each(["", "-1", "1e-5", "abc", "1.2.3", "NaN", "9999999999999999"])("refuses %j as a price", (v) => {
    expect(() => decimalToPico(v)).toThrow(RangeError);
  });
  it("refuses a negative or non-finite number", () => {
    expect(() => decimalToPico(-1)).toThrow();
    expect(() => decimalToPico(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => nanosToPico("0", 1_000_000_000)).toThrow();
  });
  it("keeps whole-dollar prices exact up to the bound", () => {
    expect(picoToMicros(decimalToPico("100000000"))).toBe(100_000_000_000_000);
  });
});

describe("csv", () => {
  it("splits quoted fields, escaped quotes, commas and empty fields", () => {
    expect(parseCsvLine('"a","b,c","say ""hi""","",')).toEqual(["a", "b,c", 'say "hi"', "", ""]);
    expect(parseCsvLine("a,b,,d")).toEqual(["a", "b", "", "d"]);
    expect(parseCsvLine('"only"')).toEqual(["only"]);
  });

  it("yields lines across arbitrary chunk boundaries, with CRLF", async () => {
    const out: string[] = [];
    for await (const l of lines(Readable.from(["ab", "c\r\nde", "f\n", "g"]))) out.push(l);
    expect(out).toEqual(["abc", "def", "g"]);
  });

  it("reads the AWS shape: metadata, header, records; header names are normalized", async () => {
    const stream = Readable.from([Buffer.from('"FormatVersion","v1.0"\n"x","y"\n"SKU","Instance Type","PricePerUnit"\n"S1","m6i.large","0.1"\n"S2","c6i.large","0.2"\n')]);
    const seen: Record<string, string>[] = [];
    for await (const r of csvRecords(stream, { keep: (l) => l.includes("m6i") })) seen.push(r);
    expect(seen).toEqual([{ sku: "S1", instancetype: "m6i.large", priceperunit: "0.1" }]);
  });

  it("joins a record whose quoted field contains a newline", async () => {
    const stream = Readable.from(['"SKU","Desc","P"\n"S1","two\nlines","1"\n']);
    const out: Record<string, string>[] = [];
    for await (const r of csvRecords(stream, { keep: () => true })) out.push(r);
    expect(out).toEqual([{ sku: "S1", desc: "two\nlines", p: "1" }]);
  });

  it("fails clearly when there is no header", async () => {
    await expect((async () => { for await (const _ of csvRecords(Readable.from(["a,b\n1,2\n"]), { keep: () => true })) void _; })()).rejects.toMatchObject({ code: "no_header" });
  });

  it("refuses an endless line", async () => {
    await expect((async () => { for await (const _ of lines(Readable.from(["x".repeat(300_000)]))) void _; })()).rejects.toMatchObject({ code: "line_too_long" });
  });

  it("streams: a record is delivered while most of the file has not even been produced, and unmatched lines are never parsed", async () => {
    const total = 400;
    let produced = 0;
    const header = '"SKU","Instance Type","PricePerUnit"\n';
    async function* source() {
      yield header;
      for (let i = 0; i < total; i++) {
        produced++;
        // 64 KB of rows per chunk; only the first row of the first chunk is one we price.
        yield (i === 0 ? '"S0","m6i.large","0.1"\n' : "") + '"X","other.type","9"\n'.repeat(3000);
      }
    }
    let kept = 0;
    let producedAtFirstRecord = -1;
    let n = 0;
    for await (const r of csvRecords(Readable.from(source()), { keep: (l) => { kept++; return l.includes("m6i"); } })) {
      if (n++ === 0) producedAtFirstRecord = produced;
      expect(r.sku).toBe("S0");
    }
    expect(n).toBe(1);
    expect(producedAtFirstRecord).toBeLessThan(total / 4);
    expect(kept).toBe(1 + total * 3000); // every line is substring-tested (cheap), only the match is parsed
  });
});

describe("parsers on the fixtures", () => {
  it("AWS: keeps on-demand USD rows that pass the substring filter, with tiers and attributes", async () => {
    const res = await parseAwsCsv(Readable.from([fixture("aws-AmazonS3.csv")]), { group: "AmazonS3", needles: AWS_NEEDLES.AmazonS3, sourceUrl: "https://x" });
    expect(res.skipped).toBe(0);
    const std = res.rows.filter((r) => r.attrs.volumetype === "Standard");
    expect(std.map((r) => [r.tierStart, r.tierEnd, Number(r.pico)])).toEqual([[0, 51200, 23_000_000_000], [51200, 512000, 22_000_000_000], [512000, null, 21_000_000_000]]);
    expect(res.rows.every((r) => r.attrs.usagetype.includes("TimedStorage-ByteHrs"))).toBe(true);
  });
  it("AWS: a row with an unparseable price is skipped and counted, never trusted", async () => {
    const csv = '"SKU","TermType","Currency","PricePerUnit","StartingRange","EndingRange","Unit","usagetype"\n"S","OnDemand","USD","oops","0","Inf","GB-Mo","TimedStorage-ByteHrs"\n"T","OnDemand","USD","0.1","0","Inf","GB-Mo","TimedStorage-ByteHrs"\n"U","OnDemand","EUR","0.1","0","Inf","GB-Mo","TimedStorage-ByteHrs"\n';
    const res = await parseAwsCsv(Readable.from([csv]), { group: "AmazonS3", needles: ["TimedStorage"], sourceUrl: "https://x" });
    expect(res.skipped).toBe(1);
    expect(res.rows).toHaveLength(1);
  });
  it("Azure: only Consumption rows in eastus; malformed items skipped; tier ceilings filled from the next floor", () => {
    const all = JSON.parse(fixture("azure-all.json").toString()) as { Items: unknown[] };
    const res = parseAzureItems([...all.Items, { retailPrice: "free" }, 7], { group: "x", sourceUrl: "https://x" });
    expect(res.skipped).toBe(2);
    expect(res.rows.some((r) => r.attrs.armSkuName === "Standard_D2s_v5" && r.pico === decimalToPico("0.099"))).toBe(false); // westeurope
    const blob = res.rows.filter((r) => r.attrs.meterName === "Hot LRS Data Stored").sort((a, b) => a.tierStart - b.tierStart);
    expect(blob.map((r) => [r.tierStart, r.tierEnd])).toEqual([[0, 51200], [51200, null]]);
  });
  it("Google: us-central1 and global SKUs only, nanos exact, tier ends from the next rate", () => {
    const skus = (JSON.parse(fixture("gcp-skus-E505-1604-58F8.json").toString()) as { skus: unknown[] }).skus;
    const res = parseGcpSkus([...skus, { skuId: "bad" }], { group: "Networking", sourceUrl: "https://x" });
    expect(res.skipped).toBe(1);
    const egress = res.rows.filter((r) => r.description === "Network Internet Egress from Americas to Americas");
    expect(egress.map((r) => [r.tierStart, r.tierEnd, picoToMicros(r.pico)])).toEqual([[0, 1024, 120_000], [1024, 10240, 110_000], [10240, null, 80_000]]);
    const eu = parseGcpSkus(JSON.parse(fixture("gcp-skus-6F81-5844-456A.json").toString()).skus, { group: "Compute Engine", sourceUrl: "https://x" });
    expect(eu.rows.some((r) => r.description.includes("Frankfurt"))).toBe(false);
  });
  it("Oracle: keeps only mapped part numbers and PAY_AS_YOU_GO USD prices", () => {
    const items = (JSON.parse(fixture("oci-products.json").toString()) as { items: unknown[] }).items;
    const res = parseOciItems(items, { sourceUrl: "https://x", wanted: OCI_PART_NUMBERS });
    expect(new Set(res.rows.map((r) => r.vendorSku))).toEqual(OCI_PART_NUMBERS);
    expect(res.rows.filter((r) => r.vendorSku === "B88327").map((r) => [r.tierStart, r.tierEnd])).toEqual([[0, 10240], [10240, null]]);
  });
});

describe("sku-map", () => {
  // The micro-dollar value each row must have, from the synthetic fixtures. One line per row: change a fixture and exactly
  // the affected row fails.
  const EXPECTED: Record<string, number | "not_listed"> = {
    "aws vm.2vcpu-8gb": 96_000, "aws vm.4vcpu-16gb": 192_000, "aws vm.vcpu": 48_000, "aws vm.gb": 12_000,
    "aws serverless.vcpu": 40_480, "aws serverless.gb": 4_445, "aws serverless.requests": "not_listed", "aws serverless.lambda.gb": 60_000, "aws serverless.lambda.requests": 200_000,
    "aws postgres.2vcpu-8gb": 178_000, "aws postgres.4vcpu-16gb": 356_000, "aws postgres.2vcpu-8gb.ha": 356_000, "aws postgres.4vcpu-16gb.ha": 712_000, "aws postgres.storage": 115_000, "aws postgres.storage.ha": 230_000,
    "aws object_storage.gb": 23_000, "aws egress.gb": 90_000, "aws identity.mau": 5_500,
    "aws load_balancer.hour": 22_500, "aws load_balancer.data": "not_listed", "aws load_balancer.capacity": 8_000,
    "azure vm.2vcpu-8gb": 96_000, "azure vm.4vcpu-16gb": 192_000, "azure vm.vcpu": 48_000, "azure vm.gb": 12_000,
    "azure serverless.vcpu": 86_400, "azure serverless.gb": 10_800, "azure serverless.requests": 400_000,
    "azure postgres.vcpu": 124_000, "azure postgres.2vcpu-8gb": 248_000, "azure postgres.4vcpu-16gb": 496_000, "azure postgres.2vcpu-8gb.ha": "not_listed", "azure postgres.4vcpu-16gb.ha": "not_listed", "azure postgres.storage": 115_000, "azure postgres.storage.ha": "not_listed",
    "azure object_storage.gb": 18_400, "azure egress.gb": 87_000, "azure identity.mau": 3_250,
    "azure load_balancer.hour": 246_000, "azure load_balancer.data": "not_listed", "azure load_balancer.capacity": 8_000,
    "gcp vm.vcpu": 21_811, "gcp vm.gb": 2_923, "gcp vm.2vcpu-8gb": 67_006, "gcp vm.4vcpu-16gb": 134_012,
    "gcp serverless.vcpu": 86_400, "gcp serverless.gb": 9_000, "gcp serverless.requests": 400_000,
    "gcp postgres.vcpu": 41_300, "gcp postgres.gb": 7_000, "gcp postgres.vcpu.ha": 82_600, "gcp postgres.gb.ha": 14_000,
    "gcp postgres.2vcpu-8gb": 138_600, "gcp postgres.4vcpu-16gb": 277_200, "gcp postgres.2vcpu-8gb.ha": 277_200, "gcp postgres.4vcpu-16gb.ha": 554_400, "gcp postgres.storage": 170_000, "gcp postgres.storage.ha": 340_000,
    "gcp object_storage.gb": 20_000, "gcp egress.gb": 120_000, "gcp identity.mau": 5_500,
    "gcp load_balancer.hour": 25_000, "gcp load_balancer.data": 8_000, "gcp load_balancer.capacity": "not_listed",
    "oci vm.vcpu": 12_500, "oci vm.gb": 1_500, "oci vm.2vcpu-8gb": 37_000, "oci vm.4vcpu-16gb": 74_000,
    "oci serverless.vcpu": 12_500, "oci serverless.gb": 1_500, "oci serverless.requests": "not_listed",
    "oci postgres.2vcpu-8gb": "not_listed", "oci postgres.4vcpu-16gb": "not_listed", "oci postgres.2vcpu-8gb.ha": "not_listed", "oci postgres.4vcpu-16gb.ha": "not_listed", "oci postgres.storage": "not_listed", "oci postgres.storage.ha": "not_listed",
    "oci object_storage.gb": 25_500, "oci egress.gb": 8_500, "oci identity.mau": "not_listed",
    "oci load_balancer.hour": 11_300, "oci load_balancer.data": "not_listed", "oci load_balancer.capacity": "not_listed",
  };
  const results = new Map<string, { rows: NormalizedRow[]; notListed: NotListed[] }>();
  const resultFor = async (source: PriceSourceId) => {
    if (!results.has(source)) results.set(source, await run(source));
    return results.get(source)!;
  };

  it.each(RULES.map((r) => [`${r.cloud} ${r.key}`, r] as const))("%s", async (name, rule) => {
    const expected = EXPECTED[name];
    expect(expected, `no expected value for ${name}`).toBeDefined();
    const source = SOURCES.find((s) => SOURCE_CLOUD[s] === rule.cloud && (rule.kind === "direct" ? SOURCE_GROUPS[s].includes(rule.group) : rule.kind === "sum" ? rule.groups.every((g) => SOURCE_GROUPS[s].includes(g)) : s === (rule.component === "vm" ? "aws_ec2" : rule.cloud === "aws" ? "aws_other" : s)))!;
    const { rows, notListed } = await resultFor(source);
    const row = rows.find((r) => r.skuKey === rule.key);
    if (expected === "not_listed") {
      expect(row, `${name} should be absent`).toBeUndefined();
      expect(notListed.some((n) => n.skuKey === rule.key && n.cloud === rule.cloud && n.reason.length > 0)).toBe(true);
    } else {
      expect(row?.usdMicros, name).toBe(expected);
      expect(row!.usdMicros).toBeGreaterThan(0); // never zero
      expect(row).toMatchObject({ cloud: rule.cloud, component: rule.component, unit: (rule as { unit: string }).unit });
      expect(row!.description.length).toBeLessThanOrEqual(200);
      expect(inBounds(row!.unit, row!.usdMicros)).toBe(true);
      expect(row!.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it("has an expected line for every rule and no stray ones", () => {
    expect(new Set(Object.keys(EXPECTED))).toEqual(new Set(RULES.map((r) => `${r.cloud} ${r.key}`)));
  });

  it("every cloud has every required key, as a row or an explicit not-listed rule (never silent)", () => {
    for (const cloud of ["aws", "azure", "gcp", "oci"] as const) {
      for (const [component, keys] of Object.entries(REQUIRED_KEYS)) {
        for (const key of keys) {
          const rule = RULES.find((r) => r.cloud === cloud && r.key === key);
          expect(rule, `${cloud} ${key}`).toBeDefined();
          expect(rule!.component).toBe(component);
        }
      }
    }
  });

  it("rule keys are unique per cloud, and every sum part points at an earlier rule of the same cloud", () => {
    const seen = new Set<string>();
    for (const r of RULES) {
      const id = `${r.cloud} ${r.key}`;
      expect(seen.has(id), `duplicate ${id}`).toBe(false);
      if (r.kind === "sum") for (const p of r.parts) expect(seen.has(`${r.cloud} ${p.key}`), `${id} needs ${p.key} first`).toBe(true);
      seen.add(id);
    }
  });

  it("reference sizes are one set shared by every cloud", () => {
    for (const cloud of ["aws", "azure", "gcp", "oci"] as const) for (const s of REFERENCE_SIZES) expect(RULES.some((r) => r.cloud === cloud && r.key === `vm.${s.id}`)).toBe(true);
  });

  it("every AWS group has needles, every mapped group belongs to a source", () => {
    for (const g of SOURCE_GROUPS.aws_ec2.concat(SOURCE_GROUPS.aws_other)) expect(AWS_NEEDLES[g]?.length, g).toBeGreaterThan(0);
    const groups = new Set(SOURCES.flatMap((s) => SOURCE_GROUPS[s]));
    for (const r of RULES) if (r.kind === "direct") expect(groups.has(r.group), `${r.cloud} ${r.key}`).toBe(true);
  });

  it("every component has a row on every cloud or an explicit not-listed (the issue's done-when)", async () => {
    const byCloud = new Map<string, Set<string>>();
    const listed = new Set<string>();
    for (const s of SOURCES) {
      const { rows, notListed } = await resultFor(s);
      for (const r of rows) listed.add(`${r.cloud} ${r.component}`);
      for (const n of notListed) byCloud.set(`${n.cloud} ${n.component}`, (byCloud.get(`${n.cloud} ${n.component}`) ?? new Set()).add(n.skuKey));
    }
    for (const cloud of ["aws", "azure", "gcp", "oci"]) {
      for (const component of Object.keys(REQUIRED_KEYS)) {
        const id = `${cloud} ${component}`;
        expect(listed.has(id) || byCloud.has(id), id).toBe(true);
      }
    }
  });
});

describe("normalizer", () => {
  const raw = (over: Partial<RawPrice>): RawPrice => ({ cloud: "oci", group: "oci", vendorSku: "B93113", description: "", vendorUnit: "", pico: 25_000_000_000n, tierStart: 0, tierEnd: null, attrs: { partNumber: "B93113" }, sourceUrl: "https://x", sourceVersion: null, ...over });
  const one = (rows: RawPrice[], groups = new Set(["oci"])) => normalize({ source: "oci", groupsRead: groups, rows });

  it("a SKU the list does not have is absent and reported, never zero", () => {
    const { rows, notListed } = one([]);
    expect(rows).toEqual([]);
    expect(notListed.find((n) => n.skuKey === "vm.vcpu")?.reason).toMatch(/no matching SKU/);
    expect(notListed.find((n) => n.skuKey === "vm.2vcpu-8gb")?.reason).toMatch(/not listed/); // a sum with a missing part
  });
  it("a price that is zero is not a price", () => {
    const { rows, notListed } = one([raw({ pico: 0n })]);
    expect(rows.find((r) => r.skuKey === "vm.vcpu")).toBeUndefined();
    expect(notListed.some((n) => n.skuKey === "vm.vcpu")).toBe(true);
  });
  it("conflicting prices for one rule are ambiguous: no row, not a guess", () => {
    const { rows, notListed } = one([raw({ pico: 25_000_000_000n, vendorSku: "a" }), raw({ pico: 30_000_000_000n, vendorSku: "b" })]);
    expect(rows.find((r) => r.skuKey === "vm.vcpu")).toBeUndefined();
    expect(notListed.find((n) => n.skuKey === "vm.vcpu")?.reason).toMatch(/different prices/);
  });
  it("identical duplicate rows are fine", () => {
    expect(one([raw({}), raw({ vendorSku: "dup" })]).rows.find((r) => r.skuKey === "vm.vcpu")?.usdMicros).toBe(12_500);
  });
  it("a group that failed to download is not judged: no row, and not reported as not listed", () => {
    const { rows, notListed } = one([], new Set());
    expect(rows).toEqual([]);
    expect(notListed.filter((n) => n.skuKey.startsWith("vm."))).toEqual([]);
  });
  it("first_paid skips the free tier; only-free means not listed", () => {
    const tiers = [raw({ attrs: { partNumber: "B88327" }, pico: 0n, tierStart: 0, tierEnd: 10240 }), raw({ attrs: { partNumber: "B88327" }, pico: 8_500_000_000n, tierStart: 10240 })];
    expect(one(tiers).rows.find((r) => r.skuKey === "egress.gb")).toMatchObject({ usdMicros: 8_500, tierStart: 10240 });
    expect(one([tiers[0]]).notListed.find((n) => n.skuKey === "egress.gb")?.reason).toMatch(/free/);
  });
  it("sanity bounds exist for every unit the map uses and reject zero and absurd prices", () => {
    for (const r of RULES) if (r.kind !== "absent") expect(SANITY_BOUNDS[r.unit], r.unit).toBeDefined();
    expect(inBounds("hour", 0)).toBe(false);
    expect(inBounds("hour", 100_000_001)).toBe(false);
    expect(inBounds("hour", 96_000)).toBe(true);
    expect(inBounds("nope", 5)).toBe(false);
  });
});

describe("the 3x rule", () => {
  it("flags more than 3x up or down, not exactly 3x", () => {
    expect(jumped(1000, 3000)).toBe(false);
    expect(jumped(1000, 3001)).toBe(true);
    expect(jumped(3000, 1000)).toBe(false);
    expect(jumped(3001, 1000)).toBe(true);
    expect(jumped(1000, 1000)).toBe(false);
  });
});

describe("collecting a source", () => {
  it("reads every group of every source from the fixtures with no failures", async () => {
    for (const s of SOURCES) {
      const { got } = await run(s);
      expect(got.failed, s).toEqual([]);
      expect(got.groupsRead.size).toBe(SOURCE_GROUPS[s].length);
      expect(got.bytes).toBeGreaterThan(0);
    }
  });
  it("only ever requests the fixed hosts, over https, and sends the key only to Google", async () => {
    const all = (await Promise.all(SOURCES.map((s) => run(s)))).flatMap((r) => r.requests);
    const hosts = new Set(all.map((r) => new URL(r.url).host));
    expect(hosts).toEqual(new Set(["pricing.us-east-1.amazonaws.com", "prices.azure.com", "cloudbilling.googleapis.com", "apexapps.oracle.com"]));
    for (const r of all) {
      expect(r.url.startsWith("https://")).toBe(true);
      expect(r.url).not.toContain("key=");
      expect(r.apiKey !== undefined).toBe(new URL(r.url).host === "cloudbilling.googleapis.com");
    }
  });
  it("follows Azure pages, and a failed group is isolated: the others still land", async () => {
    const { got, requests, rows } = await run("azure", { azurePageSize: 2 });
    expect(requests.filter((r) => r.url.includes("%24skip") || r.url.includes("$skip")).length).toBeGreaterThan(3);
    expect(rows.find((r) => r.skuKey === "vm.2vcpu-8gb")?.usdMicros).toBe(96_000);
    expect(got.failed).toEqual([]);
    const failing = await run("aws_other", { failUrls: (u) => (u.includes("/AmazonRDS/") ? new PriceFetchError("http_503") : undefined) });
    expect(failing.got.failed).toEqual([{ group: "AmazonRDS", code: "fetch_http_503" }]);
    expect(failing.rows.some((r) => r.skuKey === "object_storage.gb")).toBe(true);
    expect(failing.rows.some((r) => r.skuKey.startsWith("postgres."))).toBe(false);
    expect(failing.notListed.some((n) => n.skuKey.startsWith("postgres."))).toBe(false); // not judged, so not "not listed"
  });
  it("a bad response is a fixed code, not its content", async () => {
    const { got } = await run("oci", { failUrls: () => new PriceFetchError("too_large") });
    expect(got.failed).toEqual([{ group: "oci", code: "fetch_too_large" }]);
  });
});

describe("free tiers", () => {
  it("each allowance has a positive quantity and an https source link", () => {
    expect(FREE_TIERS.length).toBeGreaterThan(10);
    for (const f of FREE_TIERS) {
      expect(f.quantity).toBeGreaterThan(0);
      expect(f.sourceUrl).toMatch(/^https:\/\/[a-z0-9.-]+\//);
      if (f.skuKey) expect(RULES.some((r) => r.cloud === f.cloud && r.key === f.skuKey), `${f.cloud} ${f.skuKey}`).toBe(true);
    }
    expect(new Set(FREE_TIERS.map((f) => f.cloud))).toEqual(new Set(["aws", "azure", "gcp", "oci"]));
  });
});

describe("bearer token", () => {
  it("matches only the exact token", () => {
    const t = "a-long-refresh-token-0123456789";
    expect(bearerMatches(`Bearer ${t}`, t)).toBe(true);
    for (const h of [null, "", "Bearer ", `Bearer ${t}x`, `bearer ${t}`, t, `Bearer ${t.toUpperCase()}`, "Basic abc"]) expect(bearerMatches(h, t)).toBe(false);
  });
  it("no token configured means no bearer access, even for an empty header value", () => {
    expect(bearerMatches("Bearer anything", undefined)).toBe(false);
    expect(bearerMatches("Bearer ", "")).toBe(false);
  });
});
