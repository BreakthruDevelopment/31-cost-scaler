/**
 * Loads the footprint from the checked-in apps.yaml fixture, with no network. CI runs it before the smoke test,
 * and local development can use it when GitHub isn't reachable. The deployed app imports the real file instead
 * (the `footprint` refresh source).
 *   DATABASE_URL=... pnpm seed:footprint
 */
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { parseAppsYaml } from "../src/lib/footprint/apps-yaml";
import { replaceFootprint } from "../src/lib/footprint/store";
import * as schema from "../src/lib/db/schema";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const sql = postgres(url, { max: 1 });
try {
  const { apps, sourceCommit } = parseAppsYaml(readFileSync(new URL("../test/fixtures/apps.yaml", import.meta.url), "utf8"));
  const n = await replaceFootprint(drizzle(sql, { schema }), apps, sourceCommit);
  console.log(`Seeded ${n} footprint apps from the fixture.`);
} finally {
  await sql.end();
}
