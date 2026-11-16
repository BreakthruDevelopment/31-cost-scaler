import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { listAdvice } from "@/lib/advice-store";
import { askAdvisor } from "@/lib/advisor";

export const dynamic = "force-dynamic";
// A team question is bounded at 90 s in code (src/lib/ai/agent.ts). Documentation only: Cloud Run's standalone server ignores
// `maxDuration`; the real outer bound is the service's request timeout (300 s).
export const maxDuration = 120;

/**
 * POST /api/advice: body { question, app?, scenarioId? }. Runs the scaling advisor and returns the stored answer.
 * Signed-in users only, same-origin, 16 KB body, 4 questions per user per hour and 12 per day; someone else's scenario id is a 404.
 * With `clientOpId` a retry returns the first answer (200, not 201) and is not charged.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { advice, created } = await askAdvisor(user, await readJson(request));
    return Response.json({ advice }, { status: created ? 201 : 200 });
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
