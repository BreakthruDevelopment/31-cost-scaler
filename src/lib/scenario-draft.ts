import { z } from "zod";
import { REDUNDANCY, type Redundancy, type ScenarioSpec, scenarioSpec } from "@/lib/pricing/spec";
import { text } from "@/lib/text";

/**
 * The scenario builder's form state, and the pure conversion between it and a `ScenarioSpec`.
 *
 * Every number in the form is held as the string the user typed, so a half-typed or cleared field stays cleared
 * instead of snapping back to 0. Nothing here guesses a value: an empty or non-numeric field becomes `NaN`, which
 * `scenarioSpec` rejects, and the same schema the server uses produces the message the form shows. The server
 * validates again (`createScenario` / `updateScenario` / `priceSpec`); this only keeps the user from sending
 * something it would refuse.
 */

export const nameSchema = text(80, { min: 1, minMessage: "Name is required" });
export const MAX_NAME = 80;

export type SizeDraft = { vcpu: string; memoryGb: string; busyFraction: string };

/** The components redundancy can be set for, one key per `ScenarioSpec["redundancy"]` field. */
export type RedundancyPart = keyof ScenarioSpec["redundancy"];

export type ScenarioDraft = {
  name: string;
  /** "" means "not based on an app in the footprint". */
  baseApp: string;
  users: { mau: string; requestsPerUser: string };
  compute: { kind: "vm" | "serverless"; instances: string } & SizeDraft;
  containers: { count: string } & SizeDraft;
  database: { vcpu: string; memoryGb: string; storageGb: string; readReplicas: string };
  storage: { objectGb: string; egressGb: string };
  identity: { mau: string };
  loadBalancers: string;
  redundancy: Record<RedundancyPart, Redundancy>;
};

/** A number as the form shows it: trailing zeros removed, never exponent notation. */
const s = (n: number): string => String(n);

export function draftFromSpec(name: string, spec: ScenarioSpec): ScenarioDraft {
  return {
    name,
    baseApp: spec.baseApp ?? "",
    users: { mau: s(spec.users.mau), requestsPerUser: s(spec.users.requestsPerUser) },
    compute: {
      kind: spec.compute.kind,
      instances: s(spec.compute.instances),
      vcpu: s(spec.compute.vcpu),
      memoryGb: s(spec.compute.memoryGb),
      busyFraction: s(spec.compute.busyFraction),
    },
    containers: {
      count: s(spec.containers.count),
      vcpu: s(spec.containers.vcpu),
      memoryGb: s(spec.containers.memoryGb),
      busyFraction: s(spec.containers.busyFraction),
    },
    database: {
      vcpu: s(spec.database.vcpu),
      memoryGb: s(spec.database.memoryGb),
      storageGb: s(spec.database.storageGb),
      readReplicas: s(spec.database.readReplicas),
    },
    storage: { objectGb: s(spec.storage.objectGb), egressGb: s(spec.storage.egressGb) },
    identity: { mau: s(spec.identity.mau) },
    loadBalancers: s(spec.loadBalancers),
    redundancy: { ...spec.redundancy },
  };
}

/** An empty or non-numeric field is NaN, never 0: the schema then rejects it instead of pricing a value nobody typed. */
export function num(value: string): number {
  const t = value.trim();
  return t === "" ? Number.NaN : Number(t);
}

/** The draft as the shape `scenarioSpec` parses. Unvalidated on purpose: the caller parses it. */
export function specInputFromDraft(d: ScenarioDraft): unknown {
  const baseApp = d.baseApp.trim();
  return {
    ...(baseApp === "" ? {} : { baseApp }),
    users: { mau: num(d.users.mau), requestsPerUser: num(d.users.requestsPerUser) },
    compute: {
      kind: d.compute.kind,
      instances: num(d.compute.instances),
      vcpu: num(d.compute.vcpu),
      memoryGb: num(d.compute.memoryGb),
      busyFraction: num(d.compute.busyFraction),
    },
    containers: {
      count: num(d.containers.count),
      vcpu: num(d.containers.vcpu),
      memoryGb: num(d.containers.memoryGb),
      busyFraction: num(d.containers.busyFraction),
    },
    database: {
      vcpu: num(d.database.vcpu),
      memoryGb: num(d.database.memoryGb),
      storageGb: num(d.database.storageGb),
      readReplicas: num(d.database.readReplicas),
    },
    storage: { objectGb: num(d.storage.objectGb), egressGb: num(d.storage.egressGb) },
    identity: { mau: num(d.identity.mau) },
    loadBalancers: num(d.loadBalancers),
    redundancy: d.redundancy,
  };
}

/** A problem with one field: `field` is the dotted path the form labels its inputs with ("database.storageGb"). */
export type DraftIssue = { field: string; message: string };

export type DraftCheck = { ok: true; name: string; spec: ScenarioSpec } | { ok: false; issues: DraftIssue[] };

const issuesOf = (error: z.ZodError, prefix = ""): DraftIssue[] =>
  error.issues.map((i) => ({ field: `${prefix}${i.path.join(".")}`, message: i.message }));

/**
 * Validate the whole draft with the server's own schemas. Returns the parsed name and spec, or every issue found,
 * so the form can mark the fields and announce them together.
 */
export function checkDraft(d: ScenarioDraft): DraftCheck {
  const issues: DraftIssue[] = [];
  const name = nameSchema.safeParse(d.name);
  if (!name.success) issues.push(...issuesOf(name.error, "name"));
  const spec = scenarioSpec.safeParse(specInputFromDraft(d));
  if (!spec.success) issues.push(...issuesOf(spec.error));
  if (!name.success || !spec.success) return { ok: false, issues };
  return { ok: true, name: name.data, spec: spec.data };
}

const COPY_SUFFIX = " (copy)";

/** The name of a duplicate: "Plan A (copy)", shortened from the left so the suffix always survives the 80-char cap. */
export function copyName(name: string): string {
  const room = MAX_NAME - COPY_SUFFIX.length;
  return `${name.length > room ? name.slice(0, room).trimEnd() : name}${COPY_SUFFIX}`;
}

export const REDUNDANCY_LABEL: Record<Redundancy, string> = {
  single: "Single zone",
  multi_az: "Multi-AZ",
  multi_region: "Multi-region",
};

export const REDUNDANCY_OPTIONS = REDUNDANCY.map((value) => ({ value, label: REDUNDANCY_LABEL[value] }));

export const REDUNDANCY_PARTS: { key: RedundancyPart; label: string }[] = [
  { key: "compute", label: "Compute" },
  { key: "containers", label: "Containers" },
  { key: "database", label: "Database" },
  { key: "storage", label: "Storage" },
  { key: "identity", label: "Identity" },
  { key: "loadBalancers", label: "Load balancers" },
];
