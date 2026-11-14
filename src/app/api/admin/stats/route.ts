import { adminStats } from "@/lib/admin-stats";
import { requireRole } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/stats: counts only (admin). */
export async function GET() {
  try {
    const user = await requireRole("admin");
    return Response.json(await adminStats(user));
  } catch (err) {
    return errorResponse(err);
  }
}
