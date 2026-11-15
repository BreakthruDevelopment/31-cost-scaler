import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time compare of an `Authorization: Bearer ...` header with the configured token: both sides are hashed first, so length never leaks and the compare is fixed width. No token configured means no bearer access. */
export function bearerMatches(header: string | null, token: string | undefined): boolean {
  if (!token || !header) return false;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  return timingSafeEqual(createHash("sha256").update(m[1]).digest(), createHash("sha256").update(token).digest());
}
