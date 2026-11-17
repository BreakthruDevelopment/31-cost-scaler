"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { AiError } from "@/lib/ai/types";
import { requireUser } from "@/lib/auth/session";
import { HttpError } from "@/lib/errors";
import { askAdvisor } from "@/lib/advisor";
import { type AdviceView, toAdviceView } from "@/lib/advice-view";

export type { AdviceView };
export type AskAdviceState = { ok: true; advice: AdviceView } | { ok: false; error: string };

/**
 * The advisor's form action. Re-reads the session; the data function authorizes again.
 *
 * Idempotent: the page keeps one `clientOpId` per question with `opFor` (src/lib/client-op.ts) in a ref until the
 * server answers, and `askAdvisor` returns the first answer for a repeated id (unique index on owner + op id), so a
 * double tap or a retry after a lost response never runs the model twice or stores a second row.
 */
export async function askAdviceAction(input: unknown): Promise<AskAdviceState> {
  try {
    const user = await requireUser();
    const { advice: row } = await askAdvisor(user, input);
    revalidatePath("/advisor");
    return { ok: true, advice: toAdviceView(row) };
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, error: err.issues[0]?.message ?? "Invalid input" };
    if (err instanceof HttpError || err instanceof AiError) return { ok: false, error: err.message };
    throw err;
  }
}
