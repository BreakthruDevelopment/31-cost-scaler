/**
 * What one app costs to run on each cloud today, as sizes (not prices): the reference footprint the pricing engine
 * prices. Values were read from the 30-apps-infra stacks at commit 5e5ad6a; every row links to its line. The refresh
 * re-fetches `stacks/<cloud>/main.tf` from `main` and checks each value with the regex beside it; a mismatch shows as
 * "profile drift" on /admin, so the numbers here can't quietly go stale.
 */
export const INFRA_REPO = "https://github.com/BreakthruDevelopment/30-apps-infra";
export const STACK_PROFILES_COMMIT = "5e5ad6a";

export type CloudId = "aws" | "azure" | "gcp" | "oci";

export type ProfileCheck = {
  /** Stable id shown on /admin. */
  key: string;
  label: string;
  /** What the profile says, as the text the regex captures. */
  expected: string;
  /** One capture group; matched per line. */
  pattern: RegExp;
  /** Permalink to the line at STACK_PROFILES_COMMIT. */
  source: string;
};

export type StackProfile = {
  cloud: CloudId;
  /** The path in the infra repo. */
  file: string;
  /** How one app runs. */
  app: { runtime: string; vcpu: number | null; memoryGb: number; arch?: string; cpuOnlyDuringRequests?: boolean };
  /** The database or host that every app on this cloud shares (split evenly across them by the pricing engine). */
  shared: { label: string; vcpu?: number; memoryGb?: number; storageGb: number; instance: string };
  checks: ProfileCheck[];
};

const link = (cloud: CloudId, line: number) => `${INFRA_REPO}/blob/${STACK_PROFILES_COMMIT}/stacks/${cloud}/main.tf#L${line}`;

export const STACK_PROFILES: Record<CloudId, StackProfile> = {
  aws: {
    cloud: "aws",
    file: "stacks/aws/main.tf",
    app: { runtime: "Lambda (arm64)", vcpu: null, memoryGb: 1, arch: "arm64" },
    shared: { label: "Shared RDS Postgres", storageGb: 20, instance: "db.t4g.micro" },
    checks: [
      { key: "aws.lambda.arch", label: "Lambda architecture", expected: "arm64", pattern: /^\s*architectures\s*=\s*\["([A-Za-z0-9_]+)"\]/m, source: link("aws", 302) },
      { key: "aws.lambda.memory_mb", label: "Lambda memory (MB)", expected: "1024", pattern: /^\s*memory_size\s*=\s*(\d+)/m, source: link("aws", 303) },
      { key: "aws.rds.instance_class", label: "RDS instance class", expected: "db.t4g.micro", pattern: /^\s*instance_class\s*=\s*"([A-Za-z0-9._-]+)"/m, source: link("aws", 107) },
      { key: "aws.rds.storage_gb", label: "RDS storage (GB)", expected: "20", pattern: /^\s*allocated_storage\s*=\s*(\d+)/m, source: link("aws", 108) },
    ],
  },
  azure: {
    cloud: "azure",
    file: "stacks/azure/main.tf",
    app: { runtime: "Container Apps", vcpu: 0.25, memoryGb: 0.5 },
    shared: { label: "Shared Flexible Server Postgres", storageGb: 32, instance: "B_Standard_B1ms" },
    checks: [
      { key: "azure.app.cpu", label: "Container App vCPU", expected: "0.25", pattern: /^\s*cpu\s*=\s*([0-9.]+)\s*$/m, source: link("azure", 349) },
      { key: "azure.app.memory", label: "Container App memory", expected: "0.5Gi", pattern: /^\s*memory\s*=\s*"([0-9.]+Gi)"/m, source: link("azure", 350) },
      { key: "azure.pg.sku", label: "Flexible Server SKU", expected: "B_Standard_B1ms", pattern: /^\s*sku_name\s*=\s*"([A-Za-z0-9_]+)"/m, source: link("azure", 80) },
      { key: "azure.pg.storage_mb", label: "Flexible Server storage (MB)", expected: "32768", pattern: /^\s*storage_mb\s*=\s*(\d+)/m, source: link("azure", 81) },
    ],
  },
  gcp: {
    cloud: "gcp",
    file: "stacks/gcp/main.tf",
    app: { runtime: "Cloud Run", vcpu: 1, memoryGb: 0.5, cpuOnlyDuringRequests: true },
    shared: { label: "Shared Postgres on the e2-micro VM", storageGb: 0, instance: "e2-micro" },
    checks: [
      { key: "gcp.run.cpu", label: "Cloud Run vCPU", expected: "1", pattern: /^\s*cpu\s*=\s*"([0-9.]+)"/m, source: link("gcp", 313) },
      { key: "gcp.run.memory", label: "Cloud Run memory", expected: "512Mi", pattern: /^\s*memory\s*=\s*"([0-9.]+[MG]i)"/m, source: link("gcp", 314) },
      { key: "gcp.vm.machine_type", label: "Postgres VM machine type", expected: "e2-micro", pattern: /^\s*machine_type\s*=\s*"([a-z0-9-]+)"/m, source: link("gcp", 120) },
    ],
  },
  oci: {
    cloud: "oci",
    file: "stacks/oci/main.tf",
    app: { runtime: "Shared A1 VM (Docker)", vcpu: null, memoryGb: 0 },
    shared: { label: "Shared A1 VM (apps and Postgres)", vcpu: 2, memoryGb: 12, storageGb: 100, instance: "VM.Standard.A1.Flex" },
    checks: [
      { key: "oci.vm.shape", label: "VM shape", expected: "VM.Standard.A1.Flex", pattern: /^\s*shape\s*=\s*"([A-Za-z0-9.]+)"/m, source: link("oci", 176) },
      { key: "oci.vm.ocpus", label: "VM OCPUs", expected: "2", pattern: /^\s*ocpus\s*=\s*(\d+)/m, source: link("oci", 181) },
      { key: "oci.vm.memory_gb", label: "VM memory (GB)", expected: "12", pattern: /^\s*memory_in_gbs\s*=\s*(\d+)/m, source: link("oci", 182) },
      { key: "oci.vm.boot_volume_gb", label: "Boot volume (GB)", expected: "100", pattern: /^\s*boot_volume_size_in_gbs\s*=\s*(\d+)/m, source: link("oci", 188) },
    ],
  },
};

export type DriftMismatch = { key: string; expected: string; actual: string | null };
export type DriftReport = {
  /** Per cloud: did we read its file. An unreadable file is not drift, just unchecked. */
  files: Record<CloudId, "checked" | "unavailable">;
  mismatches: DriftMismatch[];
};

/** Compare every profile value with the text of its stack file. `files` maps a cloud to the file text, or null when it couldn't be fetched. */
export function checkProfileDrift(files: Record<CloudId, string | null>): DriftReport {
  const report: DriftReport = { files: { aws: "unavailable", azure: "unavailable", gcp: "unavailable", oci: "unavailable" }, mismatches: [] };
  for (const profile of Object.values(STACK_PROFILES)) {
    const body = files[profile.cloud];
    if (body === null) continue;
    report.files[profile.cloud] = "checked";
    for (const check of profile.checks) {
      const actual = check.pattern.exec(body)?.[1] ?? null;
      if (actual !== check.expected) report.mismatches.push({ key: check.key, expected: check.expected, actual });
    }
  }
  return report;
}
