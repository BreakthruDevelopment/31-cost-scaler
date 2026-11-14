import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { assertCan } from "@/lib/access";
import { db, schema } from "@/lib/db";
import { CLOUDS, COMPONENTS } from "@/lib/db/schema";

/** Public read of the normalized price table: active rows only. Quarantined rows are for the admin. */
export const priceFilter = z.object({ cloud: z.enum(CLOUDS).optional(), component: z.enum(COMPONENTS).optional() });

export const MAX_PRICE_ROWS = 2000;

export async function listPricePoints(filter: unknown = {}) {
  assertCan(null, "read", "price_point");
  const f = priceFilter.parse(filter);
  const p = schema.pricePoint;
  return db()
    .select()
    .from(p)
    .where(and(eq(p.status, "active"), f.cloud ? eq(p.cloud, f.cloud) : undefined, f.component ? eq(p.component, f.component) : undefined))
    .orderBy(asc(p.cloud), asc(p.component), asc(p.skuKey), asc(p.tierStart))
    .limit(MAX_PRICE_ROWS);
}
