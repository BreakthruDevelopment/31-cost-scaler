import { z } from "zod";
import { SYSTEM } from "@/lib/access";
import { UnauthorizedError } from "@/lib/auth/rbac";
import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { env } from "@/lib/env";
import { errorResponse, readJson } from "@/lib/http";
import { REFRESH_SOURCES, runPriceRefresh } from "@/lib/price-ingest/refresh";
import { bearerMatches } from "@/lib/price-ingest/token";

export const dynamic = "force-dynamic";
// One slow source per call; Cloud Run's request timeout for this app is 300 s (issue 31.8).
export const maxDuration = 300;

const body = z.object({ source: z.enum(REFRESH_SOURCES).optional() }).strict();

/**
 * POST /api/prices/refresh: refresh ONE price source (the stalest older than 20 h, footprint included).
 *  - Scheduler: `Authorization: Bearer <COST_SCALER_REFRESH_TOKEN>`.
 *  - Admin ("Refresh now"): signed in as admin, same-origin, once per 10 minutes; may name a `source`.
 * Anything else is 401 (not signed in) or 403.
 */
export async function POST(request: Request) {
  try {
    const authorization = request.headers.get("authorization");
    if (authorization !== null) {
      // A bearer attempt never falls back to cookies: a wrong token is a 401, full stop.
      if (!bearerMatches(authorization, env().COST_SCALER_REFRESH_TOKEN)) throw new UnauthorizedError();
      return Response.json(await runPriceRefresh(SYSTEM, "scheduler"));
    }
    const admin = await requireRole("admin"); // 401 signed out, 403 for a plain user
    requireSameOrigin(request);
    // The body is optional ({ "source": "oci" } to pick one); when there is one it must be valid JSON.
    const raw = request.headers.get("content-type")?.includes("json") ? await readJson(request) : {};
    const { source } = body.parse(raw);
    return Response.json(await runPriceRefresh(admin, "admin", { source }));
  } catch (err) {
    return errorResponse(err);
  }
}
