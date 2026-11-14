import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRICE_HOSTS, PriceFetchError, createPriceFetcher, readText, vet } from "./fetch";

/**
 * `fetchPriceSource` against a local plain-HTTP server (the injected `lib`/`port`/`resolve` let the real code path run
 * with no network): the allowlist, redirects, caps, deadline, address checks, and the Google key's whole journey.
 */
const KEY = "AIzaSyCANARY-never-log-this-key";
let server: http.Server;
let port: number;
let lastHeaders: http.IncomingHttpHeaders = {};
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => res.end("ok");

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const fetcher = (over: Parameters<typeof createPriceFetcher>[0] = {}) =>
  createPriceFetcher({ resolve: async () => [{ address: "127.0.0.1", family: 4 }], isPublic: () => true, lib: http, port, ...over });
const AZURE = `https://${PRICE_HOSTS.azure}/api/retail/prices?api-version=2023-01-01-preview`;
const live = () => new AbortController().signal;
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof PriceFetchError ? e.code : `other:${String(e)}`));

describe("allowlist", () => {
  it.each([
    ["another host", "https://example.com/api/retail/prices"],
    ["a lookalike host", "https://prices.azure.com.evil.example/api/retail/prices"],
    ["plain http", "http://prices.azure.com/api/retail/prices"],
    ["a port", "https://prices.azure.com:8443/api/retail/prices"],
    ["credentials in the URL", "https://user:pw@prices.azure.com/api/retail/prices"],
    ["a different path on a known host", "https://prices.azure.com/other"],
    ["path traversal", "https://prices.azure.com/api/retail/prices/../../x"],
    ["an AWS path for another service shape", "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-2/index.json"],
    ["an IP literal", "https://127.0.0.1/api/retail/prices"],
    ["a fragment", "https://prices.azure.com/api/retail/prices#x"],
    ["junk", "not a url"],
    ["an oversized URL", `https://prices.azure.com/api/retail/prices?${"a".repeat(5000)}`],
  ])("refuses %s before any connection", async (_n, url) => {
    expect(() => vet(url)).toThrow(PriceFetchError);
    expect(await code(fetcher()({ url, maxBytes: 1000, signal: live() }))).toBe("bad_url");
  });

  it("accepts the four hosts with their paths", () => {
    for (const u of [
      `https://${PRICE_HOSTS.aws}/offers/v1.0/aws/AmazonEC2/current/us-east-2/index.csv`,
      `https://${PRICE_HOSTS.azure}/api/retail/prices?api-version=2023-01-01-preview&$filter=x`,
      `https://${PRICE_HOSTS.gcp}/v1/services`,
      `https://${PRICE_HOSTS.gcp}/v1/services/6F81-5844-456A/skus?pageSize=5000`,
      `https://${PRICE_HOSTS.oci}/pls/apex/cetools/api/v1/products/?currencyCode=USD`,
    ]) expect(vet(u).protocol).toBe("https:");
  });

  it("an API key may only go to the Google host", async () => {
    expect(await code(fetcher()({ url: AZURE, maxBytes: 1000, signal: live(), apiKey: KEY }))).toBe("bad_url");
  });
});

describe("requests and responses", () => {
  it("streams a body and counts decoded bytes", async () => {
    handler = (_q, res) => res.end("hello prices");
    const res = await fetcher()({ url: AZURE, maxBytes: 1000, signal: live() });
    expect(await readText(res)).toBe("hello prices");
    expect(res.bytes()).toBe(12);
  });

  it("sends the Google key as a header only: never in the URL, and no other host sees it", async () => {
    handler = (_q, res) => res.end("{}");
    let seenUrl = "";
    server.once("request", (req) => (seenUrl = req.url ?? ""));
    await readText(await fetcher()({ url: `https://${PRICE_HOSTS.gcp}/v1/services?pageSize=5000`, maxBytes: 1000, signal: live(), apiKey: KEY }));
    expect(lastHeaders["x-goog-api-key"]).toBe(KEY);
    expect(seenUrl).not.toContain(KEY);
    expect(seenUrl).not.toContain("key=");
    await readText(await fetcher()({ url: AZURE, maxBytes: 1000, signal: live() }));
    expect(lastHeaders["x-goog-api-key"]).toBeUndefined();
    expect(lastHeaders.cookie).toBeUndefined();
    expect(lastHeaders.authorization).toBeUndefined();
  });

  it("no error, from any failure, contains the key or the URL", async () => {
    const failures: [string, () => void][] = [
      ["http 403", () => (handler = (_q, res) => { res.statusCode = 403; res.end(`denied ${KEY}`); })],
      ["http 500", () => (handler = (_q, res) => { res.statusCode = 500; res.end(KEY); })],
      ["too large", () => (handler = (_q, res) => res.end(KEY.repeat(100)))],
      ["dropped connection", () => (handler = (q) => q.socket.destroy())],
    ];
    for (const [, set] of failures) {
      set();
      const err = await fetcher()({ url: `https://${PRICE_HOSTS.gcp}/v1/services`, maxBytes: 50, signal: live(), apiKey: KEY }).then(readText).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(PriceFetchError);
      const e = err as PriceFetchError;
      expect(JSON.stringify({ m: e.message, s: e.stack?.split("\n")[0], c: e.code, n: e.name })).not.toContain(KEY);
      expect(e.message).not.toContain("cloudbilling");
    }
  });

  it("an HTTP error status is a fixed code with the status", async () => {
    handler = (_q, res) => { res.statusCode = 429; res.end("slow down"); };
    expect(await code(fetcher()({ url: AZURE, maxBytes: 1000, signal: live() }))).toBe("http_429");
  });

  it("redirects are refused, never followed (that would leave the allowlist)", async () => {
    handler = (_q, res) => { res.statusCode = 302; res.setHeader("location", "https://evil.example/x"); res.end(); };
    expect(await code(fetcher()({ url: AZURE, maxBytes: 1000, signal: live() }))).toBe("redirect");
  });

  it("a declared length over the cap fails before the body is read; an undeclared body over the cap fails mid-stream", async () => {
    handler = (_q, res) => { res.setHeader("content-length", "5000"); res.end("x".repeat(5000)); };
    expect(await code(fetcher()({ url: AZURE, maxBytes: 100, signal: live() }))).toBe("too_large");
    handler = (_q, res) => { res.write("x".repeat(60)); setTimeout(() => res.end("y".repeat(60)), 20); };
    const res = await fetcher()({ url: AZURE, maxBytes: 100, signal: live() });
    expect(await code(readText(res))).toBe("too_large");
  });

  it("the cap applies after decompression too: a small gzip body that inflates past it is cut off", async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(5_000_000, 97));
    expect(bomb.length).toBeLessThan(10_000);
    handler = (_q, res) => { res.setHeader("content-encoding", "gzip"); res.end(bomb); };
    const res = await fetcher()({ url: AZURE, maxBytes: 100_000, signal: live() });
    expect(await code(readText(res))).toBe("too_large");
  });

  it("decodes gzip and brotli normally", async () => {
    handler = (_q, res) => { res.setHeader("content-encoding", "gzip"); res.end(zlib.gzipSync("zipped prices")); };
    expect(await readText(await fetcher()({ url: AZURE, maxBytes: 1000, signal: live() }))).toBe("zipped prices");
    handler = (_q, res) => { res.setHeader("content-encoding", "br"); res.end(zlib.brotliCompressSync("brotli prices")); };
    expect(await readText(await fetcher()({ url: AZURE, maxBytes: 1000, signal: live() }))).toBe("brotli prices");
  });

  it("an encoding we don't know is refused", async () => {
    handler = (_q, res) => { res.setHeader("content-encoding", "compress"); res.end("x"); };
    expect(await code(fetcher()({ url: AZURE, maxBytes: 1000, signal: live() }))).toBe("bad_encoding");
  });

  it("the deadline aborts a slow server, whether before headers or mid-body", async () => {
    handler = () => { /* never answers */ };
    expect(await code(fetcher()({ url: AZURE, maxBytes: 1000, signal: AbortSignal.timeout(80) }))).toBe("timeout");
    handler = (_q, res) => { res.write("partial"); };
    const res = await fetcher()({ url: AZURE, maxBytes: 1000, signal: AbortSignal.timeout(150) });
    expect(await code(readText(res))).toBe("timeout");
    expect(await code(fetcher()({ url: AZURE, maxBytes: 1000, signal: AbortSignal.abort() }))).toBe("timeout");
  });
});

describe("addresses", () => {
  it("refuses a host that resolves to any non-public address, and never connects", async () => {
    let hit = false;
    handler = (_q, res) => { hit = true; res.end("x"); };
    const mixed = createPriceFetcher({ resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.5", family: 4 }], lib: http, port });
    expect(await code(mixed({ url: AZURE, maxBytes: 1000, signal: live() }))).toBe("blocked");
    const loopback = createPriceFetcher({ resolve: async () => [{ address: "127.0.0.1", family: 4 }], lib: http, port });
    expect(await code(loopback({ url: AZURE, maxBytes: 1000, signal: live() }))).toBe("blocked");
    const metadata = createPriceFetcher({ resolve: async () => [{ address: "169.254.169.254", family: 4 }], lib: http, port });
    expect(await code(metadata({ url: AZURE, maxBytes: 1000, signal: live() }))).toBe("blocked");
    expect(hit).toBe(false);
  });
  it("a resolver failure or an empty answer is a fixed code", async () => {
    expect(await code(createPriceFetcher({ resolve: async () => { throw new Error("ENOTFOUND secret.internal"); } })({ url: AZURE, maxBytes: 1, signal: live() }))).toBe("dns");
    expect(await code(createPriceFetcher({ resolve: async () => [] })({ url: AZURE, maxBytes: 1, signal: live() }))).toBe("blocked");
  });
});
