import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** The price seed writes SYNTHETIC prices: it must refuse anything but a local database, and production always. */
const script = path.resolve(__dirname, "../scripts/seed-prices.mts");
const run = (env: Record<string, string>) =>
  spawnSync(path.resolve(__dirname, "../node_modules/.bin/tsx"), [script], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000 });

describe("scripts/seed-prices.mts", () => {
  it("refuses a remote database host", () => {
    const r = run({ DATABASE_URL: "postgres://u:p@db.example.com:5432/app" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Price seed refused");
  });
  it("refuses NODE_ENV=production even for localhost", () => {
    const r = run({ DATABASE_URL: "postgres://u:p@localhost:1/app", NODE_ENV: "production" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Price seed refused");
  });
  it("refuses when DATABASE_URL is missing", () => {
    expect(run({}).status).toBe(1);
  });
});
