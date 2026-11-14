import dns from "node:dns";
import type http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { PassThrough, Readable, Transform } from "node:stream";
import zlib from "node:zlib";
import { isPublicIp } from "@/lib/ip-guard";

/**
 * `fetchPriceSource()`: the only way this app talks to a price list. Same guarantees as `safe-fetch.ts` (the host is
 * resolved once, every address must be public, and the socket connects only to that validated list), but it
 * returns a STREAM, because the EC2 price list is hundreds of MB and must never be buffered, and it accepts only:
 *
 *  - HTTPS on port 443 to one of four fixed hosts, each with a fixed path shape;
 *  - no redirects (a redirect would leave the allowlist, so it is an error), no cookies, no credentials in the URL;
 *  - a byte cap on the wire AND after decompression, and one deadline (an AbortSignal) for the whole response.
 *
 * The Google API key travels only in the `x-goog-api-key` request header; it is never part of a URL, an error, a
 * log line or a stored row. Errors carry a fixed `code` (and the numeric status for HTTP errors), nothing else.
 */
export const PRICE_HOSTS = {
  aws: "pricing.us-east-1.amazonaws.com",
  azure: "prices.azure.com",
  gcp: "cloudbilling.googleapis.com",
  oci: "apexapps.oracle.com",
} as const;

const PATHS: Record<string, RegExp> = {
  [PRICE_HOSTS.aws]: /^\/offers\/v1\.0\/aws\/[A-Za-z0-9]{1,40}\/current\/[a-z0-9-]{1,20}\/index\.csv$/,
  [PRICE_HOSTS.azure]: /^\/api\/retail\/prices$/,
  [PRICE_HOSTS.gcp]: /^\/v1\/services(\/[0-9A-Fa-f-]{1,40}\/skus)?$/,
  [PRICE_HOSTS.oci]: /^\/pls\/apex\/cetools\/api\/v1\/products\/$/,
};

export const MAX_URL_LENGTH = 4096;

export type PriceFetchCode = "bad_url" | "blocked" | "dns" | "timeout" | "network" | "too_large" | "redirect" | "bad_encoding" | `http_${number}`;

export class PriceFetchError extends Error {
  constructor(readonly code: PriceFetchCode) {
    super(`price fetch failed: ${code}`);
    this.name = "PriceFetchError";
  }
}

export type PriceFetchOptions = {
  url: string;
  /** Cap on bytes on the wire and, separately, after decompression. */
  maxBytes: number;
  /** Aborts the connection and the stream; callers pass the run's single deadline. */
  signal: AbortSignal;
  /** Sent as `x-goog-api-key`. Only the Google host accepts one. */
  apiKey?: string;
};

export type PriceResponse = {
  /** Decoded body. Errors with a `PriceFetchError` when a cap or the deadline is hit. */
  stream: Readable;
  /** Decoded bytes delivered so far. */
  bytes: () => number;
};

type Resolve = (hostname: string) => Promise<{ address: string; family: number }[]>;

/** `deps` exist for tests: a fake resolver, a plain-HTTP server on another port. Production uses the defaults. */
export type PriceFetchDeps = {
  resolve?: Resolve;
  isPublic?: (address: string) => boolean;
  lib?: Pick<typeof https, "request">;
  port?: number;
};

export function createPriceFetcher(deps: PriceFetchDeps = {}) {
  const resolve: Resolve = deps.resolve ?? ((host) => dns.promises.lookup(host, { all: true, verbatim: true }));
  const isPublic = deps.isPublic ?? isPublicIp;
  const lib = deps.lib ?? https;

  return async function fetchPriceSource(opts: PriceFetchOptions): Promise<PriceResponse> {
    const url = vet(opts.url);
    if (opts.apiKey !== undefined && url.hostname !== PRICE_HOSTS.gcp) throw new PriceFetchError("bad_url");
    if (opts.signal.aborted) throw new PriceFetchError("timeout");

    let addresses: { address: string; family: number }[];
    try {
      addresses = await raceAbort(resolve(url.hostname), opts.signal);
    } catch (err) {
      if (err instanceof PriceFetchError) throw err;
      throw new PriceFetchError("dns");
    }
    if (addresses.length === 0 || !addresses.every((a) => isPublic(a.address))) throw new PriceFetchError("blocked");
    const pins = addresses.map((a) => ({ address: a.address, family: a.family === 6 || (a.family !== 4 && a.address.includes(":")) ? 6 : 4 }));

    const lookup: NonNullable<http.RequestOptions["lookup"]> = (_host, options, callback) => {
      if (typeof options === "object" && options.all) {
        (callback as unknown as (err: null, list: typeof pins) => void)(null, pins);
        return;
      }
      callback(null, pins[0].address, pins[0].family);
    };

    return new Promise<PriceResponse>((resolveResponse, reject) => {
      let settled = false;
      const out = new PassThrough();
      const req = lib.request(
        {
          protocol: lib === https ? "https:" : "http:",
          host: url.hostname,
          port: deps.port ?? 443,
          path: url.pathname + url.search,
          method: "GET",
          agent: false,
          lookup,
          servername: isIP(url.hostname) ? undefined : url.hostname,
          headers: {
            host: url.host,
            "user-agent": "30-apps-price-ingest",
            accept: "text/csv, application/json;q=0.9",
            "accept-encoding": "gzip, br",
            ...(opts.apiKey ? { "x-goog-api-key": opts.apiKey } : {}),
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            res.resume();
            fail(new PriceFetchError(status >= 300 && status < 400 ? "redirect" : `http_${status}`));
            return;
          }
          const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
          let decoder: Readable;
          if (encoding === "" || encoding === "identity") decoder = res;
          else if (encoding === "gzip" || encoding === "x-gzip") decoder = res.pipe(zlib.createGunzip());
          else if (encoding === "br") decoder = res.pipe(zlib.createBrotliDecompress());
          else {
            res.resume();
            fail(new PriceFetchError("bad_encoding"));
            return;
          }
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > opts.maxBytes) {
            res.resume();
            fail(new PriceFetchError("too_large"));
            return;
          }
          let wire = 0;
          let decoded = 0;
          const counter = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              decoded += chunk.length;
              if (decoded > opts.maxBytes) return cb(new PriceFetchError("too_large"));
              cb(null, chunk);
            },
          });
          res.on("data", (c: Buffer) => {
            wire += c.length;
            if (wire > opts.maxBytes) die(new PriceFetchError("too_large"));
          });
          // The FIRST failure wins: destroying the socket fires 'aborted' and 'error' on the way out, which must not
          // replace the real reason (a cap or the deadline) with "network".
          let dead = false;
          const die = (err: PriceFetchError) => {
            if (dead) return;
            dead = true;
            counter.destroy(err);
            out.destroy(err);
            req.destroy();
            res.destroy();
            decoder.destroy();
          };
          const onError = (err: unknown) => die(err instanceof PriceFetchError ? err : new PriceFetchError("network"));
          res.on("error", onError);
          if (decoder !== res) decoder.on("error", () => die(new PriceFetchError("bad_encoding")));
          res.on("aborted", () => die(new PriceFetchError("network")));
          counter.on("error", onError);
          opts.signal.addEventListener("abort", () => die(new PriceFetchError("timeout")), { once: true });
          decoder.pipe(counter).pipe(out);
          settled = true;
          resolveResponse({ stream: out, bytes: () => decoded });
        },
      );
      const fail = (err: PriceFetchError) => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(err);
      };
      opts.signal.addEventListener("abort", () => fail(new PriceFetchError("timeout")), { once: true });
      req.on("error", () => fail(new PriceFetchError("network")));
      req.end();
    });
  };
}

export const fetchPriceSource = createPriceFetcher();
export type PriceFetcher = ReturnType<typeof createPriceFetcher>;

/** Parse and vet a URL against the four hosts and their path shapes. The URL is never echoed back in an error. */
export function vet(input: string): URL {
  if (input.length > MAX_URL_LENGTH) throw new PriceFetchError("bad_url");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PriceFetchError("bad_url");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) throw new PriceFetchError("bad_url");
  const pathRule = PATHS[url.hostname];
  if (!pathRule) throw new PriceFetchError("bad_url");
  if (!pathRule.test(url.pathname)) throw new PriceFetchError("bad_url");
  return url;
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new PriceFetchError("timeout"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Read a (capped) response into a string. Only for the JSON sources, whose single pages are small. */
export async function readText(res: PriceResponse): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of res.stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

