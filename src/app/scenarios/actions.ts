"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireUser } from "@/lib/auth/session";
import { HttpError, NotFoundError } from "@/lib/errors";
import { priceSpec } from "@/lib/pricing/data";
import type { ScenarioPrice } from "@/lib/pricing/scenario";
import { storeScenarioResult } from "@/lib/scenario-view";
import { copyName } from "@/lib/scenario-draft";
import { type ScenarioRow, createScenario, deleteScenario, getScenario, updateScenario } from "@/lib/scenarios";

export type ScenarioActionState = { ok: true; scenario?: ScenarioRow } | { ok: false; error: string };
export type PriceActionState = { ok: true; result: ScenarioPrice } | { ok: false; error: string };

// Server actions are public endpoints: each one re-reads the session itself, and the data functions authorize again.
// Known failures come back as a message (a stale version, a cap, a bad field); anything else is thrown, so
// the client shows its generic error and the server logs it.
function failure(err: unknown): ScenarioActionState {
  if (err instanceof ZodError) return { ok: false, error: err.issues[0]?.message ?? "Invalid input" };
  if (err instanceof HttpError) return { ok: false, error: err.message };
  throw err;
}

export async function createScenarioAction(input: unknown): Promise<ScenarioActionState> {
  try {
    const user = await requireUser();
    const { scenario } = await createScenario(user, input);
    await storeScenarioResult(user, scenario);
    revalidatePath("/scenarios");
    return { ok: true, scenario };
  } catch (err) {
    return failure(err);
  }
}

export async function updateScenarioAction(id: string, input: unknown): Promise<ScenarioActionState> {
  try {
    const user = await requireUser();
    const scenario = await updateScenario(user, id, input);
    await storeScenarioResult(user, scenario);
    revalidatePath("/scenarios");
    return { ok: true, scenario };
  } catch (err) {
    return failure(err);
  }
}

/**
 * Copy one of the caller's scenarios. Idempotent per `clientOpId`, like any other create: a double tap or a retry
 * after a lost answer returns the first copy instead of making a second one.
 */
export async function duplicateScenarioAction(id: string, clientOpId: string): Promise<ScenarioActionState> {
  try {
    const user = await requireUser();
    const source = await getScenario(user, id);
    const { scenario } = await createScenario(user, { name: copyName(source.name), spec: source.spec, clientOpId });
    await storeScenarioResult(user, scenario);
    revalidatePath("/scenarios");
    return { ok: true, scenario };
  } catch (err) {
    return failure(err);
  }
}

/**
 * Deleting a scenario that is already gone is the outcome the user asked for, so a replayed delete (a double tap, a
 * retry after a lost answer) answers ok instead of an error. It tells a caller nothing: an id that was never theirs
 * gets the same ok, exactly as `DELETE /api/scenarios/:id` gives every stranger the same 404.
 */
export async function deleteScenarioAction(id: string): Promise<ScenarioActionState> {
  try {
    const user = await requireUser();
    await deleteScenario(user, id);
    revalidatePath("/scenarios");
    return { ok: true };
  } catch (err) {
    if (err instanceof NotFoundError) {
      revalidatePath("/scenarios");
      return { ok: true };
    }
    return failure(err);
  }
}

/**
 * Price an unsaved spec on all four clouds for the builder's preview. Same data function as `POST /api/price`:
 * signed in, zod-validated, and charged against the per-user pricing limit (120 an hour), so holding the button
 * down costs a 429 rather than a loop.
 */
export async function priceScenarioAction(input: unknown): Promise<PriceActionState> {
  try {
    const user = await requireUser();
    return { ok: true, result: await priceSpec(user, input) };
  } catch (err) {
    const state = failure(err);
    return state.ok ? { ok: false, error: "Could not price this scenario." } : state;
  }
}
