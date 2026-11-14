import type { CLOUDS, COMPONENTS, PRICE_UNITS } from "@/lib/db/schema";

export type Cloud = (typeof CLOUDS)[number];
export type Component = (typeof COMPONENTS)[number];
export type PriceUnit = (typeof PRICE_UNITS)[number];

export const CLOUD_ORDER: readonly Cloud[] = ["aws", "azure", "gcp", "oci"];
export const CLOUD_LABEL: Record<Cloud, string> = { aws: "AWS", azure: "Azure", gcp: "Google Cloud", oci: "Oracle Cloud" };

/**
 * One normalized price, as `price_point` stores it (31.2 writes them, 31.1 defined the table). The engine reads only
 * this shape, so tests feed it a fixture table and the app feeds it the active rows.
 */
export type PriceRow = {
  id: string;
  cloud: Cloud;
  component: Component;
  skuKey: string;
  unit: PriceUnit;
  /** Integer micro-dollars per `unit`. */
  usdMicros: number | bigint;
  /** Tier floor (0 when untiered). */
  tierStart: number;
  tierEnd: number | null;
  sourceUrl: string;
  fetchedAt: Date | string;
};

export interface PriceTable {
  /** Every row for one sku key on one cloud, ordered by `tierStart`. Empty when the key is not listed. */
  rows(cloud: Cloud, skuKey: string): readonly PriceRow[];
  /** Every sku key listed on a cloud, sorted. */
  skuKeys(cloud: Cloud): readonly string[];
}

export type LineComponent =
  | "compute"
  | "containers"
  | "database"
  | "read_replicas"
  | "object_storage"
  | "egress"
  | "inter_region_transfer"
  | "identity"
  | "load_balancer"
  | "shared";

export type Snap = { requested: string; listed: string; skuKey: string };

/** One priced line. `micros` is null (never 0) when a price is not listed: the line is excluded from totals. */
export type PriceLine = {
  id: string;
  component: LineComponent;
  label: string;
  /** The arithmetic in words, e.g. "2 x 730 h at the 2 vCPU / 8 GB size". */
  detail: string;
  status: "priced" | "not_listed";
  micros: number | null;
  /** The `price_point` ids this line used. */
  priceIds: string[];
  notes: string[];
  snap: Snap | null;
};

export type CreditLine = {
  id: string;
  label: string;
  /** Negative micros. */
  micros: number;
  /** A new-account allowance that expires (12 months): only applied when asked for. */
  conditional: boolean;
  sourceUrl: string;
  priceIds: string[];
};

export type CloudPrice = {
  cloud: Cloud;
  label: string;
  lines: PriceLine[];
  creditLines: CreditLine[];
  /** List price: the sum of the priced lines. */
  totalMicros: number;
  /** Sum of the credit lines (zero or negative). */
  creditMicros: number;
  /** totalMicros + creditMicros. */
  netMicros: number;
  /** False when any line is not listed: the total is then missing a part and is not comparable. */
  complete: boolean;
  unlistedCount: number;
  notes: string[];
};
