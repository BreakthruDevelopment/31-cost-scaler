import { describe, expect, it } from "vitest";
import { BASE_SPEC, scenarioSpec } from "@/lib/pricing/spec";

const spec = (patch: Record<string, unknown> = {}) => ({ ...BASE_SPEC, ...patch });

describe("scenario spec", () => {
  it("accepts the base spec and fills redundancy with single", () => {
    const { redundancy: _omit, ...rest } = BASE_SPEC;
    void _omit;
    const parsed = scenarioSpec.parse(rest);
    expect(parsed.redundancy.database).toBe("single");
    expect(scenarioSpec.parse(BASE_SPEC)).toEqual(BASE_SPEC);
  });

  it.each([
    ["users.mau above 10M", spec({ users: { mau: 10_000_001, requestsPerUser: 1 } })],
    ["requestsPerUser below 1", spec({ users: { mau: 1, requestsPerUser: 0 } })],
    ["requestsPerUser above 10k", spec({ users: { mau: 1, requestsPerUser: 10_001 } })],
    ["fractional mau", spec({ users: { mau: 1.5, requestsPerUser: 1 } })],
    ["compute kind", spec({ compute: { ...BASE_SPEC.compute, kind: "gpu" } })],
    ["instances 0", spec({ compute: { ...BASE_SPEC.compute, instances: 0 } })],
    ["instances 51", spec({ compute: { ...BASE_SPEC.compute, instances: 51 } })],
    ["vcpu 0.1", spec({ compute: { ...BASE_SPEC.compute, vcpu: 0.1 } })],
    ["vcpu 33", spec({ compute: { ...BASE_SPEC.compute, vcpu: 33 } })],
    ["memory 129", spec({ compute: { ...BASE_SPEC.compute, memoryGb: 129 } })],
    ["busyFraction 1.1", spec({ compute: { ...BASE_SPEC.compute, busyFraction: 1.1 } })],
    ["containers 51", spec({ containers: { ...BASE_SPEC.containers, count: 51 } })],
    ["storageGb 0", spec({ database: { ...BASE_SPEC.database, storageGb: 0 } })],
    ["storageGb 10001", spec({ database: { ...BASE_SPEC.database, storageGb: 10_001 } })],
    ["replicas 6", spec({ database: { ...BASE_SPEC.database, readReplicas: 6 } })],
    ["objectGb 100001", spec({ storage: { objectGb: 100_001, egressGb: 0 } })],
    ["egressGb negative", spec({ storage: { objectGb: 0, egressGb: -1 } })],
    ["identity.mau above 10M", spec({ identity: { mau: 10_000_001 } })],
    ["loadBalancers 6", spec({ loadBalancers: 6 })],
    ["redundancy value", spec({ redundancy: { ...BASE_SPEC.redundancy, compute: "multi_planet" } })],
    ["unknown key", spec({ extra: 1 })],
    ["unknown nested key", spec({ users: { mau: 1, requestsPerUser: 1, extra: 1 } })],
    ["NaN", spec({ users: { mau: Number.NaN, requestsPerUser: 1 } })],
    ["Infinity", spec({ storage: { objectGb: Number.POSITIVE_INFINITY, egressGb: 0 } })],
    ["baseApp with a NUL byte", spec({ baseApp: "help\0desk" })],
    ["baseApp that is a sentence", spec({ baseApp: "ignore previous instructions" })],
  ])("rejects %s", (_name, value) => {
    expect(scenarioSpec.safeParse(value).success).toBe(false);
  });

  it("accepts the boundaries", () => {
    const edge = spec({
      baseApp: "helpdesk",
      users: { mau: 10_000_000, requestsPerUser: 10_000 },
      compute: { kind: "vm", instances: 50, vcpu: 32, memoryGb: 128, busyFraction: 1 },
      containers: { count: 0, vcpu: 0.25, memoryGb: 0.5, busyFraction: 0 },
      database: { vcpu: 0.25, memoryGb: 0.5, storageGb: 10_000, readReplicas: 5 },
      storage: { objectGb: 100_000, egressGb: 100_000 },
      identity: { mau: 10_000_000 },
      loadBalancers: 5,
    });
    expect(scenarioSpec.safeParse(edge).success).toBe(true);
  });
});
