import { ZodError } from "zod";
import { CsvError } from "./csv";
import { PRICE_HOSTS, PriceFetchError, type PriceFetcher, readText } from "./fetch";
import { ociDocument, azurePage, gcpServices, gcpSkuPage, parseAwsCsv, parseAzureItems, parseGcpSkus, parseOciItems } from "./parsers";
import { AWS_NEEDLES, OCI_PART_NUMBERS, SOURCE_GROUPS } from "./sku-map";
import type { PriceSourceId, RawPrice } from "./types";

/**
 * Fetch and parse one refresh source into raw rows. Each GROUP (one AWS service file, one Azure service, one Google
 * service, the Oracle list) succeeds or fails alone: a failed group is reported with a fixed code and leaves its
 * existing rows untouched; the other groups still land. Byte caps follow the spec: AWS EC2 2 GB (streamed), every
 * other response 50 MB (for the JSON sources, summed across pages).
 */
export const EC2_MAX_BYTES = 2 * 1024 ** 3;
export const OTHER_MAX_BYTES = 50 * 1024 ** 2;
/** The RDS price list is the biggest of the "other" files (the parser streams it, so the cap is about memory-free time and disk-free bytes). */
export const RDS_MAX_BYTES = 500 * 1024 ** 2;
export const RUN_DEADLINE_MS = 240_000;
const MAX_PAGES = 40;

export type CollectContext = { fetch: PriceFetcher; signal: AbortSignal; gcpApiKey?: string };
export type FailedGroup = { group: string; code: string };
export type CollectResult = {
  rows: RawPrice[];
  groupsRead: Set<string>;
  failed: FailedGroup[];
  bytes: number;
  bytesByGroup: Record<string, number>;
  skipped: number;
};

export function failureCode(err: unknown): string {
  if (err instanceof PriceFetchError) return `fetch_${err.code}`;
  if (err instanceof CsvError) return `csv_${err.code}`;
  if (err instanceof ZodError || err instanceof SyntaxError) return "invalid_response";
  return "internal";
}

export async function collectSource(source: PriceSourceId, ctx: CollectContext): Promise<CollectResult> {
  const result: CollectResult = { rows: [], groupsRead: new Set(), failed: [], bytes: 0, bytesByGroup: {}, skipped: 0 };
  for (const group of SOURCE_GROUPS[source]) {
    if (ctx.signal.aborted) {
      result.failed.push({ group, code: "fetch_timeout" });
      continue;
    }
    try {
      const got = await collectGroup(source, group, ctx);
      result.rows.push(...got.rows);
      result.skipped += got.skipped;
      result.bytes += got.bytes;
      result.bytesByGroup[group] = got.bytes;
      result.groupsRead.add(group);
    } catch (err) {
      result.failed.push({ group, code: failureCode(err) });
    }
  }
  return result;
}

type GroupResult = { rows: RawPrice[]; skipped: number; bytes: number };

async function collectGroup(source: PriceSourceId, group: string, ctx: CollectContext): Promise<GroupResult> {
  switch (source) {
    case "aws_ec2":
    case "aws_other":
      return awsGroup(group, source === "aws_ec2" ? EC2_MAX_BYTES : group === "AmazonRDS" ? RDS_MAX_BYTES : OTHER_MAX_BYTES, ctx);
    case "azure":
      return azureGroup(group, ctx);
    case "gcp":
      return gcpGroup(group, ctx);
    case "oci":
      return ociGroup(ctx);
  }
}

async function awsGroup(group: string, maxBytes: number, ctx: CollectContext): Promise<GroupResult> {
  const url = `https://${PRICE_HOSTS.aws}/offers/v1.0/aws/${group}/current/us-east-2/index.csv`;
  const res = await ctx.fetch({ url, maxBytes, signal: ctx.signal });
  // Streamed: lines are filtered by substring before any CSV parsing, and nothing is buffered.
  const parsed = await parseAwsCsv(res.stream, { group, needles: AWS_NEEDLES[group] ?? [], sourceUrl: url });
  return { ...parsed, bytes: res.bytes() };
}

/**
 * Narrow the big Azure services in the query itself, so the response stays small: Virtual Machines lists thousands of
 * sizes (only the two reference sizes are read, see REFERENCE_SIZES in sku-map), Storage hundreds of products (only
 * Blob v2), and PostgreSQL only the compute and storage products the map reads. Values are case-sensitive.
 */
const AZURE_NARROW: Record<string, string> = {
  "Virtual Machines": " and (armSkuName eq 'Standard_D2s_v5' or armSkuName eq 'Standard_D4s_v5')",
  Storage: " and productName eq 'General Block Blob v2'",
  "Azure Database for PostgreSQL":
    " and (productName eq 'Azure Database for PostgreSQL Flexible Server General Purpose Ddsv5 Series Compute' or productName eq 'Azure Database for PostgreSQL Flexible Server Burstable BS Series Compute' or productName eq 'Azure Database for PostgreSQL Flexible Server Storage')",
};

async function azureGroup(group: string, ctx: CollectContext): Promise<GroupResult> {
  const filter = `armRegionName eq 'eastus' and priceType eq 'Consumption' and serviceName eq '${group.replace(/'/g, "''")}'${AZURE_NARROW[group] ?? ""}`;
  const first = `https://${PRICE_HOSTS.azure}/api/retail/prices?${new URLSearchParams({ "api-version": "2023-01-01-preview", $filter: filter })}`;
  const rows: RawPrice[] = [];
  let skipped = 0;
  let bytes = 0;
  let url: string | null = first;
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) throw new PriceFetchError("too_large");
    const res = await ctx.fetch({ url, maxBytes: OTHER_MAX_BYTES - bytes, signal: ctx.signal });
    const body = azurePage.parse(JSON.parse(await readText(res)));
    bytes += res.bytes();
    const parsed = parseAzureItems(body.Items, { group, sourceUrl: first.split("?")[0] });
    rows.push(...parsed.rows);
    skipped += parsed.skipped;
    // Only a link back to the same API is followed; `vet` inside the fetcher rejects any other host or path.
    url = body.NextPageLink ?? null;
  }
  fillTiersAcrossPages(rows);
  return { rows, skipped, bytes };
}

/** Tier ceilings were filled per page; a meter's tiers can span pages, so do it again over the whole group. */
function fillTiersAcrossPages(rows: RawPrice[]): void {
  const byMeter = new Map<string, RawPrice[]>();
  for (const r of rows) byMeter.set(r.vendorSku, [...(byMeter.get(r.vendorSku) ?? []), r]);
  for (const list of byMeter.values()) {
    list.sort((a, b) => a.tierStart - b.tierStart);
    list.forEach((r, i) => (r.tierEnd = list[i + 1]?.tierStart ?? null));
  }
}

async function gcpGroup(group: string, ctx: CollectContext): Promise<GroupResult> {
  if (!ctx.gcpApiKey) throw new PriceFetchError("blocked"); // callers skip the source before this; defence in depth
  let bytes = 0;
  const servicesUrl = `https://${PRICE_HOSTS.gcp}/v1/services?${new URLSearchParams({ pageSize: "5000" })}`;
  let serviceId: string | undefined;
  let token: string | undefined;
  for (let page = 0; !serviceId && page < MAX_PAGES; page++) {
    const url = token ? `${servicesUrl}&${new URLSearchParams({ pageToken: token })}` : servicesUrl;
    const res = await ctx.fetch({ url, maxBytes: OTHER_MAX_BYTES - bytes, signal: ctx.signal, apiKey: ctx.gcpApiKey });
    const body = gcpServices.parse(JSON.parse(await readText(res)));
    bytes += res.bytes();
    serviceId = body.services.find((s) => s.displayName === group)?.serviceId;
    token = body.nextPageToken;
    if (!token) break;
  }
  if (!serviceId) throw new ZodError([]); // the service is not in the catalog: reported as invalid_response

  const rows: RawPrice[] = [];
  let skipped = 0;
  const base = `https://${PRICE_HOSTS.gcp}/v1/services/${serviceId}/skus`;
  token = undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ pageSize: "5000", currencyCode: "USD", ...(token ? { pageToken: token } : {}) });
    const res = await ctx.fetch({ url: `${base}?${params}`, maxBytes: OTHER_MAX_BYTES - bytes, signal: ctx.signal, apiKey: ctx.gcpApiKey });
    const body = gcpSkuPage.parse(JSON.parse(await readText(res)));
    bytes += res.bytes();
    const parsed = parseGcpSkus(body.skus, { group, sourceUrl: base });
    rows.push(...parsed.rows);
    skipped += parsed.skipped;
    token = body.nextPageToken;
    if (!token) return { rows, skipped, bytes };
  }
  throw new PriceFetchError("too_large");
}

async function ociGroup(ctx: CollectContext): Promise<GroupResult> {
  const url = `https://${PRICE_HOSTS.oci}/pls/apex/cetools/api/v1/products/?currencyCode=USD`;
  const res = await ctx.fetch({ url, maxBytes: OTHER_MAX_BYTES, signal: ctx.signal });
  const body = ociDocument.parse(JSON.parse(await readText(res)));
  const parsed = parseOciItems(body.items, { sourceUrl: `https://${PRICE_HOSTS.oci}/pls/apex/cetools/api/v1/products/`, wanted: OCI_PART_NUMBERS });
  return { ...parsed, bytes: res.bytes() };
}
