import type { Readable } from "node:stream";

/**
 * Streaming reader for AWS Price List Bulk API CSV files. The EC2 file is hundreds of MB, so nothing here holds the
 * file: bytes are split into lines as they arrive, and every line is checked with a cheap SUBSTRING test
 * (`keep`) BEFORE any CSV parsing, so the millions of rows we don't price cost almost nothing. Memory stays at one
 * chunk plus one line.
 *
 * Format: a few metadata lines, then a header line (`"SKU","OfferTermCode","RateCode",...`), then one record per
 * line. Header names are normalized (lower case, letters and digits only) so "Instance Type" and "instanceType"
 * match. A record whose quotes don't balance is joined with the next line (bounded) before parsing.
 */
export const MAX_LINE_BYTES = 256 * 1024;
const MAX_JOINED_LINES = 16;

export type CsvOptions = {
  /** Cheap pre-filter on the raw line. Return false to skip the line without parsing it. */
  keep: (line: string) => boolean;
};

export class CsvError extends Error {
  constructor(readonly code: "no_header" | "line_too_long") {
    super(`csv: ${code}`);
    this.name = "CsvError";
  }
}

export const normalizeHeader = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Split one CSV record into fields (RFC 4180 quoting; `""` is a quote inside quotes). */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  const n = line.length;
  while (i <= n) {
    if (line[i] === '"') {
      let value = "";
      i++;
      for (;;) {
        const q = line.indexOf('"', i);
        if (q === -1) {
          value += line.slice(i);
          i = n;
          break;
        }
        value += line.slice(i, q);
        if (line[q + 1] === '"') {
          value += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
      fields.push(value);
      if (line[i] === ",") i++;
      else break;
    } else {
      const c = line.indexOf(",", i);
      if (c === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, c));
      i = c + 1;
      if (i === n) {
        fields.push("");
        break;
      }
    }
  }
  return fields;
}

const quoteCount = (s: string) => {
  let n = 0;
  for (let i = s.indexOf('"'); i !== -1; i = s.indexOf('"', i + 1)) n++;
  return n;
};

/** Lines of a stream, decoded as UTF-8, without buffering more than one line plus one chunk. */
export async function* lines(stream: Readable): AsyncGenerator<string> {
  let tail = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream as AsyncIterable<string>) {
    tail += chunk;
    let start = 0;
    for (let nl = tail.indexOf("\n", start); nl !== -1; nl = tail.indexOf("\n", start)) {
      const line = tail.slice(start, nl);
      start = nl + 1;
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
    }
    tail = tail.slice(start);
    if (tail.length > MAX_LINE_BYTES) throw new CsvError("line_too_long");
  }
  if (tail) yield tail.endsWith("\r") ? tail.slice(0, -1) : tail;
}

/** Records as objects keyed by normalized header name. Lines `keep` rejects are skipped unparsed. */
export async function* csvRecords(stream: Readable, opts: CsvOptions): AsyncGenerator<Record<string, string>> {
  let header: string[] | null = null;
  let pending: string[] = [];
  for await (const raw of lines(stream)) {
    if (!header) {
      if (raw.startsWith('"SKU"') || raw.startsWith("SKU,")) header = parseCsvLine(raw).map(normalizeHeader);
      continue;
    }
    // The substring filter runs first, on the raw line, so rows we don't price are never scanned further.
    if (!pending.length && !opts.keep(raw)) continue;
    let line = raw;
    if (pending.length) {
      pending.push(raw);
      line = pending.join("\n");
      if (quoteCount(line) % 2 === 1 && pending.length < MAX_JOINED_LINES) continue;
      pending = [];
    } else if (quoteCount(line) % 2 === 1) {
      pending = [raw];
      continue;
    }
    const fields = parseCsvLine(line);
    const record: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) record[header[i]] = fields[i] ?? "";
    yield record;
  }
  if (!header) throw new CsvError("no_header");
}
