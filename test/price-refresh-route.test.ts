/**
 * POST /api/prices/refresh: who gets in. The refresh itself is mocked (it has its own integration tests); this
 * pins the credential rules: bearer is bearer-only, wrong is 401 even with an admin session, admin needs same origin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SYSTEM } from "@/lib/access";

const TOKEN = "route-test-refresh-token-0123456789";
let current: { id: string; role: "user" | "admin" } | null = null;
const run = vi.fn(async () => ({ ran: false, reason: "nothing_stale" }));

vi.mock("@/lib/auth/session", async () => {
  const { ForbiddenError, UnauthorizedError } = await import("@/lib/auth/rbac");
  return {
    requireRole: async (role: string) => {
      if (!current) throw new UnauthorizedError();
      if (role === "admin" && current.role !== "admin") throw new ForbiddenError();
      return current;
    },
  };
});
vi.mock("@/lib/price-ingest/refresh", () => ({ REFRESH_SOURCES: ["aws_ec2", "aws_other", "azure", "gcp", "oci", "footprint"], runPriceRefresh: run }));

const ORIGIN = "http://localhost:3000";
const req = (headers: Record<string, string> = {}, body?: string) =>
  new Request(`${ORIGIN}/api/prices/refresh`, { method: "POST", headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body });

describe("POST /api/prices/refresh", () => {
  let post: (r: Request) => Promise<Response>;
  beforeEach(async () => {
    process.env.DATABASE_URL ??= "postgres://x:x@127.0.0.1:1/x";
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.COST_SCALER_REFRESH_TOKEN = TOKEN;
    (await import("@/lib/env")).resetEnvCache();
    post = (await import("@/app/api/prices/refresh/route")).POST;
    current = null;
    run.mockClear();
  });

  it("the right bearer token runs the scheduler path", async () => {
    expect((await post(req({ authorization: `Bearer ${TOKEN}` }))).status).toBe(200);
    expect(run).toHaveBeenCalledWith(SYSTEM, "scheduler");
  });
  it("a wrong, empty or non-bearer token is 401, even with an admin session", async () => {
    current = { id: "a", role: "admin" };
    for (const authorization of ["Bearer nope", "Bearer ", "", TOKEN, `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
      expect((await post(req({ authorization, origin: ORIGIN }))).status, authorization).toBe(401);
    }
    expect(run).not.toHaveBeenCalled();
  });
  it("no credentials is 401; a plain user is 403", async () => {
    expect((await post(req({ origin: ORIGIN }))).status).toBe(401);
    current = { id: "u", role: "user" };
    expect((await post(req({ origin: ORIGIN }))).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });
  it("an unset server token never matches anything", async () => {
    delete process.env.COST_SCALER_REFRESH_TOKEN;
    (await import("@/lib/env")).resetEnvCache();
    expect((await post(req({ authorization: "Bearer undefined" }))).status).toBe(401);
    expect((await post(req({ authorization: "Bearer " }))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it("an admin must be same-origin; then may name a source", async () => {
    current = { id: "a", role: "admin" };
    expect((await post(req({ origin: "https://evil.example" }))).status).toBe(403);
    expect((await post(req({}))).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
    expect((await post(req({ origin: ORIGIN }, JSON.stringify({ source: "oci" })))).status).toBe(200);
    expect(run).toHaveBeenCalledWith(current, "admin", { source: "oci" });
  });
  it("a bad source, extra fields or malformed JSON is 400", async () => {
    current = { id: "a", role: "admin" };
    for (const body of [JSON.stringify({ source: "mars" }), JSON.stringify({ source: "oci", x: 1 }), "{not json"]) {
      expect((await post(req({ origin: ORIGIN }, body))).status, body).toBe(400);
    }
    expect(run).not.toHaveBeenCalled();
  });
});
