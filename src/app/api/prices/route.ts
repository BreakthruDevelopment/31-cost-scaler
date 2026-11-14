import { errorResponse } from "@/lib/http";
import { allowPublicRequest, clientIp } from "@/lib/ip-limit";
import { listPricePoints } from "@/lib/prices";

export const dynamic = "force-dynamic";

/** GET /api/prices?cloud=&component=: the normalized price table, active rows only (public; 60 requests a minute per IP). */
export async function GET(request: Request) {
  try {
    if (!allowPublicRequest(clientIp(request))) return Response.json({ error: "Too many requests" }, { status: 429 });
    const url = new URL(request.url);
    const prices = await listPricePoints({
      cloud: url.searchParams.get("cloud") ?? undefined,
      component: url.searchParams.get("component") ?? undefined,
    });
    return Response.json({ prices });
  } catch (err) {
    return errorResponse(err);
  }
}
