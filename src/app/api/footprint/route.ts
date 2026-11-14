import { errorResponse } from "@/lib/http";
import { allowPublicRequest, clientIp } from "@/lib/ip-limit";
import { listFootprint } from "@/lib/footprint/refresh";

export const dynamic = "force-dynamic";

/** GET /api/footprint: the portfolio's current footprint (public data; 60 requests a minute per IP). */
export async function GET(request: Request) {
  try {
    if (!allowPublicRequest(clientIp(request))) return Response.json({ error: "Too many requests" }, { status: 429 });
    return Response.json({ apps: await listFootprint() });
  } catch (err) {
    return errorResponse(err);
  }
}
