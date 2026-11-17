import { formatUsd } from "@/lib/pricing/money";
import { CLOUD_LABEL, type Cloud } from "@/lib/pricing/types";
import { MAX_MAU, type OutgrowsFreeTier } from "@/lib/pricing/footprint";
import { type Verdict } from "@/lib/pricing/move";
import type { Status } from "@/components/ui";

export const cloudName = (c: Cloud) => CLOUD_LABEL[c];

/** Dollars for display. A positive amount under a cent says so instead of showing a misleading "$0.00". */
export function usd(micros: number): string {
  if (micros === 0) return "$0.00";
  if (Math.abs(micros) < 5000) return micros < 0 ? "-<$0.01" : "<$0.01";
  return formatUsd(micros);
}

export const perMonth = (micros: number) => `${usd(micros)}/mo`;

export function outgrowsText(o: OutgrowsFreeTier | null, requestsPerUser: number): string {
  if (!o) return "Not available";
  if (o.status === "free_through_max") return `Still free at ${MAX_MAU.toLocaleString("en-US")} users`;
  if (o.status === "already_paying") return "Already past it: a shared part has no allowance";
  return `${o.mau.toLocaleString("en-US")} users a month (${requestsPerUser} requests each)`;
}

/**
 * The badge for a verdict. Only the badge: the prose explaining *why* comes from the engine's `reasons`, which are
 * built from its own thresholds. Nothing here restates a number the engine owns, so the two cannot drift.
 */
export const VERDICT: Record<Verdict, { status: Status; label: string }> = {
  move: { status: "live", label: "Move" },
  consider: { status: "building", label: "Consider" },
  stay: { status: "not-started", label: "Stay" },
  blocked: { status: "blocked", label: "Blocked" },
  not_enough_data: { status: "not-started", label: "Not enough data" },
};

export function formatDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "never";
}

/** The longest raw source value shown when it has no hostname; enough to recognise, short enough not to break a card. */
export const SOURCE_LABEL_MAX = 60;

/**
 * A label for a source link. Never empty: a URL with no hostname (`javascript:`, `data:`, a bare path) has nothing
 * to show as a host, so the raw value is shown instead, trimmed and capped. React escapes it, and `safeHref` has
 * already decided whether it may be a link — this only decides what the reader sees.
 */
export function sourceHost(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host) return host;
  } catch {
    // Not a URL at all: fall through to the raw text.
  }
  const raw = url.trim();
  if (!raw) return "source";
  return raw.length > SOURCE_LABEL_MAX ? `${raw.slice(0, SOURCE_LABEL_MAX - 1)}…` : raw;
}
