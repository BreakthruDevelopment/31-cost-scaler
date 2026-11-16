import { formatUsd } from "@/lib/pricing/money";
import { CLOUD_LABEL, type Cloud } from "@/lib/pricing/types";
import type { OutgrowsFreeTier } from "@/lib/pricing/footprint";
import type { Verdict } from "@/lib/pricing/move";
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
  if (o.status === "free_through_max") return "Still free at 10,000,000 users";
  if (o.status === "already_paying") return "Already past it: a shared part has no allowance";
  return `${o.mau.toLocaleString("en-US")} users a month (${requestsPerUser} requests each)`;
}

export const VERDICT: Record<Verdict, { status: Status; label: string; text: string }> = {
  move: { status: "live", label: "Move", text: "Pays back within 6 months and saves at least $10 a month." },
  consider: { status: "building", label: "Consider", text: "Pays back within 18 months." },
  stay: { status: "not-started", label: "Stay", text: "The saving does not cover the effort within 18 months." },
  blocked: { status: "blocked", label: "Blocked", text: "Something this app uses cannot run there." },
  not_enough_data: { status: "not-started", label: "Not enough data", text: "A price this comparison needs is not listed." },
};

export function formatDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "never";
}

export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}
