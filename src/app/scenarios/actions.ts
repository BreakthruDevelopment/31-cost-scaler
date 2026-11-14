"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireUser } from "@/lib/auth/session";
import { HttpError } from "@/lib/errors";
import { type ScenarioRow, createScenario, deleteScenario, updateScenario } from "@/lib/scenarios";

export type ScenarioActionState = { ok: true; scenario?: ScenarioRow } | { ok: false; error: string };

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
    revalidatePath("/scenarios");
    return { ok: true, scenario };
  } catch (err) {
    return failure(err);
  }
}

export async function deleteScenarioAction(id: string): Promise<ScenarioActionState> {
  try {
    const user = await requireUser();
    await deleteScenario(user, id);
    revalidatePath("/scenarios");
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}
