import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db, schema } from "@/lib/db";
import { DEMO_EMAIL_DOMAIN, MARKER } from "@/lib/demo-identity";
import { demoSeedConfig } from "@/lib/demo-seed-config";
import { ConflictError } from "@/lib/errors";
import { log } from "@/lib/log";
import { BASE_SPEC, type ScenarioSpec } from "@/lib/pricing/spec";
import { createScenario } from "@/lib/scenarios";

export const DEMO_EMAIL = `demo@${DEMO_EMAIL_DOMAIN}`;

/** Three scenarios for one demo user: today, 10x the users, and 10x with redundancy. Fixed op ids make reloads idempotent. */
export const DEMO_SCENARIOS: { name: string; clientOpId: string; spec: ScenarioSpec }[] = [
  {
    name: "Helpdesk today",
    clientOpId: "00000000-0000-4000-8000-000000000a01",
    spec: { ...BASE_SPEC, baseApp: "helpdesk" },
  },
  {
    name: "Helpdesk at 10x users",
    clientOpId: "00000000-0000-4000-8000-000000000a02",
    spec: {
      ...BASE_SPEC,
      baseApp: "helpdesk",
      users: { mau: 5_000, requestsPerUser: 200 },
      compute: { kind: "serverless", instances: 2, vcpu: 1, memoryGb: 1, busyFraction: 0.2 },
      database: { vcpu: 2, memoryGb: 4, storageGb: 50, readReplicas: 0 },
      storage: { objectGb: 100, egressGb: 200 },
      identity: { mau: 5_000 },
    },
  },
  {
    name: "Helpdesk at 10x, multi-AZ with a replica",
    clientOpId: "00000000-0000-4000-8000-000000000a03",
    spec: {
      ...BASE_SPEC,
      baseApp: "helpdesk",
      users: { mau: 5_000, requestsPerUser: 200 },
      compute: { kind: "vm", instances: 2, vcpu: 2, memoryGb: 8, busyFraction: 1 },
      database: { vcpu: 2, memoryGb: 8, storageGb: 100, readReplicas: 1 },
      storage: { objectGb: 100, egressGb: 200 },
      identity: { mau: 5_000 },
      loadBalancers: 1,
      redundancy: { compute: "multi_az", containers: "single", database: "multi_az", storage: "single", identity: "single", loadBalancers: "multi_az" },
    },
  },
];

/**
 * Load the demo workspace into a LOCAL database: one demo user (marked, so only this loader ever replaces it) and
 * three scenarios. Run by `scripts/seed-demo.mts`, which refuses production hosts first; `demoSeedConfig()` is
 * checked again here. A trusted CLI capability: no HTTP route calls it.
 */
export async function loadDemoWorkspace(): Promise<{ users: number; scenarios: number }> {
  const { password } = demoSeedConfig();
  const ctx = await auth().$context;
  const hash = await ctx.password.hash(password);

  const [existing] = await db().select().from(schema.user).where(eq(schema.user.email, DEMO_EMAIL));
  // An unrelated account holding the demo email is never adopted or overwritten.
  if (existing && existing.image !== MARKER) throw new ConflictError("The demo email belongs to an unrelated account; nothing was replaced.");

  const userId = await db().transaction(async (tx) => {
    if (existing) {
      await tx.update(schema.account).set({ password: hash, updatedAt: new Date() }).where(and(eq(schema.account.userId, existing.id), eq(schema.account.providerId, "credential")));
      await tx.update(schema.user).set({ role: "user", name: "Demo User", updatedAt: new Date() }).where(eq(schema.user.id, existing.id));
      await tx.delete(schema.session).where(eq(schema.session.userId, existing.id));
      await tx.delete(schema.scenario).where(eq(schema.scenario.ownerId, existing.id)); // results and advice cascade
      await tx.delete(schema.rateEvent).where(eq(schema.rateEvent.userId, existing.id));
      return existing.id;
    }
    const id = randomUUID();
    await tx.insert(schema.user).values({ id, name: "Demo User", email: DEMO_EMAIL, emailVerified: true, image: MARKER, role: "user" });
    await tx.insert(schema.account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash });
    return id;
  });

  // Through the real data function, so the sample data obeys the real rules.
  const actor = { id: userId, role: "user" as const };
  for (const s of DEMO_SCENARIOS) await createScenario(actor, s);
  log.info("demo.loaded", { users: 1, scenarios: DEMO_SCENARIOS.length });
  return { users: 1, scenarios: DEMO_SCENARIOS.length };
}
