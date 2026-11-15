import type { Cloud, Component, PriceRow, PriceUnit } from "../../src/lib/pricing/types";

/**
 * A small, SYNTHETIC price table in the normalized shape (micro-dollars per unit) for the pricing engine's tests and
 * (CI's smoke test seeds the ingestion fixtures with `pnpm seed:prices` instead). The numbers are round, plausible list prices, not real quotes.
 * It follows the real table's keys and gaps: Azure has no HA rate, Fargate and Container Instances no per-request
 * price, Google Cloud bills the load balancer per GB, and Oracle lists no database and no identity price.
 */
type Spec = [cloud: Cloud, component: Component, skuKey: string, unit: PriceUnit, micros: number, tierStart?: number];

const SPECS: Spec[] = [
  // AWS
  ["aws", "vm", "vm.2vcpu-8gb", "hour", 96_000],
  ["aws", "vm", "vm.4vcpu-16gb", "hour", 192_000],
  ["aws", "serverless", "serverless.vcpu", "vcpu_hour", 40_480],
  ["aws", "serverless", "serverless.gb", "gb_hour", 4_445],
  ["aws", "serverless", "serverless.lambda.gb", "gb_hour", 60_000],
  ["aws", "serverless", "serverless.lambda.gb.arm64", "gb_hour", 48_000],
  ["aws", "serverless", "serverless.lambda.requests", "million_requests", 200_000],
  ["aws", "postgres", "postgres.2vcpu-1gb", "hour", 16_000],
  ["aws", "postgres", "postgres.2vcpu-8gb", "hour", 178_000],
  ["aws", "postgres", "postgres.4vcpu-16gb", "hour", 356_000],
  ["aws", "postgres", "postgres.2vcpu-8gb.ha", "hour", 356_000],
  ["aws", "postgres", "postgres.4vcpu-16gb.ha", "hour", 712_000],
  ["aws", "postgres", "postgres.storage", "gb_month", 115_000],
  ["aws", "postgres", "postgres.storage.ha", "gb_month", 230_000],
  ["aws", "object_storage", "object_storage.gb", "gb_month", 23_000],
  ["aws", "egress", "egress.gb", "gb", 90_000, 0],
  ["aws", "egress", "egress.gb", "gb", 85_000, 10_240],
  ["aws", "identity", "identity.mau", "mau", 5_500, 10_000],
  ["aws", "identity", "identity.mau", "mau", 4_600, 100_000],
  ["aws", "load_balancer", "load_balancer.hour", "hour", 22_500],
  ["aws", "load_balancer", "load_balancer.capacity", "hour", 8_000],
  // Azure
  ["azure", "vm", "vm.2vcpu-8gb", "hour", 96_000],
  ["azure", "vm", "vm.4vcpu-16gb", "hour", 192_000],
  ["azure", "serverless", "serverless.vcpu", "vcpu_hour", 86_400],
  ["azure", "serverless", "serverless.gb", "gb_hour", 10_800],
  ["azure", "serverless", "serverless.requests", "million_requests", 400_000],
  ["azure", "postgres", "postgres.1vcpu-2gb", "hour", 25_000],
  ["azure", "postgres", "postgres.2vcpu-8gb", "hour", 180_000],
  ["azure", "postgres", "postgres.4vcpu-16gb", "hour", 360_000],
  ["azure", "postgres", "postgres.storage", "gb_month", 115_000],
  ["azure", "object_storage", "object_storage.gb", "gb_month", 18_000],
  ["azure", "egress", "egress.gb", "gb", 87_000],
  ["azure", "identity", "identity.mau", "mau", 3_250, 50_000],
  ["azure", "load_balancer", "load_balancer.hour", "hour", 25_000],
  ["azure", "load_balancer", "load_balancer.capacity", "hour", 7_200],
  // Google Cloud
  ["gcp", "vm", "vm.2vcpu-1gb", "hour", 8_000],
  ["gcp", "vm", "vm.2vcpu-8gb", "hour", 67_000],
  ["gcp", "vm", "vm.4vcpu-16gb", "hour", 134_000],
  ["gcp", "serverless", "serverless.vcpu", "vcpu_hour", 86_400],
  ["gcp", "serverless", "serverless.gb", "gb_hour", 9_000],
  ["gcp", "serverless", "serverless.requests", "million_requests", 400_000],
  ["gcp", "postgres", "postgres.2vcpu-8gb", "hour", 117_000],
  ["gcp", "postgres", "postgres.4vcpu-16gb", "hour", 234_000],
  ["gcp", "postgres", "postgres.2vcpu-8gb.ha", "hour", 234_000],
  ["gcp", "postgres", "postgres.4vcpu-16gb.ha", "hour", 468_000],
  ["gcp", "postgres", "postgres.storage", "gb_month", 170_000],
  ["gcp", "postgres", "postgres.storage.ha", "gb_month", 340_000],
  ["gcp", "object_storage", "object_storage.gb", "gb_month", 20_000],
  ["gcp", "egress", "egress.gb", "gb", 120_000],
  ["gcp", "identity", "identity.mau", "mau", 15_000, 50_000],
  ["gcp", "load_balancer", "load_balancer.hour", "hour", 25_000],
  ["gcp", "load_balancer", "load_balancer.data", "gb", 8_000],
  // Oracle (no database, no identity, no per-request price)
  ["oci", "vm", "vm.a1.ocpu", "vcpu_hour", 10_000],
  ["oci", "vm", "vm.a1.gb", "gb_hour", 1_000],
  ["oci", "vm", "vm.2vcpu-8gb", "hour", 55_000],
  ["oci", "vm", "vm.4vcpu-16gb", "hour", 110_000],
  ["oci", "serverless", "serverless.vcpu", "vcpu_hour", 12_500],
  ["oci", "serverless", "serverless.gb", "gb_hour", 1_500],
  ["oci", "object_storage", "object_storage.gb", "gb_month", 25_500],
  ["oci", "egress", "egress.gb", "gb", 8_500, 10_240],
  ["oci", "load_balancer", "load_balancer.hour", "hour", 12_000],
];

export const FIXTURE_FETCHED_AT = new Date("2026-11-14T03:00:00.000Z");

/** Rows without ids (the database assigns them when the smoke seed inserts these). */
export function fixturePriceRows(): Omit<PriceRow, "id">[] {
  return SPECS.map(([cloud, component, skuKey, unit, usdMicros, tierStart = 0]) => ({
    cloud,
    component,
    skuKey,
    unit,
    usdMicros,
    tierStart,
    tierEnd: null,
    sourceUrl: `https://example.test/fixture/${cloud}`,
    fetchedAt: FIXTURE_FETCHED_AT,
  }));
}

/** Rows with stable ids (`cloud:skuKey:tierStart`) for unit tests. */
export function fixtureRowsWithIds(): PriceRow[] {
  return fixturePriceRows().map((r) => ({ ...r, id: `${r.cloud}:${r.skuKey}:${r.tierStart}` }));
}
