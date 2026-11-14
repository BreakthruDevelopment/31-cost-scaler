import "server-only";
import { count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Actor } from "@/lib/auth/rbac";
import { assertCan } from "@/lib/access";
import { db, schema } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { ownedBy } from "@/lib/owned";
import { scenarioSpec } from "@/lib/pricing/spec";
import { jsonHasNul, text } from "@/lib/text";
import { consumeRate, releaseRate } from "@/lib/usage";

/**
 * Scenarios and their saved results. Every function takes the acting user and calls `assertCan()` first; every
 * query also filters with `ownedBy()`, so another user's id (an admin's included) matches nothing and answers 404.
 */
export const MAX_SCENARIOS_PER_USER = 50;
export const SCENARIO_WRITES_PER_HOUR = 60;
export const MAX_RESULT_BYTES = 256 * 1024;

const scenarioId = z.string().uuid();

/** A malformed id is just another id that doesn't exist: 404, not 400, so ids can't be probed by shape. */
export function parseId(id: unknown): string {
  const parsed = scenarioId.safeParse(id);
  if (!parsed.success) throw new NotFoundError();
  return parsed.data;
}

export const newScenarioInput = z.object({
  name: text(80, { min: 1, minMessage: "Name is required" }),
  spec: scenarioSpec,
  /** Client-generated id for one user intent (see `src/lib/client-op.ts`). Retrying with the same id never creates a second row. */
  clientOpId: z.string().uuid().optional(),
});

export const updateScenarioInput = z
  .object({
    /** The version the client read; a stale one is a 409. */
    version: z.number().int().min(1),
    name: text(80, { min: 1, minMessage: "Name is required" }).optional(),
    spec: scenarioSpec.optional(),
  })
  .refine((v) => v.name !== undefined || v.spec !== undefined, "Nothing to change");

/** Rejects a NUL anywhere in a JSON payload before it reaches jsonb (Postgres can't store it). */
export function assertNoNul(value: unknown): void {
  if (jsonHasNul(value)) throw new BadRequestError("Text can't contain null characters");
}

export type ScenarioRow = typeof schema.scenario.$inferSelect;

export async function listScenarios(actor: Actor): Promise<ScenarioRow[]> {
  assertCan(actor, "list", "scenario");
  const { scenario } = schema;
  return db().select().from(scenario).where(ownedBy(scenario, actor)).orderBy(desc(scenario.updatedAt)).limit(MAX_SCENARIOS_PER_USER);
}

export async function getScenario(actor: Actor, id: string): Promise<ScenarioRow> {
  const { scenario } = schema;
  const [row] = await db().select().from(scenario).where(ownedBy(scenario, actor, eq(scenario.id, parseId(id))));
  if (!row) throw new NotFoundError();
  assertCan(actor, "read", "scenario", row);
  return row;
}

/**
 * Create a scenario. Idempotent per (owner, client op id): a replay returns the first row (`created: false`) and
 * does not count against the write limit. At most 50 scenarios and 60 writes per hour per user.
 */
export async function createScenario(actor: Actor, input: unknown): Promise<{ scenario: ScenarioRow; created: boolean }> {
  assertCan(actor, "create", "scenario");
  const data = newScenarioInput.parse(input);
  assertNoNul(data.spec);
  const { scenario } = schema;

  const replay = async () => {
    if (!data.clientOpId) return undefined;
    const [existing] = await db().select().from(scenario).where(ownedBy(scenario, actor, eq(scenario.clientOpId, data.clientOpId)));
    return existing;
  };
  const before = await replay();
  if (before) return { scenario: before, created: false };

  return db().transaction(async (tx) => {
    // consumeRate takes this user's advisory lock for the rest of the transaction, so the count below can't race
    // another create by the same user. A throw rolls the whole transaction back, including the rate row.
    await consumeRate(tx, actor.id, "scenario_write", SCENARIO_WRITES_PER_HOUR, "Too many scenario changes this hour. Try again later.");
    const [{ n }] = await tx.select({ n: count() }).from(scenario).where(ownedBy(scenario, actor));
    if (n >= MAX_SCENARIOS_PER_USER) throw new ConflictError(`You can keep up to ${MAX_SCENARIOS_PER_USER} scenarios. Delete one first.`);
    const [row] = await tx
      .insert(scenario)
      .values({ ownerId: actor.id, name: data.name, baseApp: data.spec.baseApp ?? null, spec: data.spec, clientOpId: data.clientOpId ?? null })
      .onConflictDoNothing({ target: [scenario.ownerId, scenario.clientOpId] })
      .returning();
    if (row) return { scenario: row, created: true };
    // Lost a race with the same op id from this user: hand back the winner and refund the write.
    await releaseRate(tx, actor.id, "scenario_write");
    const [winner] = await tx.select().from(scenario).where(ownedBy(scenario, actor, eq(scenario.clientOpId, data.clientOpId!)));
    return { scenario: winner, created: false };
  });
}

/** Change a scenario's name and/or spec. `version` must be the current one, else 409. A new spec drops the saved result, which no longer matches it. */
export async function updateScenario(actor: Actor, id: string, input: unknown): Promise<ScenarioRow> {
  assertCan(actor, "update", "scenario", await findOwnedOrNull(actor, id));
  const data = updateScenarioInput.parse(input);
  if (data.spec) assertNoNul(data.spec);
  const { scenario, scenarioResult } = schema;
  const sid = parseId(id);
  return db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, "scenario_write", SCENARIO_WRITES_PER_HOUR, "Too many scenario changes this hour. Try again later.");
    const [row] = await tx
      .update(scenario)
      .set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.spec ? { spec: data.spec, baseApp: data.spec.baseApp ?? null } : {}),
        version: sql`${scenario.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(ownedBy(scenario, actor, eq(scenario.id, sid), eq(scenario.version, data.version)))
      .returning();
    if (!row) {
      // Either someone else's/missing (404) or a stale version (409); the owner-scoped lookup tells them apart.
      const [exists] = await tx.select({ id: scenario.id }).from(scenario).where(ownedBy(scenario, actor, eq(scenario.id, sid)));
      if (!exists) throw new NotFoundError();
      throw new ConflictError("This scenario changed since you loaded it. Reload and try again.");
    }
    if (data.spec) await tx.delete(scenarioResult).where(ownedBy(scenarioResult, actor, eq(scenarioResult.scenarioId, sid)));
    return row;
  });
}

async function findOwnedOrNull(actor: Actor, id: string) {
  const { scenario } = schema;
  const [row] = await db().select({ ownerId: scenario.ownerId }).from(scenario).where(ownedBy(scenario, actor, eq(scenario.id, parseId(id))));
  if (!row) throw new NotFoundError();
  return row;
}

export async function deleteScenario(actor: Actor, id: string): Promise<void> {
  assertCan(actor, "delete", "scenario", await findOwnedOrNull(actor, id));
  const { scenario } = schema;
  await db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, "scenario_write", SCENARIO_WRITES_PER_HOUR, "Too many scenario changes this hour. Try again later.");
    const gone = await tx.delete(scenario).where(ownedBy(scenario, actor, eq(scenario.id, parseId(id)))).returning({ id: scenario.id });
    if (gone.length === 0) throw new NotFoundError();
  });
}

// ---------------------------------------------------------------------------
// Saved results (latest per scenario; compare uses these)
// ---------------------------------------------------------------------------

export type ScenarioResultRow = typeof schema.scenarioResult.$inferSelect;

/** Store (replace) the latest result of one of the actor's scenarios. The shape of `result` belongs to the pricing engine (31.3). */
export async function saveScenarioResult(actor: Actor, id: string, input: { pricesAsOf: Date; result: unknown }): Promise<ScenarioResultRow> {
  const sid = parseId(id);
  const { scenarioResult } = schema;
  const when = z.date().parse(input.pricesAsOf);
  assertNoNul(input.result);
  const bytes = Buffer.byteLength(JSON.stringify(input.result ?? null));
  if (bytes > MAX_RESULT_BYTES) throw new BadRequestError("Result too large");
  const owned = await findOwnedOrNull(actor, sid);
  assertCan(actor, "write", "scenario_result", owned);
  const [row] = await db()
    .insert(scenarioResult)
    .values({ scenarioId: sid, ownerId: actor.id, pricesAsOf: when, result: input.result ?? null })
    .onConflictDoUpdate({
      target: scenarioResult.scenarioId,
      set: { pricesAsOf: when, result: input.result ?? null, computedAt: sql`now()` },
      // The conflicting row can only be this owner's: the composite FK ties scenario_id to owner_id.
      setWhere: eq(scenarioResult.ownerId, actor.id),
    })
    .returning();
  return row;
}

/** The latest saved result of one of the actor's scenarios, or null when none was saved. Another user's scenario: 404. */
export async function getScenarioResult(actor: Actor, id: string): Promise<ScenarioResultRow | null> {
  const sid = parseId(id);
  const { scenarioResult } = schema;
  const owned = await findOwnedOrNull(actor, sid);
  assertCan(actor, "read", "scenario_result", owned);
  const [row] = await db().select().from(scenarioResult).where(ownedBy(scenarioResult, actor, eq(scenarioResult.scenarioId, sid)));
  return row ?? null;
}

