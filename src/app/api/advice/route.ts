import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { listAdvice } from "@/lib/advice-store";
import { askAdvisor } from "@/lib/advisor";

export const dynamic = "force-dynamic";
// The advisor answers within 18 s or falls back; this leaves room to store the answer (Lambda's limit is 29 s).
export const maxDuration = 25;

/**
 * POST /api/advice: body { question, app?, scenarioId? }. Runs the scaling advisor and returns the stored answer.
 * Signed-in users only, same-origin, 16 KB body, 10 questions per user per hour; someone else's scenario id is a 404.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return Response.json({ advice: await askAdvisor(user, await readJson(request)) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** GET /api/advice: the caller's own saved answers, newest first (at most 50). */
export async function GET() {
  try {
    return Response.json({ advice: await listAdvice(await requireUser()) });
  } catch (err) {
    return errorResponse(err);
  }
}
