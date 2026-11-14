import type { Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { FootprintEntry } from "./apps-yaml";

/**
 * Replace the whole footprint in ONE transaction: readers see the old list or the new one, never half. No
 * authorization here (no actor); callers are `runFootprintRefresh` (which asserts) and the CI seed script.
 */
export async function replaceFootprint(database: Pick<Db, "transaction">, apps: FootprintEntry[], sourceCommit: string): Promise<number> {
  await database.transaction(async (tx) => {
    await tx.delete(schema.footprintApp);
    if (apps.length === 0) return;
    const fetchedAt = new Date();
    await tx.insert(schema.footprintApp).values(
      apps.map((a) => ({
        name: a.name,
        title: a.title,
        clouds: a.clouds,
        domain: a.domain,
        storage: a.storage,
        secretCount: a.secretCount,
        ai: a.ai,
        sourceCommit,
        fetchedAt,
      })),
    );
  });
  return apps.length;
}
