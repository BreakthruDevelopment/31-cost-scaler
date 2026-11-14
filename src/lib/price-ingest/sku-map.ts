import type { Cloud, Component, PriceSourceId, RawPrice, Unit } from "./types";

/**
 * The checked-in map from each vendor's price list to the app's normalized rows: one reference size set per
 * cloud, read at the reference region (AWS us-east-2, Azure eastus, Google us-central1, Oracle global).
 *
 * Rules:
 *  - A `direct` rule finds vendor rows with `match`, scales the vendor unit to ours (`mul`/`div`) and picks a tier
 *    (`lowest` tier, or `first_paid`: the first tier whose price is above zero, as the free allowance is a
 *    separate line in `free-tiers.ts`). If matching rows disagree on the price, the rule is ambiguous and yields
 *    NO row.
 *  - A `sum` rule builds a row from other rows (an instance is cores x core price + GB x RAM price; a per-vCPU
 *    rate is an instance price / vCPUs).
 *  - An `absent` rule says the list has no comparable price, with the reason. A source with no matching SKU
 *    leaves the row absent ("not listed"), never zero.
 *
 * Serverless compute is stored per vCPU-HOUR and GB-HOUR on every cloud (the vendors' per-second prices times
 * 3600): a per-second price such as $0.0000025 would lose most of its digits as integer micro-dollars.
 * The engine divides by 3600.
 *
 * STATUS: written from the vendors' documented formats. The recorded fixtures are synthetic (see
 * test/fixtures/README.md); issue 31.9's first live refresh is where each matcher is confirmed against a real
 * response, and a matcher that finds nothing simply shows "not listed".
 */
export type Tier = "lowest" | "first_paid";

export type DirectRule = {
  kind: "direct";
  cloud: Cloud;
  component: Component;
  key: string;
  unit: Unit;
  group: string;
  description: string;
  match: (r: RawPrice) => boolean;
  mul?: bigint;
  div?: bigint;
  tier?: Tier;
};
export type SumRule = {
  kind: "sum";
  cloud: Cloud;
  component: Component;
  key: string;
  unit: Unit;
  /** Fetch groups that must have been read for this row to be judged. */
  groups: string[];
  description: string;
  parts: { key: string; mul: bigint; div?: bigint }[];
};
export type AbsentRule = { kind: "absent"; cloud: Cloud; component: Component; key: string; reason: string };
export type Rule = DirectRule | SumRule | AbsentRule;

/** The fetch groups of each refresh source. A group is one request (or one paged query). */
export const SOURCE_GROUPS: Record<PriceSourceId, readonly string[]> = {
  aws_ec2: ["AmazonEC2"],
  aws_other: ["AmazonRDS", "AWSLambda", "AmazonECS", "AmazonS3", "AmazonCognito", "AWSELB", "AWSDataTransfer"],
  azure: ["Virtual Machines", "Azure Container Apps", "Azure Database for PostgreSQL", "Storage", "Bandwidth", "Azure Active Directory B2C", "Application Gateway"],
  gcp: ["Compute Engine", "Cloud Run", "Cloud SQL", "Cloud Storage", "Networking", "Identity Platform"],
  oci: ["oci"],
};

export const SOURCE_CLOUD: Record<PriceSourceId, Cloud> = { aws_ec2: "aws", aws_other: "aws", azure: "azure", gcp: "gcp", oci: "oci" };

/** The two reference sizes every cloud is priced at. */
export const REFERENCE_SIZES = [
  { id: "2vcpu-8gb", vcpu: 2n, gb: 8n },
  { id: "4vcpu-16gb", vcpu: 4n, gb: 16n },
] as const;

/** Every key that must exist on every cloud, as a row or as an explicit `absent` rule. A test enforces it. */
export const REQUIRED_KEYS: Record<Component, readonly string[]> = {
  vm: ["vm.2vcpu-8gb", "vm.4vcpu-16gb", "vm.vcpu", "vm.gb"],
  serverless: ["serverless.vcpu", "serverless.gb", "serverless.requests"],
  postgres: ["postgres.2vcpu-8gb", "postgres.4vcpu-16gb", "postgres.2vcpu-8gb.ha", "postgres.4vcpu-16gb.ha", "postgres.storage", "postgres.storage.ha"],
  object_storage: ["object_storage.gb"],
  egress: ["egress.gb"],
  identity: ["identity.mau"],
  load_balancer: ["load_balancer.hour", "load_balancer.data", "load_balancer.capacity"],
};

const a = (r: RawPrice) => r.attrs;
const eq = (r: RawPrice, field: string, value: string) => a(r)[field] === value;
const per = { second: { mul: 3600n }, million: { mul: 1_000_000n } } as const;

// ---------------------------------------------------------------------------------------------------------------
// AWS (us-east-2)
// ---------------------------------------------------------------------------------------------------------------
const AWS_LOC = "US East (Ohio)";
const ec2 = (instance: string) => (r: RawPrice) =>
  eq(r, "instancetype", instance) && eq(r, "operatingsystem", "Linux") && eq(r, "tenancy", "Shared") && eq(r, "preinstalledsw", "NA") &&
  eq(r, "licensemodel", "No License required") && eq(r, "capacitystatus", "Used") && eq(r, "location", AWS_LOC) && eq(r, "operation", "RunInstances") && r.vendorUnit === "Hrs";
const rds = (instance: string, az: "Single-AZ" | "Multi-AZ") => (r: RawPrice) =>
  eq(r, "productfamily", "Database Instance") && eq(r, "databaseengine", "PostgreSQL") && eq(r, "instancetype", instance) && eq(r, "deploymentoption", az) && eq(r, "location", AWS_LOC) && r.vendorUnit === "Hrs";
const rdsStorage = (az: "Single-AZ" | "Multi-AZ") => (r: RawPrice) =>
  eq(r, "productfamily", "Database Storage") && eq(r, "databaseengine", "PostgreSQL") && eq(r, "volumetype", "General Purpose-GP3") && eq(r, "deploymentoption", az) && eq(r, "location", AWS_LOC) && r.vendorUnit === "GB-Mo";

const aws: Rule[] = [
  { kind: "direct", cloud: "aws", component: "vm", key: "vm.2vcpu-8gb", unit: "hour", group: "AmazonEC2", description: "EC2 m6i.large, Linux, on-demand, shared tenancy", match: ec2("m6i.large") },
  { kind: "direct", cloud: "aws", component: "vm", key: "vm.4vcpu-16gb", unit: "hour", group: "AmazonEC2", description: "EC2 m6i.xlarge, Linux, on-demand, shared tenancy", match: ec2("m6i.xlarge") },
  { kind: "sum", cloud: "aws", component: "vm", key: "vm.vcpu", unit: "vcpu_hour", groups: ["AmazonEC2"], description: "Derived: m6i.xlarge price / 4 vCPUs (not additive with vm.gb)", parts: [{ key: "vm.4vcpu-16gb", mul: 1n, div: 4n }] },
  { kind: "sum", cloud: "aws", component: "vm", key: "vm.gb", unit: "gb_hour", groups: ["AmazonEC2"], description: "Derived: m6i.xlarge price / 16 GB (not additive with vm.vcpu)", parts: [{ key: "vm.4vcpu-16gb", mul: 1n, div: 16n }] },

  { kind: "direct", cloud: "aws", component: "serverless", key: "serverless.vcpu", unit: "vcpu_hour", group: "AmazonECS", description: "Fargate Linux/x86 vCPU-hour", match: (r) => /Fargate-vCPU-Hours:perCPU$/.test(a(r).usagetype) && !/ARM|Windows/.test(a(r).usagetype) },
  { kind: "direct", cloud: "aws", component: "serverless", key: "serverless.gb", unit: "gb_hour", group: "AmazonECS", description: "Fargate Linux/x86 GB-hour", match: (r) => /Fargate-GB-Hours$/.test(a(r).usagetype) && !/ARM|Windows/.test(a(r).usagetype) },
  { kind: "absent", cloud: "aws", component: "serverless", key: "serverless.requests", reason: "Fargate has no per-request price (Lambda's is serverless.lambda.requests)" },
  { kind: "direct", cloud: "aws", component: "serverless", key: "serverless.lambda.gb", unit: "gb_hour", group: "AWSLambda", description: "Lambda x86 duration, per GB-hour (list price is per GB-second)", ...per.second, match: (r) => eq(r, "group", "AWS-Lambda-Duration") && r.vendorUnit === "Lambda-GB-Second" },
  { kind: "direct", cloud: "aws", component: "serverless", key: "serverless.lambda.requests", unit: "million_requests", group: "AWSLambda", description: "Lambda requests, per million", ...per.million, match: (r) => eq(r, "group", "AWS-Lambda-Requests") && r.vendorUnit === "Request" },

  { kind: "direct", cloud: "aws", component: "postgres", key: "postgres.2vcpu-8gb", unit: "hour", group: "AmazonRDS", description: "RDS PostgreSQL db.m6g.large, Single-AZ", match: rds("db.m6g.large", "Single-AZ") },
  { kind: "direct", cloud: "aws", component: "postgres", key: "postgres.4vcpu-16gb", unit: "hour", group: "AmazonRDS", description: "RDS PostgreSQL db.m6g.xlarge, Single-AZ", match: rds("db.m6g.xlarge", "Single-AZ") },
  { kind: "direct", cloud: "aws", component: "postgres", key: "postgres.2vcpu-8gb.ha", unit: "hour", group: "AmazonRDS", description: "RDS PostgreSQL db.m6g.large, Multi-AZ", match: rds("db.m6g.large", "Multi-AZ") },
  { kind: "direct", cloud: "aws", component: "postgres", key: "postgres.4vcpu-16gb.ha", unit: "hour", group: "AmazonRDS", description: "RDS PostgreSQL db.m6g.xlarge, Multi-AZ", match: rds("db.m6g.xlarge", "Multi-AZ") },
  { kind: "direct", cloud: "aws", component: "postgres", key: "postgres.storage", unit: "gb_month", group: "AmazonRDS", description: "RDS gp3 storage, Single-AZ", match: rdsStorage("Single-AZ") },
  { kind: "direct", cloud: "aws", component: "postgres", key: "postgres.storage.ha", unit: "gb_month", group: "AmazonRDS", description: "RDS gp3 storage, Multi-AZ", match: rdsStorage("Multi-AZ") },

  { kind: "direct", cloud: "aws", component: "object_storage", key: "object_storage.gb", unit: "gb_month", group: "AmazonS3", description: "S3 Standard, first tier", match: (r) => /TimedStorage-ByteHrs$/.test(a(r).usagetype) && eq(r, "volumetype", "Standard") && eq(r, "location", AWS_LOC) && r.vendorUnit === "GB-Mo" },
  { kind: "direct", cloud: "aws", component: "egress", key: "egress.gb", unit: "gb", group: "AWSDataTransfer", description: "Data transfer out to the internet, first paid tier", tier: "first_paid", match: (r) => eq(r, "transfertype", "AWS Outbound") && eq(r, "fromlocation", AWS_LOC) && r.vendorUnit === "GB" },
  { kind: "direct", cloud: "aws", component: "identity", key: "identity.mau", unit: "mau", group: "AmazonCognito", description: "Cognito user pools, first paid MAU tier", tier: "first_paid", match: (r) => /CognitoUserPools.*MAU|-MAU/.test(a(r).usagetype) && r.vendorUnit === "MAU" },
  { kind: "direct", cloud: "aws", component: "load_balancer", key: "load_balancer.hour", unit: "hour", group: "AWSELB", description: "Application Load Balancer hour", match: (r) => /LoadBalancerUsage$/.test(a(r).usagetype) && eq(r, "productfamily", "Load Balancer-Application") && r.vendorUnit === "Hrs" },
  { kind: "direct", cloud: "aws", component: "load_balancer", key: "load_balancer.capacity", unit: "hour", group: "AWSELB", description: "Application Load Balancer LCU-hour", match: (r) => /LCUUsage$/.test(a(r).usagetype) && eq(r, "productfamily", "Load Balancer-Application") && r.vendorUnit === "LCU-Hrs" },
  { kind: "absent", cloud: "aws", component: "load_balancer", key: "load_balancer.data", reason: "Billed in LCU-hours (load_balancer.capacity), not per GB" },
];

// ---------------------------------------------------------------------------------------------------------------
// Azure (eastus)
// ---------------------------------------------------------------------------------------------------------------
const az = (service: string, fields: Record<string, string | RegExp>) => (r: RawPrice) =>
  a(r).serviceName === service && Object.entries(fields).every(([k, v]) => (typeof v === "string" ? a(r)[k] === v : v.test(a(r)[k] ?? "")));
const azVm = (arm: string) => az("Virtual Machines", { armSkuName: arm, productName: "Virtual Machines DSv5 Series", skuName: /^(?!.*(Spot|Low Priority))/, unitOfMeasure: "1 Hour" });
const PG_COMPUTE = "Azure Database for PostgreSQL Flexible Server General Purpose Ddsv5 Series Compute";

const azure: Rule[] = [
  { kind: "direct", cloud: "azure", component: "vm", key: "vm.2vcpu-8gb", unit: "hour", group: "Virtual Machines", description: "Standard_D2s_v5, Linux, pay-as-you-go", match: azVm("Standard_D2s_v5") },
  { kind: "direct", cloud: "azure", component: "vm", key: "vm.4vcpu-16gb", unit: "hour", group: "Virtual Machines", description: "Standard_D4s_v5, Linux, pay-as-you-go", match: azVm("Standard_D4s_v5") },
  { kind: "sum", cloud: "azure", component: "vm", key: "vm.vcpu", unit: "vcpu_hour", groups: ["Virtual Machines"], description: "Derived: D4s_v5 price / 4 vCPUs (not additive with vm.gb)", parts: [{ key: "vm.4vcpu-16gb", mul: 1n, div: 4n }] },
  { kind: "sum", cloud: "azure", component: "vm", key: "vm.gb", unit: "gb_hour", groups: ["Virtual Machines"], description: "Derived: D4s_v5 price / 16 GB (not additive with vm.vcpu)", parts: [{ key: "vm.4vcpu-16gb", mul: 1n, div: 16n }] },

  { kind: "direct", cloud: "azure", component: "serverless", key: "serverless.vcpu", unit: "vcpu_hour", group: "Azure Container Apps", description: "Container Apps consumption vCPU, per hour (list price is per second)", ...per.second, match: az("Azure Container Apps", { meterName: "Standard vCPU Duration", unitOfMeasure: "1 Second" }) },
  { kind: "direct", cloud: "azure", component: "serverless", key: "serverless.gb", unit: "gb_hour", group: "Azure Container Apps", description: "Container Apps consumption memory, per GiB-hour (list price is per second)", ...per.second, match: az("Azure Container Apps", { meterName: "Standard Memory Duration", unitOfMeasure: "1 Second" }) },
  { kind: "direct", cloud: "azure", component: "serverless", key: "serverless.requests", unit: "million_requests", group: "Azure Container Apps", description: "Container Apps requests, per million", match: az("Azure Container Apps", { meterName: "Standard Requests", unitOfMeasure: "1M" }) },

  { kind: "direct", cloud: "azure", component: "postgres", key: "postgres.vcpu", unit: "vcpu_hour", group: "Azure Database for PostgreSQL", description: "Flexible Server General Purpose D-series, per vCore-hour (4 GB per vCore included)", match: az("Azure Database for PostgreSQL", { productName: PG_COMPUTE, meterName: "vCore", unitOfMeasure: "1 Hour" }) },
  { kind: "sum", cloud: "azure", component: "postgres", key: "postgres.2vcpu-8gb", unit: "hour", groups: ["Azure Database for PostgreSQL"], description: "Derived: 2 vCores", parts: [{ key: "postgres.vcpu", mul: 2n }] },
  { kind: "sum", cloud: "azure", component: "postgres", key: "postgres.4vcpu-16gb", unit: "hour", groups: ["Azure Database for PostgreSQL"], description: "Derived: 4 vCores", parts: [{ key: "postgres.vcpu", mul: 4n }] },
  { kind: "absent", cloud: "azure", component: "postgres", key: "postgres.2vcpu-8gb.ha", reason: "No separate HA rate used; the engine applies 2x the instance price" },
  { kind: "absent", cloud: "azure", component: "postgres", key: "postgres.4vcpu-16gb.ha", reason: "No separate HA rate used; the engine applies 2x the instance price" },
  { kind: "direct", cloud: "azure", component: "postgres", key: "postgres.storage", unit: "gb_month", group: "Azure Database for PostgreSQL", description: "Flexible Server storage", match: az("Azure Database for PostgreSQL", { productName: "Azure Database for PostgreSQL Flexible Server Storage", meterName: "Storage Data Stored", unitOfMeasure: "1 GB/Month" }) },
  { kind: "absent", cloud: "azure", component: "postgres", key: "postgres.storage.ha", reason: "No separate HA storage rate used; the engine applies 2x" },

  { kind: "direct", cloud: "azure", component: "object_storage", key: "object_storage.gb", unit: "gb_month", group: "Storage", description: "Blob Storage, general purpose v2, Hot LRS, first tier", match: az("Storage", { productName: "General Block Blob v2", meterName: "Hot LRS Data Stored", unitOfMeasure: "1 GB/Month" }) },
  { kind: "direct", cloud: "azure", component: "egress", key: "egress.gb", unit: "gb", group: "Bandwidth", description: "Internet data transfer out, first paid tier", tier: "first_paid", match: az("Bandwidth", { meterName: "Standard Data Transfer Out", unitOfMeasure: "1 GB" }) },
  { kind: "direct", cloud: "azure", component: "identity", key: "identity.mau", unit: "mau", group: "Azure Active Directory B2C", description: "Azure AD B2C, first paid MAU tier", tier: "first_paid", match: az("Azure Active Directory B2C", { meterName: "Monthly Active Users", unitOfMeasure: "1" }) },
  { kind: "direct", cloud: "azure", component: "load_balancer", key: "load_balancer.hour", unit: "hour", group: "Application Gateway", description: "Application Gateway Standard v2 fixed cost, per hour", match: az("Application Gateway", { productName: "Application Gateway Standard v2", meterName: "Standard Fixed Cost", unitOfMeasure: "1 Hour" }) },
  { kind: "direct", cloud: "azure", component: "load_balancer", key: "load_balancer.capacity", unit: "hour", group: "Application Gateway", description: "Application Gateway Standard v2 capacity unit, per hour", match: az("Application Gateway", { productName: "Application Gateway Standard v2", meterName: "Standard Capacity Units", unitOfMeasure: "1 Hour" }) },
  { kind: "absent", cloud: "azure", component: "load_balancer", key: "load_balancer.data", reason: "Billed in capacity units (load_balancer.capacity), not per GB" },
];

// ---------------------------------------------------------------------------------------------------------------
// Google Cloud (us-central1; the Billing Catalog already lists us-central1 SKUs under "Americas" or "Iowa")
// ---------------------------------------------------------------------------------------------------------------
const gc = (service: string, description: RegExp, usage = "OnDemand") => (r: RawPrice) =>
  a(r).serviceDisplayName === service && description.test(a(r).description) && a(r).usageType === usage;

const gcp: Rule[] = [
  { kind: "direct", cloud: "gcp", component: "vm", key: "vm.vcpu", unit: "vcpu_hour", group: "Compute Engine", description: "Compute Engine E2 core, on-demand", match: gc("Compute Engine", /^E2 Instance Core running in Americas$/) },
  { kind: "direct", cloud: "gcp", component: "vm", key: "vm.gb", unit: "gb_hour", group: "Compute Engine", description: "Compute Engine E2 RAM, on-demand", match: gc("Compute Engine", /^E2 Instance Ram running in Americas$/) },
  { kind: "sum", cloud: "gcp", component: "vm", key: "vm.2vcpu-8gb", unit: "hour", groups: ["Compute Engine"], description: "Derived: e2-standard-2 = 2 cores + 8 GB RAM", parts: [{ key: "vm.vcpu", mul: 2n }, { key: "vm.gb", mul: 8n }] },
  { kind: "sum", cloud: "gcp", component: "vm", key: "vm.4vcpu-16gb", unit: "hour", groups: ["Compute Engine"], description: "Derived: e2-standard-4 = 4 cores + 16 GB RAM", parts: [{ key: "vm.vcpu", mul: 4n }, { key: "vm.gb", mul: 16n }] },

  { kind: "direct", cloud: "gcp", component: "serverless", key: "serverless.vcpu", unit: "vcpu_hour", group: "Cloud Run", description: "Cloud Run CPU, request-based billing, per hour (list price is per second)", ...per.second, match: gc("Cloud Run", /^Services CPU \(Request-based billing\) in us-central1$|^CPU Allocation Time \(requests?-based\)/i) },
  { kind: "direct", cloud: "gcp", component: "serverless", key: "serverless.gb", unit: "gb_hour", group: "Cloud Run", description: "Cloud Run memory, request-based billing, per GiB-hour (list price is per second)", ...per.second, match: gc("Cloud Run", /^Services Memory \(Request-based billing\) in us-central1$|^Memory Allocation Time \(requests?-based\)/i) },
  { kind: "direct", cloud: "gcp", component: "serverless", key: "serverless.requests", unit: "million_requests", group: "Cloud Run", description: "Cloud Run requests, per million", ...per.million, match: gc("Cloud Run", /^Services Requests$|^Requests$/) },

  { kind: "direct", cloud: "gcp", component: "postgres", key: "postgres.vcpu", unit: "vcpu_hour", group: "Cloud SQL", description: "Cloud SQL for PostgreSQL zonal vCPU", match: gc("Cloud SQL", /^Cloud SQL for PostgreSQL: Zonal - vCPU in Iowa$/) },
  { kind: "direct", cloud: "gcp", component: "postgres", key: "postgres.gb", unit: "gb_hour", group: "Cloud SQL", description: "Cloud SQL for PostgreSQL zonal RAM", match: gc("Cloud SQL", /^Cloud SQL for PostgreSQL: Zonal - RAM in Iowa$/) },
  { kind: "direct", cloud: "gcp", component: "postgres", key: "postgres.vcpu.ha", unit: "vcpu_hour", group: "Cloud SQL", description: "Cloud SQL for PostgreSQL regional (HA) vCPU", match: gc("Cloud SQL", /^Cloud SQL for PostgreSQL: Regional - vCPU in Iowa$/) },
  { kind: "direct", cloud: "gcp", component: "postgres", key: "postgres.gb.ha", unit: "gb_hour", group: "Cloud SQL", description: "Cloud SQL for PostgreSQL regional (HA) RAM", match: gc("Cloud SQL", /^Cloud SQL for PostgreSQL: Regional - RAM in Iowa$/) },
  { kind: "sum", cloud: "gcp", component: "postgres", key: "postgres.2vcpu-8gb", unit: "hour", groups: ["Cloud SQL"], description: "Derived: 2 vCPU + 8 GB RAM", parts: [{ key: "postgres.vcpu", mul: 2n }, { key: "postgres.gb", mul: 8n }] },
  { kind: "sum", cloud: "gcp", component: "postgres", key: "postgres.4vcpu-16gb", unit: "hour", groups: ["Cloud SQL"], description: "Derived: 4 vCPU + 16 GB RAM", parts: [{ key: "postgres.vcpu", mul: 4n }, { key: "postgres.gb", mul: 16n }] },
  { kind: "sum", cloud: "gcp", component: "postgres", key: "postgres.2vcpu-8gb.ha", unit: "hour", groups: ["Cloud SQL"], description: "Derived: regional 2 vCPU + 8 GB RAM", parts: [{ key: "postgres.vcpu.ha", mul: 2n }, { key: "postgres.gb.ha", mul: 8n }] },
  { kind: "sum", cloud: "gcp", component: "postgres", key: "postgres.4vcpu-16gb.ha", unit: "hour", groups: ["Cloud SQL"], description: "Derived: regional 4 vCPU + 16 GB RAM", parts: [{ key: "postgres.vcpu.ha", mul: 4n }, { key: "postgres.gb.ha", mul: 16n }] },
  { kind: "direct", cloud: "gcp", component: "postgres", key: "postgres.storage", unit: "gb_month", group: "Cloud SQL", description: "Cloud SQL for PostgreSQL zonal SSD storage", match: gc("Cloud SQL", /^Cloud SQL for PostgreSQL: Zonal - SSD storage in Iowa$/) },
  { kind: "direct", cloud: "gcp", component: "postgres", key: "postgres.storage.ha", unit: "gb_month", group: "Cloud SQL", description: "Cloud SQL for PostgreSQL regional SSD storage", match: gc("Cloud SQL", /^Cloud SQL for PostgreSQL: Regional - SSD storage in Iowa$/) },

  { kind: "direct", cloud: "gcp", component: "object_storage", key: "object_storage.gb", unit: "gb_month", group: "Cloud Storage", description: "Cloud Storage Standard, regional (Iowa)", match: gc("Cloud Storage", /^Standard Storage Iowa$/) },
  { kind: "direct", cloud: "gcp", component: "egress", key: "egress.gb", unit: "gb", group: "Networking", description: "Premium tier internet egress from the Americas, first paid tier", tier: "first_paid", match: gc("Networking", /^Network Internet Egress from Americas to Americas$/) },
  { kind: "direct", cloud: "gcp", component: "identity", key: "identity.mau", unit: "mau", group: "Identity Platform", description: "Identity Platform, first paid MAU tier", tier: "first_paid", match: gc("Identity Platform", /Monthly Active Users/i) },
  { kind: "direct", cloud: "gcp", component: "load_balancer", key: "load_balancer.hour", unit: "hour", group: "Networking", description: "Load balancing forwarding rule, per hour", match: gc("Networking", /^Network Load Balancing: Forwarding Rule Minimum Service Charge in Americas$/) },
  { kind: "direct", cloud: "gcp", component: "load_balancer", key: "load_balancer.data", unit: "gb", group: "Networking", description: "Load balancing data processed, per GB", match: gc("Networking", /^Network Load Balancing: Data Processing Charge in Americas$/) },
  { kind: "absent", cloud: "gcp", component: "load_balancer", key: "load_balancer.capacity", reason: "Billed per forwarding rule and per GB, not in capacity units" },
];

// ---------------------------------------------------------------------------------------------------------------
// Oracle (prices are global; matched by part number)
// ---------------------------------------------------------------------------------------------------------------
const oci_ = (part: string) => (r: RawPrice) => a(r).partNumber === part;
const OCI_NO_PG = "Oracle's list for OCI Database with PostgreSQL could not be matched to part numbers without a live response (confirmed in 31.9)";

const oci: Rule[] = [
  { kind: "direct", cloud: "oci", component: "vm", key: "vm.vcpu", unit: "vcpu_hour", group: "oci", description: "Flex E4 OCPU per hour / 2 (one OCPU is two vCPUs); B93113", div: 2n, match: oci_("B93113") },
  { kind: "direct", cloud: "oci", component: "vm", key: "vm.gb", unit: "gb_hour", group: "oci", description: "Flex E4 memory per GB-hour; B93114", match: oci_("B93114") },
  { kind: "sum", cloud: "oci", component: "vm", key: "vm.2vcpu-8gb", unit: "hour", groups: ["oci"], description: "Derived: 2 vCPUs + 8 GB", parts: [{ key: "vm.vcpu", mul: 2n }, { key: "vm.gb", mul: 8n }] },
  { kind: "sum", cloud: "oci", component: "vm", key: "vm.4vcpu-16gb", unit: "hour", groups: ["oci"], description: "Derived: 4 vCPUs + 16 GB", parts: [{ key: "vm.vcpu", mul: 4n }, { key: "vm.gb", mul: 16n }] },

  { kind: "sum", cloud: "oci", component: "serverless", key: "serverless.vcpu", unit: "vcpu_hour", groups: ["oci"], description: "Container Instances are billed at the flex-shape vCPU rate (B93113 / 2)", parts: [{ key: "vm.vcpu", mul: 1n }] },
  { kind: "sum", cloud: "oci", component: "serverless", key: "serverless.gb", unit: "gb_hour", groups: ["oci"], description: "Container Instances are billed at the flex-shape memory rate (B93114)", parts: [{ key: "vm.gb", mul: 1n }] },
  { kind: "absent", cloud: "oci", component: "serverless", key: "serverless.requests", reason: "Container Instances have no per-request price" },

  ...(["postgres.2vcpu-8gb", "postgres.4vcpu-16gb", "postgres.2vcpu-8gb.ha", "postgres.4vcpu-16gb.ha", "postgres.storage", "postgres.storage.ha"] as const).map(
    (key): Rule => ({ kind: "absent", cloud: "oci", component: "postgres", key, reason: OCI_NO_PG }),
  ),
  { kind: "direct", cloud: "oci", component: "object_storage", key: "object_storage.gb", unit: "gb_month", group: "oci", description: "Object Storage Standard, per GB-month; B91628", match: oci_("B91628") },
  { kind: "direct", cloud: "oci", component: "egress", key: "egress.gb", unit: "gb", group: "oci", description: "Outbound data transfer, first paid tier (the first 10 TB a month are free); B88327", tier: "first_paid", match: oci_("B88327") },
  { kind: "absent", cloud: "oci", component: "identity", key: "identity.mau", reason: "No public per-MAU list price in the price list API" },
  { kind: "direct", cloud: "oci", component: "load_balancer", key: "load_balancer.hour", unit: "hour", group: "oci", description: "Flexible Load Balancer, per hour; B93030", match: oci_("B93030") },
  { kind: "absent", cloud: "oci", component: "load_balancer", key: "load_balancer.data", reason: "Billed per Mbps-hour, not per GB" },
  { kind: "absent", cloud: "oci", component: "load_balancer", key: "load_balancer.capacity", reason: "Billed per Mbps-hour; no comparable capacity unit" },
];

export const RULES: readonly Rule[] = [...aws, ...azure, ...gcp, ...oci];

/** The part numbers the Oracle parser keeps (every `oci_("...")` above). */
export const OCI_PART_NUMBERS: ReadonlySet<string> = new Set(["B93113", "B93114", "B91628", "B88327", "B93030"]);

/** Substrings an AWS CSV line must contain to be parsed at all, per service file. */
export const AWS_NEEDLES: Record<string, readonly string[]> = {
  AmazonEC2: ["m6i.large", "m6i.xlarge"],
  AmazonRDS: ["db.m6g.large", "db.m6g.xlarge", "Database Storage"],
  AWSLambda: ["AWS-Lambda-Duration", "AWS-Lambda-Requests"],
  AmazonECS: ["Fargate-vCPU-Hours", "Fargate-GB-Hours"],
  AmazonS3: ["TimedStorage-ByteHrs"],
  AmazonCognito: ["MAU"],
  AWSELB: ["LoadBalancerUsage", "LCUUsage"],
  AWSDataTransfer: ["AWS Outbound"],
};
