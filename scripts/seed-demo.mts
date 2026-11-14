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
  // A refusal from demoSeedConfig() is ours and safe to show; anything else (a database error embeds query
  // parameters) prints a short code only.
  const message = err instanceof Error && /^Demo seed refused: /.test(err.message) ? err.message : null;
  const status = (err as { status?: unknown } | null)?.status;
  console.error(message ?? (status === 409 ? "Demo seed conflict: the demo email belongs to an unrelated account." : "Demo seed failed (see server logs)."));
  process.exitCode = 1;
} finally {
  const connection = globalThis as unknown as { sql?: { end(): Promise<void> } };
  await connection.sql?.end();
}
