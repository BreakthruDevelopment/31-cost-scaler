import type { Cloud, Component, Unit } from "./types";

/**
 * Free-tier allowances, checked in, each with the vendor page that states it. The pricing engine (31.3) shows them as
 * their own negative line, never folded into a list price. Quantities are per month unless `period` says otherwise.
 * `appliesTo` names the price component the allowance offsets; `unit` is the price unit it is measured in.
 *
 * Allowances that only new accounts get for a year (`period: "12_months"`) are marked so; the engine treats them as
 * conditional. Confirm these against each vendor page when the app is next reviewed: vendors change them.
 */
export type FreeTier = {
  cloud: Cloud;
  appliesTo: Component;
  /** The price row key this offsets (see sku-map.ts), or null when the allowance has no price row. */
  skuKey: string | null;
  label: string;
  quantity: number;
  unit: Unit | "instance_hour";
  period: "month" | "12_months" | "always";
  sourceUrl: string;
};

export const FREE_TIERS: readonly FreeTier[] = [
  { cloud: "aws", appliesTo: "serverless", skuKey: "serverless.lambda.requests", label: "Lambda: 1M requests a month", quantity: 1, unit: "million_requests", period: "always", sourceUrl: "https://aws.amazon.com/lambda/pricing/" },
  { cloud: "aws", appliesTo: "serverless", skuKey: "serverless.lambda.gb", label: "Lambda: 400,000 GB-seconds a month (111 GB-hours)", quantity: 111, unit: "gb_hour", period: "always", sourceUrl: "https://aws.amazon.com/lambda/pricing/" },
  { cloud: "aws", appliesTo: "postgres", skuKey: null, label: "RDS: 750 hours of db.t3/t4g micro a month (new accounts)", quantity: 750, unit: "instance_hour", period: "12_months", sourceUrl: "https://aws.amazon.com/rds/free/" },
  { cloud: "aws", appliesTo: "egress", skuKey: "egress.gb", label: "Data transfer out: 100 GB a month", quantity: 100, unit: "gb", period: "always", sourceUrl: "https://aws.amazon.com/ec2/pricing/on-demand/" },
  { cloud: "aws", appliesTo: "identity", skuKey: "identity.mau", label: "Cognito user pools: 10,000 MAU", quantity: 10_000, unit: "mau", period: "always", sourceUrl: "https://aws.amazon.com/cognito/pricing/" },

  { cloud: "azure", appliesTo: "serverless", skuKey: "serverless.vcpu", label: "Container Apps: 180,000 vCPU-seconds a month (50 vCPU-hours)", quantity: 50, unit: "vcpu_hour", period: "always", sourceUrl: "https://azure.microsoft.com/en-us/pricing/details/container-apps/" },
  { cloud: "azure", appliesTo: "serverless", skuKey: "serverless.gb", label: "Container Apps: 360,000 GiB-seconds a month (100 GiB-hours)", quantity: 100, unit: "gb_hour", period: "always", sourceUrl: "https://azure.microsoft.com/en-us/pricing/details/container-apps/" },
  { cloud: "azure", appliesTo: "serverless", skuKey: "serverless.requests", label: "Container Apps: 2M requests a month", quantity: 2, unit: "million_requests", period: "always", sourceUrl: "https://azure.microsoft.com/en-us/pricing/details/container-apps/" },
  { cloud: "azure", appliesTo: "postgres", skuKey: null, label: "Flexible Server: 750 hours of B1ms and 32 GB storage a month (new accounts)", quantity: 750, unit: "instance_hour", period: "12_months", sourceUrl: "https://azure.microsoft.com/en-us/pricing/free-services/" },
  { cloud: "azure", appliesTo: "egress", skuKey: "egress.gb", label: "Bandwidth: 100 GB out a month", quantity: 100, unit: "gb", period: "always", sourceUrl: "https://azure.microsoft.com/en-us/pricing/details/bandwidth/" },
  { cloud: "azure", appliesTo: "identity", skuKey: "identity.mau", label: "Azure AD B2C: 50,000 MAU", quantity: 50_000, unit: "mau", period: "always", sourceUrl: "https://azure.microsoft.com/en-us/pricing/details/active-directory-b2c/" },

  { cloud: "gcp", appliesTo: "serverless", skuKey: "serverless.vcpu", label: "Cloud Run: 180,000 vCPU-seconds a month (50 vCPU-hours)", quantity: 50, unit: "vcpu_hour", period: "always", sourceUrl: "https://cloud.google.com/run/pricing" },
  { cloud: "gcp", appliesTo: "serverless", skuKey: "serverless.gb", label: "Cloud Run: 360,000 GiB-seconds a month (100 GiB-hours)", quantity: 100, unit: "gb_hour", period: "always", sourceUrl: "https://cloud.google.com/run/pricing" },
  { cloud: "gcp", appliesTo: "serverless", skuKey: "serverless.requests", label: "Cloud Run: 2M requests a month", quantity: 2, unit: "million_requests", period: "always", sourceUrl: "https://cloud.google.com/run/pricing" },
  { cloud: "gcp", appliesTo: "vm", skuKey: null, label: "Compute Engine: one e2-micro, 744 hours a month (us-central1)", quantity: 744, unit: "instance_hour", period: "always", sourceUrl: "https://cloud.google.com/free/docs/free-cloud-features#compute" },
  { cloud: "gcp", appliesTo: "object_storage", skuKey: "object_storage.gb", label: "Cloud Storage: 5 GB-months of regional Standard (us-central1)", quantity: 5, unit: "gb_month", period: "always", sourceUrl: "https://cloud.google.com/free/docs/free-cloud-features#storage" },
  { cloud: "gcp", appliesTo: "identity", skuKey: "identity.mau", label: "Identity Platform: 50,000 MAU", quantity: 50_000, unit: "mau", period: "always", sourceUrl: "https://cloud.google.com/identity-platform/pricing" },

  { cloud: "oci", appliesTo: "vm", skuKey: null, label: "Always Free Ampere A1: 3,000 OCPU-hours and 18,000 GB-hours a month (4 OCPU, 24 GB)", quantity: 3000, unit: "instance_hour", period: "always", sourceUrl: "https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm" },
  { cloud: "oci", appliesTo: "object_storage", skuKey: "object_storage.gb", label: "Object Storage: 20 GB (Always Free)", quantity: 20, unit: "gb_month", period: "always", sourceUrl: "https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm" },
  { cloud: "oci", appliesTo: "egress", skuKey: "egress.gb", label: "Outbound data transfer: 10 TB a month", quantity: 10_240, unit: "gb", period: "always", sourceUrl: "https://www.oracle.com/cloud/networking/pricing/" },
  { cloud: "oci", appliesTo: "load_balancer", skuKey: "load_balancer.hour", label: "Flexible Load Balancer: one 10 Mbps balancer (Always Free)", quantity: 744, unit: "hour", period: "always", sourceUrl: "https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm" },
];
