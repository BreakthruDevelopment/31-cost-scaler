/**
 * Loads normalized prices for all four clouds from the checked-in SYNTHETIC fixtures (test/fixtures/prices), with no
 * network. CI runs it before the smoke test. The deployed app gets real prices from the refresh endpoint instead.
 *   DATABASE_URL=... pnpm seed:prices
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/lib/db/schema";
import { createFixtureFetcher } from "../src/lib/price-ingest/fixture-fetcher";
import { normalize } from "../src/lib/price-ingest/normalize";
import { collectSource } from "../src/lib/price-ingest/sources";
import { upsertPrices } from "../src/lib/price-ingest/upsert";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const sql = postgres(url, { max: 1 });
try {
  const database = drizzle(sql, { schema });
  const { fetcher } = createFixtureFetcher();
  let total = 0;
  for (const source of ["aws_ec2", "aws_other", "azure", "gcp", "oci"] as const) {
    const got = await collectSource(source, { fetch: fetcher, signal: AbortSignal.timeout(60_000), gcpApiKey: "fixture" });
    if (got.failed.length) throw new Error(`fixture source ${source} failed: ${got.failed.map((f) => f.code).join(",")}`);
    const { rows } = normalize({ source, groupsRead: got.groupsRead, rows: got.rows });
    total += (await upsertPrices(database, rows)).upserted;
  }
  console.log(`Seeded ${total} synthetic price rows from the fixtures.`);
} finally {
  await sql.end();
}
