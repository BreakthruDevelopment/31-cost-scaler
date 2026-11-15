import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { inBounds } from "./normalize";
import type { NormalizedRow } from "./types";

/**
 * Write normalized rows, idempotently, with two guards:
 *  - sanity bounds: a price outside its unit's bounds is not stored;
 *  - the 3x rule: a price that moved by more than 3x (up or down) from the stored one is QUARANTINED: the stored row
 *    keeps its old value and gets status `quarantined` (the public table hides it; /admin lists it with both values).
 *    A later run whose price is back within 3x of the kept value makes the row active again.
 * A rerun with the same data updates the same rows (same unique key) and changes nothing else.
 */
export const JUMP_FACTOR = 3;
export const MAX_QUARANTINE_NOTES = 50;

export type QuarantineNote = { cloud: string; skuKey: string; oldMicros: number | null; newMicros: number; reason: "out_of_bounds" | "jump_over_3x" };
export type UpsertResult = { upserted: number; quarantined: QuarantineNote[] };

type Handle = Pick<Db, "transaction">;
const skuOf = (r: { cloud: string; skuKey: string; region: string }) => `${r.cloud}|${r.skuKey}|${r.region}`;

export const jumped = (oldMicros: number, newMicros: number) => newMicros > oldMicros * JUMP_FACTOR || newMicros * JUMP_FACTOR < oldMicros;

export async function upsertPrices(database: Handle, rows: readonly NormalizedRow[], fetchedAt: Date = new Date()): Promise<UpsertResult> {
  const { pricePoint } = schema;
  return database.transaction(async (tx) => {
    const clouds = [...new Set(rows.map((r) => r.cloud))];
    const existing = clouds.length ? await tx.select().from(pricePoint).where(inArray(pricePoint.cloud, clouds)) : [];
    // The previous price is looked up per (cloud, sku_key, region), NOT per tier: a changed tier floor must still be
    // compared with what was stored (lowest tier first), or it would dodge the 3x rule and leave two rows for one key.
    const bySku = new Map<string, typeof existing>();
    for (const e of existing) bySku.set(skuOf(e), [...(bySku.get(skuOf(e)) ?? []), e].sort((a, b) => a.tierStart - b.tierStart));

    const toWrite: NormalizedRow[] = [];
    const toQuarantine: string[] = [];
    const toRetire: string[] = [];
    const notes: QuarantineNote[] = [];
    for (const row of rows) {
      const rowsOfSku = bySku.get(skuOf(row)) ?? [];
      const old = rowsOfSku.find((e) => e.tierStart === row.tierStart) ?? rowsOfSku[0];
      const bad = !inBounds(row.unit, row.usdMicros) ? "out_of_bounds" : old && jumped(old.usdMicros, row.usdMicros) ? "jump_over_3x" : null;
      if (!bad) {
        toWrite.push(row);
        // The tier floor moved and the new price is accepted: the other tier rows of this key are retired with it.
        toRetire.push(...rowsOfSku.filter((e) => e.tierStart !== row.tierStart).map((e) => e.id));
        continue;
      }
      notes.push({ cloud: row.cloud, skuKey: row.skuKey, oldMicros: old?.usdMicros ?? null, newMicros: row.usdMicros, reason: bad });
      toQuarantine.push(...rowsOfSku.map((e) => e.id));
    }

    for (let i = 0; i < toWrite.length; i += 200) {
      const chunk = toWrite.slice(i, i + 200);
      await tx
        .insert(pricePoint)
        .values(
          chunk.map((r) => ({
            cloud: r.cloud,
            component: r.component,
            skuKey: r.skuKey,
            region: r.region,
            unit: r.unit,
            usdMicros: r.usdMicros,
            tierStart: r.tierStart,
            tierEnd: r.tierEnd,
            vendorSku: r.vendorSku,
            description: r.description,
            sourceUrl: r.sourceUrl,
            fetchedAt,
            sourceVersion: r.sourceVersion,
            status: "active" as const,
          })),
        )
        .onConflictDoUpdate({
          target: [pricePoint.cloud, pricePoint.skuKey, pricePoint.region, pricePoint.tierStart],
          set: {
            component: sql`excluded.component`,
            unit: sql`excluded.unit`,
            usdMicros: sql`excluded.usd_micros`,
            tierEnd: sql`excluded.tier_end`,
            vendorSku: sql`excluded.vendor_sku`,
            description: sql`excluded.description`,
            sourceUrl: sql`excluded.source_url`,
            fetchedAt: sql`excluded.fetched_at`,
            sourceVersion: sql`excluded.source_version`,
            status: sql`'active'`,
          },
        });
    }
    if (toRetire.length) await tx.delete(pricePoint).where(inArray(pricePoint.id, toRetire));
    // Old value kept: only the status changes.
    if (toQuarantine.length) await tx.update(pricePoint).set({ status: "quarantined" }).where(and(inArray(pricePoint.id, toQuarantine), eq(pricePoint.status, "active")));
    return { upserted: toWrite.length, quarantined: notes };
  });
}
