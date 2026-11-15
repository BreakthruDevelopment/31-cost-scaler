import type { Readable } from "node:stream";
import { z } from "zod";
import { csvRecords } from "./csv";
import { decimalToPico, nanosToPico } from "./money";
import type { RawPrice } from "./types";

/**
 * The four parsers. Each turns one vendor response into `RawPrice` rows and does no mapping (that is `sku-map.ts`).
 * Every row is zod-checked; a malformed row is skipped and counted, never trusted. Vendor text is data: descriptions
 * are capped, and nothing here is ever executed or put into a prompt.
 */
export type ParseResult = { rows: RawPrice[]; skipped: number };

const cap = (s: string, n: number) => s.slice(0, n);

// ---------------------------------------------------------------------------------------------------------------
// AWS: Price List Bulk API CSV, streamed
// ---------------------------------------------------------------------------------------------------------------
const AWS_ATTRS = [
  "productfamily", "location", "instancetype", "operatingsystem", "tenancy", "preinstalledsw", "licensemodel", "capacitystatus",
  "usagetype", "operation", "databaseengine", "deploymentoption", "volumetype", "group", "transfertype", "fromlocation", "tolocation",
] as const;

export async function parseAwsCsv(
  stream: Readable,
  opts: { group: string; needles: readonly string[]; sourceUrl: string },
): Promise<ParseResult> {
  const rows: RawPrice[] = [];
  let skipped = 0;
  let version: string | null = null;
  const keep = (line: string) => opts.needles.some((n) => line.includes(n));
  for await (const r of csvRecords(stream, { keep })) {
    if (r.termtype !== "OnDemand" || r.currency !== "USD") continue;
    let pico;
    try {
      pico = decimalToPico(r.priceperunit);
    } catch {
      skipped++;
      continue;
    }
    const start = Number(r.startingrange || "0");
    const endText = r.endingrange;
    const end = endText === "" || endText === "Inf" ? null : Number(endText);
    if (!Number.isFinite(start) || (end !== null && !Number.isFinite(end))) {
      skipped++;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const k of AWS_ATTRS) attrs[k] = cap(r[k] ?? "", 120);
    version ??= r.effectivedate ? cap(r.effectivedate, 40) : null;
    rows.push({
      cloud: "aws",
      group: opts.group,
      vendorSku: cap(`${r.sku}.${r.ratecode}`, 120),
      description: cap(r.pricedescription ?? "", 200),
      vendorUnit: cap(r.unit ?? "", 40),
      pico,
      tierStart: start,
      tierEnd: end,
      attrs,
      sourceUrl: opts.sourceUrl,
      sourceVersion: version,
    });
  }
  return { rows, skipped };
}

// ---------------------------------------------------------------------------------------------------------------
// Azure: Retail Prices API (JSON pages)
// ---------------------------------------------------------------------------------------------------------------
const azureItem = z.object({
  retailPrice: z.number().nonnegative().max(1e9),
  unitPrice: z.number().nonnegative().max(1e9).optional(),
  tierMinimumUnits: z.number().nonnegative().optional(),
  armRegionName: z.string().max(60),
  meterId: z.string().max(80).optional(),
  skuId: z.string().max(80).optional(),
  meterName: z.string().max(200),
  productName: z.string().max(200),
  skuName: z.string().max(200).optional().default(""),
  armSkuName: z.string().max(200).optional().default(""),
  serviceName: z.string().max(120),
  unitOfMeasure: z.string().max(60),
  type: z.string().max(40),
  effectiveStartDate: z.string().max(40).optional(),
});

export const azurePage = z.object({ Items: z.array(z.unknown()).max(5000), NextPageLink: z.string().max(4096).nullable().optional() });

export function parseAzureItems(items: readonly unknown[], opts: { group: string; sourceUrl: string }): ParseResult {
  const rows: RawPrice[] = [];
  let skipped = 0;
  for (const raw of items) {
    const parsed = azureItem.safeParse(raw);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const it = parsed.data;
    if (it.type !== "Consumption" || it.armRegionName !== "eastus") continue;
    let pico;
    try {
      pico = decimalToPico(it.retailPrice);
    } catch {
      skipped++;
      continue;
    }
    rows.push({
      cloud: "azure",
      group: opts.group,
      vendorSku: cap(`${it.skuId ?? ""}/${it.meterId ?? ""}`, 120),
      description: cap(`${it.productName}: ${it.meterName}`, 200),
      vendorUnit: it.unitOfMeasure,
      pico,
      tierStart: it.tierMinimumUnits ?? 0,
      tierEnd: null,
      attrs: {
        serviceName: it.serviceName,
        productName: it.productName,
        skuName: it.skuName,
        armSkuName: it.armSkuName,
        meterName: it.meterName,
        unitOfMeasure: it.unitOfMeasure,
      },
      sourceUrl: opts.sourceUrl,
      sourceVersion: it.effectiveStartDate ? cap(it.effectiveStartDate, 40) : null,
    });
  }
  // The API returns tiers as separate rows with only a floor; fill each row's ceiling from the next floor.
  fillTierEnds(rows);
  return { rows, skipped };
}

/** Rows that share a meter get `tierEnd` = the next floor. */
function fillTierEnds(rows: RawPrice[]): void {
  const byMeter = new Map<string, RawPrice[]>();
  for (const r of rows) {
    const k = `${r.vendorSku}`;
    byMeter.set(k, [...(byMeter.get(k) ?? []), r]);
  }
  for (const list of byMeter.values()) {
    list.sort((a, b) => a.tierStart - b.tierStart);
    list.forEach((r, i) => (r.tierEnd = list[i + 1]?.tierStart ?? null));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Google Cloud: Cloud Billing Catalog API (JSON)
// ---------------------------------------------------------------------------------------------------------------
export const gcpServices = z.object({
  services: z.array(z.object({ name: z.string().max(120), serviceId: z.string().regex(/^[0-9A-Fa-f-]{1,40}$/), displayName: z.string().max(200) })).max(5000).default([]),
  nextPageToken: z.string().max(2000).optional(),
});

const gcpSku = z.object({
  skuId: z.string().max(60),
  description: z.string().max(400),
  category: z.object({
    serviceDisplayName: z.string().max(200),
    resourceFamily: z.string().max(100).optional().default(""),
    resourceGroup: z.string().max(100).optional().default(""),
    usageType: z.string().max(40).optional().default(""),
  }),
  serviceRegions: z.array(z.string().max(60)).max(200).default([]),
  pricingInfo: z
    .array(
      z.object({
        effectiveTime: z.string().max(40).optional(),
        pricingExpression: z.object({
          usageUnit: z.string().max(40),
          tieredRates: z
            .array(z.object({ startUsageAmount: z.number().nonnegative().default(0), unitPrice: z.object({ currencyCode: z.string(), units: z.union([z.string(), z.number()]).default("0"), nanos: z.number().int().default(0) }) }))
            .min(1)
            .max(40),
        }),
      }),
    )
    .min(1)
    .max(5),
});

export const gcpSkuPage = z.object({ skus: z.array(z.unknown()).max(10_000).default([]), nextPageToken: z.string().max(2000).optional() });

export function parseGcpSkus(skus: readonly unknown[], opts: { group: string; sourceUrl: string }): ParseResult {
  const rows: RawPrice[] = [];
  let skipped = 0;
  for (const raw of skus) {
    const p = gcpSku.safeParse(raw);
    if (!p.success) {
      skipped++;
      continue;
    }
    const sku = p.data;
    if (!sku.serviceRegions.includes("us-central1") && !sku.serviceRegions.includes("global")) continue;
    // The latest pricing info is the last one listed.
    const info = sku.pricingInfo[sku.pricingInfo.length - 1];
    const rates = info.pricingExpression.tieredRates;
    rates.forEach((rate, i) => {
      if (rate.unitPrice.currencyCode !== "USD") return;
      try {
        rows.push({
          cloud: "gcp",
          group: opts.group,
          vendorSku: cap(sku.skuId, 120),
          description: cap(sku.description, 200),
          vendorUnit: info.pricingExpression.usageUnit,
          pico: nanosToPico(rate.unitPrice.units, rate.unitPrice.nanos),
          tierStart: rate.startUsageAmount,
          tierEnd: rates[i + 1]?.startUsageAmount ?? null,
          attrs: {
            serviceDisplayName: sku.category.serviceDisplayName,
            resourceFamily: sku.category.resourceFamily,
            resourceGroup: sku.category.resourceGroup,
            usageType: sku.category.usageType,
            description: cap(sku.description, 400),
          },
          sourceUrl: opts.sourceUrl,
          sourceVersion: info.effectiveTime ? cap(info.effectiveTime, 40) : null,
        });
      } catch {
        skipped++;
      }
    });
  }
  return { rows, skipped };
}

// ---------------------------------------------------------------------------------------------------------------
// Oracle: price list API (one JSON document)
// ---------------------------------------------------------------------------------------------------------------
const ociItem = z.object({
  partNumber: z.string().max(40),
  displayName: z.string().max(300),
  metricName: z.string().max(120).optional().default(""),
  serviceCategory: z.string().max(120).optional().default(""),
  currencyCodeLocalizations: z
    .array(
      z.object({
        currencyCode: z.string(),
        prices: z.array(z.object({ model: z.string().max(40), value: z.number().nonnegative().max(1e9), rangeMin: z.number().nonnegative().optional(), rangeMax: z.number().nonnegative().nullable().optional() })).max(40),
      }),
    )
    .max(20),
});

export const ociDocument = z.object({ items: z.array(z.unknown()).max(50_000) });

export function parseOciItems(items: readonly unknown[], opts: { sourceUrl: string; wanted: ReadonlySet<string> }): ParseResult {
  const rows: RawPrice[] = [];
  let skipped = 0;
  for (const raw of items) {
    // Cheap check first: the list has thousands of products and we map a handful of part numbers.
    const partNumber = (raw as { partNumber?: unknown } | null)?.partNumber;
    if (typeof partNumber !== "string" || !opts.wanted.has(partNumber)) continue;
    const p = ociItem.safeParse(raw);
    if (!p.success) {
      skipped++;
      continue;
    }
    const usd = p.data.currencyCodeLocalizations.find((c) => c.currencyCode === "USD");
    for (const price of usd?.prices ?? []) {
      if (price.model !== "PAY_AS_YOU_GO") continue;
      try {
        rows.push({
          cloud: "oci",
          group: "oci",
          vendorSku: p.data.partNumber,
          description: cap(p.data.displayName, 200),
          vendorUnit: p.data.metricName,
          pico: decimalToPico(price.value),
          tierStart: price.rangeMin ?? 0,
          tierEnd: price.rangeMax ?? null,
          attrs: { partNumber: p.data.partNumber, serviceCategory: p.data.serviceCategory },
          sourceUrl: opts.sourceUrl,
          sourceVersion: null,
        });
      } catch {
        skipped++;
      }
    }
  }
  return { rows, skipped };
}
