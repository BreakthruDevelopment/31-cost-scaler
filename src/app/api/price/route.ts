import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { priceSpec } from "@/lib/pricing/data";

export const dynamic = "force-dynamic";

/**
 * POST /api/price: body { spec, conditionalCredits? }. Prices an unsaved scenario spec on all four clouds (the
 * builder's preview). Signed-in users only, same-origin, 16 KB body, 120 runs per user per hour.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return Response.json({ result: await priceSpec(user, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}
