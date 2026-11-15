import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, doublePrecision, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth with the admin plugin).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Domain tables (Cloud Cost Scaler). Private tables carry `owner_id` (FK, cascade); public ones are read-only
// to everyone and written only by the refresh jobs (see src/lib/access.ts for the rule per table).
// ---------------------------------------------------------------------------

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const CLOUDS = ["aws", "azure", "gcp", "oci"] as const;
export const COMPONENTS = ["vm", "serverless", "postgres", "object_storage", "egress", "identity", "load_balancer"] as const;
export const PRICE_UNITS = ["hour", "vcpu_hour", "gb_hour", "gb_month", "gb", "mau", "million_requests", "vcpu_second", "gib_second"] as const;
export const PRICE_STATUSES = ["active", "quarantined"] as const;
export const REFRESH_SOURCES = ["aws_ec2", "aws_other", "azure", "gcp", "oci", "footprint"] as const;
export const REFRESH_TRIGGERS = ["scheduler", "admin"] as const;
export const REFRESH_OUTCOMES = ["running", "ok", "partial", "failed", "unavailable"] as const;

/** One normalized list price (public). `usd_micros` is integer micro-dollars per `unit`. */
export const pricePoint = pgTable(
  "price_point",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cloud: text("cloud", { enum: CLOUDS }).notNull(),
    component: text("component", { enum: COMPONENTS }).notNull(),
    skuKey: text("sku_key").notNull(),
    region: text("region").notNull(),
    unit: text("unit", { enum: PRICE_UNITS }).notNull(),
    usdMicros: bigint("usd_micros", { mode: "number" }).notNull(),
    /** Tier floor, 0 for untiered prices (NOT NULL so the unique index below treats "no tier" as one value). */
    tierStart: doublePrecision("tier_start").notNull().default(0),
    tierEnd: doublePrecision("tier_end"),
    vendorSku: text("vendor_sku"),
    description: text("description").notNull().default(""),
    sourceUrl: text("source_url").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    sourceVersion: text("source_version"),
    status: text("status", { enum: PRICE_STATUSES }).notNull().default("active"),
  },
  (t) => [
    uniqueIndex("price_point_sku_uidx").on(t.cloud, t.skuKey, t.region, t.tierStart),
    index("price_point_cloud_component_idx").on(t.cloud, t.component),
    check("price_point_cloud_chk", sql`${t.cloud} in (${list(CLOUDS)})`),
    check("price_point_component_chk", sql`${t.component} in (${list(COMPONENTS)})`),
    check("price_point_unit_chk", sql`${t.unit} in (${list(PRICE_UNITS)})`),
    check("price_point_status_chk", sql`${t.status} in (${list(PRICE_STATUSES)})`),
    check("price_point_usd_chk", sql`${t.usdMicros} >= 0`),
    check("price_point_description_chk", sql`char_length(${t.description}) <= 200`),
  ],
);

/** One refresh run of one source (admin). Stores codes and counts only: no URLs, keys or response content. */
export const priceRefresh = pgTable(
  "price_refresh",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source", { enum: REFRESH_SOURCES }).notNull(),
    trigger: text("trigger", { enum: REFRESH_TRIGGERS }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: text("outcome", { enum: REFRESH_OUTCOMES }).notNull().default("running"),
    rowsUpserted: integer("rows_upserted").notNull().default(0),
    rowsMissing: integer("rows_missing").notNull().default(0),
    rowsQuarantined: integer("rows_quarantined").notNull().default(0),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    errorCode: text("error_code"),
    /** Small structured result with no URLs or secrets; the footprint source records its profile-drift check here. */
    detail: jsonb("detail").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("price_refresh_source_started_idx").on(t.source, t.startedAt),
    check("price_refresh_source_chk", sql`${t.source} in (${list(REFRESH_SOURCES)})`),
    check("price_refresh_trigger_chk", sql`${t.trigger} in (${list(REFRESH_TRIGGERS)})`),
    check("price_refresh_outcome_chk", sql`${t.outcome} in (${list(REFRESH_OUTCOMES)})`),
  ],
);

/** The portfolio's current footprint, imported from 30-apps-infra `apps.yaml` (public). Replaced per refresh. */
export const footprintApp = pgTable("footprint_app", {
  name: text("name").primaryKey(),
  title: text("title").notNull(),
  clouds: text("clouds").array().notNull(),
  domain: text("domain"),
  storage: boolean("storage").notNull().default(false),
  secretCount: integer("secret_count").notNull().default(0),
  ai: text("ai").notNull(),
  /** A short content hash of the imported `apps.yaml` (raw.githubusercontent.com does not expose a commit). */
  sourceCommit: text("source_commit").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A user's saved scenario (private to its owner, admin included). */
export const scenario = pgTable(
  "scenario",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    baseApp: text("base_app"),
    spec: jsonb("spec").$type<unknown>().notNull(),
    /** Set by clients that retry (see src/lib/client-op.ts); unique per owner, so a replay returns the first row. */
    clientOpId: uuid("client_op_id"),
    /** Optimistic concurrency: PATCH carries the version it read; a stale one is a 409. */
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("scenario_owner_id_idx").on(t.ownerId),
    uniqueIndex("scenario_owner_client_op_uidx").on(t.ownerId, t.clientOpId),
    // Target of the composite foreign keys below: a child row can only point at a scenario of the same owner.
    unique("scenario_id_owner_uq").on(t.id, t.ownerId),
    check("scenario_name_chk", sql`char_length(${t.name}) between 1 and 80`),
    check("scenario_version_chk", sql`${t.version} >= 1`),
  ],
);

/** The latest computed result of a scenario (one row per scenario; compare uses saved results). */
export const scenarioResult = pgTable(
  "scenario_result",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scenarioId: uuid("scenario_id").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    pricesAsOf: timestamp("prices_as_of", { withTimezone: true }).notNull(),
    result: jsonb("result").$type<unknown>().notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("scenario_result_scenario_uidx").on(t.scenarioId),
    foreignKey({ columns: [t.scenarioId, t.ownerId], foreignColumns: [scenario.id, scenario.ownerId], name: "scenario_result_scenario_owner_fk" }).onDelete("cascade"),
  ],
);

/** A saved advisor answer (private to its owner). Rows are written by the advisor (issue 31.4). */
export const advice = pgTable(
  "advice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    appName: text("app_name"),
    scenarioId: uuid("scenario_id"),
    output: jsonb("output").$type<unknown>().notNull(),
    trace: jsonb("trace").$type<unknown>().notNull(),
    checks: jsonb("checks").$type<unknown>().notNull(),
    provider: text("provider").notNull(),
    demo: boolean("demo").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("advice_owner_created_idx").on(t.ownerId, t.createdAt),
    // MATCH SIMPLE: with a null scenario_id nothing is checked; otherwise the scenario must belong to the same owner.
    foreignKey({ columns: [t.scenarioId, t.ownerId], foreignColumns: [scenario.id, scenario.ownerId], name: "advice_scenario_owner_fk" }).onDelete("cascade"),
    check("advice_question_chk", sql`char_length(${t.question}) <= 500`),
  ],
);

// ---------------------------------------------------------------------------
// Usage limits (src/lib/usage.ts). Each app lists its own kinds here; changing a list
// needs a migration, because the CHECK constraints below are part of the schema.
// ---------------------------------------------------------------------------

export const RATE_KINDS = ["scenario_write", "price_run", "advice", "refresh"] as const;
export const DAILY_USAGE_KINDS = ["ai", "demo_load"] as const;

/** App-wide daily counters (one row per UTC day and kind) for free-tier caps. */
export const dailyUsage = pgTable(
  "daily_usage",
  {
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind", { enum: DAILY_USAGE_KINDS }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.kind] }),
    check("daily_usage_kind_chk", sql`${t.kind} in (${list(DAILY_USAGE_KINDS)})`),
    check("daily_usage_count_chk", sql`${t.count} >= 0`),
  ],
);

/** Per-user rate-limit ledger: one row per attempt, counted over a sliding window. */
export const rateEvent = pgTable(
  "rate_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RATE_KINDS }).notNull(),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("rate_event_user_kind_at_idx").on(t.userId, t.kind, t.at),
    check("rate_event_kind_chk", sql`${t.kind} in (${list(RATE_KINDS)})`),
  ],
);

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

/**
 * Background job queue (see src/lib/jobs). `key` makes enqueue idempotent: only one queued or running job per
 * (kind, key). `payload` holds ids and small parameters, never personal data or secrets. `last_error` is a short
 * code, never a message.
 */
export const job = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    key: text("key"),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(4),
    /** Times a handler asked to try again later without using an attempt; capped so a job can't defer forever. */
    deferrals: integer("deferrals").notNull().default(0),
    /** A floor, not a deadline: the job runs at the first claim after this time. */
    runAfter: timestamp("run_after", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    /** While running: the lease. After it passes, any worker may reclaim the job. */
    lockedUntil: timestamp("locked_until", { withTimezone: true, precision: 3 }),
    /** Fencing token of the current claim: a worker whose lease was reclaimed can no longer complete or fail the job. */
    lockToken: uuid("lock_token"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    uniqueIndex("job_active_key_uidx").on(t.kind, t.key).where(sql`${t.status} in ('queued', 'running') and ${t.key} is not null`),
    index("job_due_idx").on(t.runAfter).where(sql`${t.status} = 'queued'`),
    index("job_lease_idx").on(t.lockedUntil).where(sql`${t.status} = 'running'`),
    index("job_kind_key_idx").on(t.kind, t.key, t.createdAt),
    index("job_owner_idx").on(t.ownerId),
    check("job_status_chk", sql`${t.status} in (${list(JOB_STATUSES)})`),
    check("job_attempts_chk", sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1 and ${t.deferrals} >= 0`),
  ],
);

export type User = typeof user.$inferSelect;
export type Scenario = typeof scenario.$inferSelect;
export type ScenarioResult = typeof scenarioResult.$inferSelect;
export type FootprintApp = typeof footprintApp.$inferSelect;
export type Job = typeof job.$inferSelect;
