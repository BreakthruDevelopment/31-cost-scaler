import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { PRICE_HOSTS, PriceFetchError, type PriceFetcher, type PriceFetchOptions, vet } from "./fetch";

/**
 * A `PriceFetcher` that serves the checked-in synthetic fixtures (test/fixtures/prices) and never touches the
 * network. Used by the tests and by `pnpm seed:prices` (CI), so smoke has price rows without egress. It records every
 * request (URL and whether a key was sent), so tests can assert what would have been fetched.
 */
const DIR = new URL("../../../test/fixtures/prices/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, DIR));

export type FixtureRequest = { url: string; apiKey: string | undefined };

export function createFixtureFetcher(opts: { failUrls?: (url: string) => PriceFetchError | undefined; azurePageSize?: number } = {}) {
  const requests: FixtureRequest[] = [];
  const fetcher: PriceFetcher = async (req: PriceFetchOptions) => {
    const url = vet(req.url); // same allowlist as production
    requests.push({ url: req.url, apiKey: req.apiKey });
    const failure = opts.failUrls?.(req.url);
    if (failure) throw failure;
    let body: Buffer;
    if (url.hostname === PRICE_HOSTS.aws) {
      const code = url.pathname.split("/")[4];
      body = read(`aws-${code}.csv`);
    } else if (url.hostname === PRICE_HOSTS.azure) {
      body = azurePage(url, opts.azurePageSize);
    } else if (url.hostname === PRICE_HOSTS.gcp) {
      const m = /^\/v1\/services\/([0-9A-Fa-f-]+)\/skus$/.exec(url.pathname);
      body = m ? read(`gcp-skus-${m[1]}.json`) : read("gcp-services.json");
    } else {
      body = read("oci-products.json");
    }
    if (body.length > req.maxBytes) throw new PriceFetchError("too_large");
    return { stream: Readable.from([body]), bytes: () => body.length };
  };
  return { fetcher, requests };
}

/** The Azure fixture holds every service; return only the one in `$filter`, optionally split into pages. */
function azurePage(url: URL, pageSize?: number): Buffer {
  const all = JSON.parse(read("azure-all.json").toString("utf8")) as { Items: { serviceName: string }[] };
  const service = /serviceName eq '((?:[^']|'')*)'/.exec(url.searchParams.get("$filter") ?? "")?.[1]?.replace(/''/g, "'");
  const items = all.Items.filter((i) => i.serviceName === service);
  const start = Number(url.searchParams.get("$skip") ?? 0);
  const size = pageSize ?? items.length;
  const slice = items.slice(start, start + size);
  const next = start + size < items.length ? `${url.origin}${url.pathname}?${new URLSearchParams({ "api-version": url.searchParams.get("api-version") ?? "", $filter: url.searchParams.get("$filter") ?? "", $skip: String(start + size) })}` : null;
  return Buffer.from(JSON.stringify({ Items: slice, NextPageLink: next, Count: slice.length }));
}
