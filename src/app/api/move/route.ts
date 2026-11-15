import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { allowPublicRequest, clientIp } from "@/lib/ip-limit";
import { moveAdvice } from "@/lib/pricing/data";
import { jsonHasNul } from "@/lib/text";
import { BadRequestError } from "@/lib/errors";

export const dynamic = "force-dynamic";

const KEYS = ["app", "to", "from", "scenario", "rate"] as const;

/**
 * GET /api/move?app=&to=[&from=][&scenario=][&rate=]: break-even and verdict for moving an app to another cloud.
 * Public (60 requests a minute per IP) and priced at the 10x preset; with `scenario` the caller must be signed in
 * and own it (anyone else's id is a 404).
 */
export async function GET(request: Request) {
  try {
    if (!allowPublicRequest(clientIp(request))) return Response.json({ error: "Too many requests" }, { status: 429 });
    const params = new URL(request.url).searchParams;
    const query: Record<string, string> = {};
    for (const key of params.keys()) {
      if (!(KEYS as readonly string[]).includes(key)) throw new BadRequestError(`Unknown parameter: ${key.slice(0, 20)}`);
    }
    for (const key of KEYS) {
      const value = params.get(key);
      if (value !== null) query[key] = value;
    }
    if (jsonHasNul(query)) throw new BadRequestError("Text can't contain null characters");
    const user = query.scenario !== undefined ? await requireUser() : null;
    return Response.json({ result: await moveAdvice(user, query) });
  } catch (err) {
    return errorResponse(err);
  }
}
