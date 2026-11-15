"use server";

import { revalidatePath } from "next/cache";
import { type z, ZodError } from "zod";
import { AiError } from "@/lib/ai/types";
import { requireUser } from "@/lib/auth/session";
import { HttpError } from "@/lib/errors";
import { askAdvisor } from "@/lib/advisor";
import type { adviceOutput } from "@/lib/advice-checks";

export type AdviceView = { id: string; output: z.infer<typeof adviceOutput>; demo: boolean; createdAt: string };
export type AskAdviceState = { ok: true; advice: AdviceView } | { ok: false; error: string };

/** The advisor's form action (the page arrives with issue 31.7). Re-reads the session; the data function authorizes again. */
export async function askAdviceAction(input: unknown): Promise<AskAdviceState> {
  try {
    const user = await requireUser();
    const row = await askAdvisor(user, input);
    revalidatePath("/advisor");
    return { ok: true, advice: { id: row.id, output: row.output as AdviceView["output"], demo: row.demo, createdAt: row.createdAt.toISOString() } };
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, error: err.issues[0]?.message ?? "Invalid input" };
    if (err instanceof HttpError || err instanceof AiError) return { ok: false, error: err.message };
    throw err;
  }
}
