import "server-only";
import { desc, eq } from "drizzle-orm";
import { type Actor } from "@/lib/auth/rbac";
import { assertCan } from "@/lib/access";
import { db, schema } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { ownedBy } from "@/lib/owned";
import { parseId } from "@/lib/scenarios";

/**
 * Read side of saved advisor answers: owner only, a 404 for anyone else (admin included). The advisor that writes
 * these rows arrives in issue 31.4; the access rule and its tests are here so it can't ship without them.
 */
export const MAX_ADVICE_HISTORY = 50;

export async function listAdvice(actor: Actor) {
  assertCan(actor, "list", "advice");
  const { advice } = schema;
  return db().select().from(advice).where(ownedBy(advice, actor)).orderBy(desc(advice.createdAt)).limit(MAX_ADVICE_HISTORY);
}

export async function getAdvice(actor: Actor, id: string) {
  const { advice } = schema;
  const [row] = await db().select().from(advice).where(ownedBy(advice, actor, eq(advice.id, parseId(id))));
  if (!row) throw new NotFoundError();
  assertCan(actor, "read", "advice", row);
  return row;
}
