/**
 * Loads a small SYNTHETIC price table (test/fixtures/pricing-table.ts) for all four clouds, with no network, so the
 * pricing engine has something to price in CI. Rows already in the table are left alone (`on conflict do nothing`),
 * so it never overwrites real prices or the 31.2 fixture seed. Local databases only, like the other seeds.
 *   DATABASE_URL=... pnpm seed:pricing-fixture
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/lib/db/schema";
import { fixturePriceRows } from "../test/fixtures/pricing-table";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();
if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]", "postgres", "db"].includes(host)) {
  console.error("Pricing fixture seed refused: synthetic prices only go into a local database, never production.");
  process.exit(1);
}
const REGION = { aws: "us-east-2", azure: "eastus", gcp: "us-central1", oci: "global" } as const;
const sql = postgres(url, { max: 1 });
try {
  const database = drizzle(sql, { schema });
  const rows = fixturePriceRows().map((r) => ({
    cloud: r.cloud,
    component: r.component,
    skuKey: r.skuKey,
    region: REGION[r.cloud],
    unit: r.unit,
    usdMicros: Number(r.usdMicros),
    tierStart: r.tierStart,
    tierEnd: r.tierEnd,
    description: "Synthetic fixture price (CI only)",
    sourceUrl: r.sourceUrl,
    fetchedAt: new Date(),
    sourceVersion: "pricing-fixture",
  }));
  const inserted = await database.insert(schema.pricePoint).values(rows).onConflictDoNothing().returning({ id: schema.pricePoint.id });
  console.log(`Seeded ${inserted.length} of ${rows.length} synthetic pricing-fixture rows (existing rows kept).`);
} finally {
  await sql.end();
}
