/** Advice access rules (owner only; others, admin included, get 404) and the composite foreign key, against Postgres. */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("advice (Postgres)", () => {
  let sql: postgres.Sql;
  let a: typeof import("@/lib/advice-store");
  const alice = { id: "ad-alice", role: "user" as const };
  const bob = { id: "ad-bob", role: "user" as const };
  const admin = { id: "ad-admin", role: "admin" as const };
  let adviceId: string;
  let scenarioId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id like 'ad-%'`;
    for (const u of [alice, bob, admin]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    [{ id: scenarioId }] = await sql`insert into scenario (owner_id, name, spec) values (${alice.id}, 'adv', '{}'::jsonb) returning id`;
    [{ id: adviceId }] = await sql`
      insert into advice (owner_id, question, scenario_id, output, trace, checks, provider, demo)
      values (${alice.id}, 'Should it move?', ${scenarioId}, '{"headline":"CANARY"}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'demo', true) returning id`;
    a = await import("@/lib/advice-store");
  });
  afterAll(async () => {
    await sql`delete from "user" where id like 'ad-%'`;
    await sql.end();
  });

  it("owner reads and lists their advice", async () => {
    expect((await a.getAdvice(alice, adviceId)).question).toBe("Should it move?");
    expect((await a.listAdvice(alice)).map((r) => r.id)).toContain(adviceId);
  });

  it("another user and an admin get 404, and their lists never include it", async () => {
    for (const stranger of [bob, admin]) {
      await expect(a.getAdvice(stranger, adviceId)).rejects.toMatchObject({ status: 404 });
      expect((await a.listAdvice(stranger)).map((r) => r.id)).not.toContain(adviceId);
    }
    await expect(a.getAdvice(bob, "not-a-uuid")).rejects.toMatchObject({ status: 404 });
    await expect(a.getAdvice(bob, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
  });

  it("the database refuses advice that points at another user's scenario (composite foreign key)", async () => {
    await expect(
      sql`insert into advice (owner_id, question, scenario_id, output, trace, checks, provider) values (${bob.id}, 'q', ${scenarioId}, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'demo')`,
    ).rejects.toMatchObject({ code: "23503" });
    // No scenario at all is fine.
    await sql`insert into advice (owner_id, question, output, trace, checks, provider) values (${bob.id}, 'q', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'demo')`;
  });

  it("caps the question at 500 characters", async () => {
    await expect(
      sql`insert into advice (owner_id, question, output, trace, checks, provider) values (${alice.id}, ${"x".repeat(501)}, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'demo')`,
    ).rejects.toMatchObject({ code: "23514" });
  });
});
