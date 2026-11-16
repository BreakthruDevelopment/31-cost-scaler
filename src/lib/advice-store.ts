import "server-only";
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import { type Actor } from "@/lib/auth/rbac";
import { assertCan } from "@/lib/access";
import { db, schema } from "@/lib/db";
import { NotFoundError, TooManyRequestsError } from "@/lib/errors";
import { ownedBy } from "@/lib/owned";
import { parseId } from "@/lib/scenarios";
import { type Tx, lockRate } from "@/lib/usage";

/**
 * Saved advisor answers: owner only, a 404 for anyone else (admin included). `createAdvice` is the only writer
 * (called by `askAdvisor` in advisor.ts); the composite foreign key refuses a scenario that is not the asker's.
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

/**
 * The per-user daily limit: at most `limit` stored answers in the last 24 hours. Call it inside the rate transaction,
 * before `consumeRate`: it takes the same per-user lock, so concurrent questions are counted one at a time. It counts
 * `advice` rows (not `rate_event`, which `consumeRate` prunes after an hour). An answer is stored when it finishes, so
 * a question still running is not counted yet; the per-hour limit bounds how many can be.
 */
export async function assertAdviceDailyLimit(tx: Tx, userId: string, limit: number, message: string): Promise<void> {
  const { advice } = schema;
  await lockRate(tx, userId, "advice");
  const [{ n }] = await tx
    .select({ n: count() })
    .from(advice)
    .where(and(eq(advice.ownerId, userId), gt(advice.createdAt, sql`now() - interval '24 hours'`)));
  if (n >= limit) throw new TooManyRequestsError(message);
}

/** A Postgres text/jsonb value can't hold a NUL; model text could, so drop them from every string before storing. */
export function withoutNul<T>(value: T): T {
  if (typeof value === "string") return value.replaceAll("\0", "") as T;
  if (Array.isArray(value)) return value.map(withoutNul) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replaceAll("\0", ""), withoutNul(v)])) as T;
  return value;
}

export type NewAdvice = {
  question: string;
  appName: string | null;
  scenarioId: string | null;
  output: unknown;
  trace: unknown;
  checks: unknown;
  provider: string;
  demo: boolean;
  /** Client-minted id for one user intent; a second create with the same id returns the first row. */
  clientOpId?: string | null;
};

/** The caller's own answer for a client op id, or null. */
export async function findAdviceByOp(actor: Actor, clientOpId: string) {
  assertCan(actor, "list", "advice");
  const { advice } = schema;
  const [row] = await db().select().from(advice).where(ownedBy(advice, actor, eq(advice.clientOpId, clientOpId)));
  return row ?? null;
}

/** Idempotent per (owner, client op id): the unique index decides, so two parallel creates leave one row. */
export async function createAdvice(actor: Actor, input: NewAdvice) {
  assertCan(actor, "create", "advice");
  const { advice } = schema;
  const [row] = await db()
    .insert(advice)
    .values({
      ownerId: actor.id, // always the actor, never a value from the caller's payload
      question: input.question.slice(0, 500),
      appName: input.appName,
      scenarioId: input.scenarioId,
      output: withoutNul(input.output),
      trace: withoutNul(input.trace),
      checks: withoutNul(input.checks),
      provider: input.provider,
      demo: input.demo,
      clientOpId: input.clientOpId ?? null,
    })
    .onConflictDoNothing({ target: [advice.ownerId, advice.clientOpId] })
    .returning();
  if (row) return { advice: row, created: true };
  const existing = input.clientOpId ? await findAdviceByOp(actor, input.clientOpId) : null;
  if (!existing) throw new Error("advice insert conflicted but no row was found");
  return { advice: existing, created: false };
}
