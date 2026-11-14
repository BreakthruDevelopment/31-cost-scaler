import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { deleteScenario, getScenario, getScenarioResult, updateScenario } from "@/lib/scenarios";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/scenarios/:id: one of the caller's scenarios with its latest saved result (or null). Anyone else's id is a 404. */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const scenario = await getScenario(user, id);
    return Response.json({ scenario, result: await getScenarioResult(user, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/scenarios/:id: body { version, name?, spec? }. A stale version is a 409. */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ scenario: await updateScenario(user, id, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/scenarios/:id */
export async function DELETE(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { id } = await ctx.params;
    await deleteScenario(user, id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
