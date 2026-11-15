import type { Pico } from "./money";

export type Cloud = "aws" | "azure" | "gcp" | "oci";
export type Component = "vm" | "serverless" | "postgres" | "object_storage" | "egress" | "identity" | "load_balancer";
export type Unit = "hour" | "vcpu_hour" | "gb_hour" | "gb_month" | "gb" | "mau" | "million_requests" | "vcpu_second" | "gib_second";
export type PriceSourceId = "aws_ec2" | "aws_other" | "azure" | "gcp" | "oci";

/** One vendor price row, parsed but not yet mapped: the price per VENDOR unit, as exact pico-dollars. */
export type RawPrice = {
  cloud: Cloud;
  /** The fetch group it came from (AWS service code, Azure serviceName, Google service name, "oci"). */
  group: string;
  vendorSku: string;
  description: string;
  vendorUnit: string;
  pico: Pico;
  tierStart: number;
  tierEnd: number | null;
  /** Vendor attributes the sku-map matches on (lower-cased keys for AWS, vendor names for the others). */
  attrs: Record<string, string>;
  sourceUrl: string;
  sourceVersion: string | null;
};

export type NormalizedRow = {
  cloud: Cloud;
  component: Component;
  skuKey: string;
  region: string;
  unit: Unit;
  usdMicros: number;
  tierStart: number;
  tierEnd: number | null;
  vendorSku: string | null;
  description: string;
  sourceUrl: string;
  sourceVersion: string | null;
};

export type NotListed = { cloud: Cloud; component: Component; skuKey: string; reason: string };

export const REGIONS: Record<Cloud, string> = { aws: "us-east-2", azure: "eastus", gcp: "us-central1", oci: "global" };
