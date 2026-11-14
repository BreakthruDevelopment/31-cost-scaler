/**
 * Loads the demo workspace (one demo user, three scenarios) into a LOCAL database. Refuses production hosts before
 * importing any database or auth code:
 *   DEMO_SEED=yes APP_URL=http://localhost:3000 DEMO_PASSWORD=<10+ chars> DATABASE_URL=... pnpm seed:demo
 */
import { demoSeedConfig } from "../src/lib/demo-seed-config";

try {
  demoSeedConfig();
  const { loadDemoWorkspace } = await import("../src/lib/demo-workspace");
  const result = await loadDemoWorkspace();
  console.log(`Loaded ${result.users} demo user and ${result.scenarios} scenarios.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : "Demo seed failed.");
  process.exitCode = 1;
} finally {
  const connection = globalThis as unknown as { sql?: { end(): Promise<void> } };
  await connection.sql?.end();
}
