import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { createScenario, listScenarios } from "@/lib/scenarios";

export const dynamic = "force-dynamic";

/** GET /api/scenarios: the caller's own scenarios (admins get their own too, never anyone else's). */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ scenarios: await listScenarios(user) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/scenarios: body { name, spec, clientOpId? }. 201 for a new scenario, 200 when the same
 * clientOpId was already used (the replay returns the first row).
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { scenario, created } = await createScenario(user, await readJson(request));
    return Response.json({ scenario }, { status: created ? 201 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
