import { z } from "zod";

/**
 * The scenario spec: what a user chooses to price. Pure data and bounds, no pricing math (that is `src/lib/pricing`
 * from issue 31.3, which reuses this schema). Every number is bounded; unknown keys are rejected. There is no
 * free text except `baseApp`, which must look like a footprint app name, so a spec can't carry a NUL byte or a prompt.
 * Sizes snap up to the nearest listed size per cloud in the engine, and the result says so.
 */
export const REDUNDANCY = ["single", "multi_az", "multi_region"] as const;
export type Redundancy = (typeof REDUNDANCY)[number];

const redundancy = z.enum(REDUNDANCY).default("single");

const vcpu = z.number().min(0.25).max(32);
const memoryGb = z.number().min(0.5).max(128);
const mau = z.number().int().min(0).max(10_000_000);

/** Same name rule as `apps.yaml` (`name`: short, lowercase, hyphens). */
export const footprintName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Must be an app name such as helpdesk");

const sizeFields = { vcpu, memoryGb, busyFraction: z.number().min(0).max(1) };

export const scenarioSpec = z
  .object({
    baseApp: footprintName.optional(),
    users: z.strictObject({ mau, requestsPerUser: z.number().int().min(1).max(10_000) }),
    compute: z.strictObject({ kind: z.enum(["vm", "serverless"]), instances: z.number().int().min(1).max(50), ...sizeFields }),
    containers: z.strictObject({ count: z.number().int().min(0).max(50), ...sizeFields }),
    database: z.strictObject({ vcpu, memoryGb, storageGb: z.number().min(1).max(10_000), readReplicas: z.number().int().min(0).max(5) }),
    storage: z.strictObject({ objectGb: z.number().min(0).max(100_000), egressGb: z.number().min(0).max(100_000) }),
    identity: z.strictObject({ mau }),
    loadBalancers: z.number().int().min(0).max(5),
    redundancy: z
      .strictObject({
        compute: redundancy,
        containers: redundancy,
        database: redundancy,
        storage: redundancy,
        identity: redundancy,
        loadBalancers: redundancy,
      })
      .default({ compute: "single", containers: "single", database: "single", storage: "single", identity: "single", loadBalancers: "single" }),
  })
  .strict();

export type ScenarioSpec = z.infer<typeof scenarioSpec>;

/** A small starting point; the demo seed and tests build on it. */
export const BASE_SPEC: ScenarioSpec = {
  users: { mau: 500, requestsPerUser: 200 },
  compute: { kind: "serverless", instances: 1, vcpu: 1, memoryGb: 0.5, busyFraction: 0.1 },
  containers: { count: 0, vcpu: 0.25, memoryGb: 0.5, busyFraction: 0.1 },
  database: { vcpu: 1, memoryGb: 1, storageGb: 20, readReplicas: 0 },
  storage: { objectGb: 10, egressGb: 20 },
  identity: { mau: 500 },
  loadBalancers: 0,
  redundancy: { compute: "single", containers: "single", database: "single", storage: "single", identity: "single", loadBalancers: "single" },
};
