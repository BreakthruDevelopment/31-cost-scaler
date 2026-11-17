import { CLOUD_LABEL, type Cloud } from "@/lib/pricing/types";
import type { COMPONENTS, PRICE_UNITS } from "@/lib/db/schema";

/** Display helpers for the normalized price table. Integer arithmetic only: a unit price is never a float. */

export type ComponentId = (typeof COMPONENTS)[number];
export type UnitId = (typeof PRICE_UNITS)[number];

export const cloudLabel = (c: Cloud) => CLOUD_LABEL[c];

export const COMPONENT_LABEL: Record<ComponentId, string> = {
  vm: "Virtual machine",
  serverless: "Serverless compute",
  postgres: "Postgres",
  object_storage: "Object storage",
  egress: "Egress",
  identity: "Identity",
  load_balancer: "Load balancer",
};

/** What one unit of this price buys, in words a reader can check against the source page. */
export const UNIT_LABEL: Record<UnitId, string> = {
  hour: "per hour",
  vcpu_hour: "per vCPU-hour",
  gb_hour: "per GB-hour",
  gb_month: "per GB-month",
  gb: "per GB",
  mau: "per monthly active user",
  million_requests: "per million requests",
  vcpu_second: "per vCPU-second",
  gib_second: "per GiB-second",
};

/**
 * A unit price in dollars. Unlike a monthly total, a unit price is often far below a cent (a vCPU-second costs
 * about $0.000024), so rounding to cents would print "$0.00" for every serverless row. Shows every micro-dollar
 * that is there, at least two decimals, and never touches a float.
 */
export function formatUnitUsd(micros: number | bigint): string {
  const v = typeof micros === "bigint" ? micros : BigInt(Math.trunc(micros));
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = (abs / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}$${whole}.${frac}`;
}

/** "0 – 10,240" or "10,240 and above" for a tiered price; null when the price has no tiers. */
export function tierRange(tierStart: number, tierEnd: number | null): string | null {
  if (tierStart === 0 && tierEnd === null) return null;
  const n = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return tierEnd === null ? `${n(tierStart)} and above` : `${n(tierStart)} – ${n(tierEnd)}`;
}

/** The date part of a timestamp, for "fetched" columns. */
export function fetchedOn(at: Date | string | null): string {
  if (!at) return "never";
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 10);
}

/** A source link is only rendered for an https URL; anything else gets plain text. */
export function safeSourceHref(url: string): string | null {
  if (!/^https:\/\//i.test(url)) return null;
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}
