import { z } from "zod";

/**
 * Every setting the app reads, validated in one place.
 * Read lazily so `next build` works without production secrets.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_NAME: z.string().default("30 Apps Template"),
  // The public URL, e.g. https://app7.breakthruventures.ai. Sign-in callbacks,
  // cookies and CORS all derive from it, so a domain change never touches code.
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  // "demo" serves recorded answers, so demos never break on a quota.
  AI_PROVIDER: z.enum(["gemini", "anthropic", "demo"]).default("demo"),
  AI_MODEL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Fall back to demo answers when the live provider fails (quota, outage).
  AI_FALLBACK_TO_DEMO: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Embedding model for embed(). Confirm the name on the day (see README, "Embeddings").
  AI_EMBED_MODEL: z.string().optional(),
  // Provider call timeout. 20 s keeps AI calls inside Lambda's 29 s limit (route maxDuration is 25 s).
  AI_TIMEOUT_MS: z.coerce.number().int().positive().max(22000).default(20000),
  // Cost Scaler price refresh. The bearer token the scheduler sends, and the Google Cloud Billing Catalog API key.
  // Both are optional: without the token only an admin can refresh; without the key Google Cloud shows "prices unavailable".
  COST_SCALER_REFRESH_TOKEN: z.string().min(16).optional(),
  COST_SCALER_GCP_PRICING_API_KEY: z.string().min(8).optional(),
  // Cost Scaler advisor. The free daily request allowance of the shared Gemini key (a deliberately low placeholder: set the
  // key's real limit) and the share of it app 31 may use. Together they give ADVISOR_DAILY_MODEL_CALLS.
  GEMINI_DAILY_REQUESTS: z.coerce.number().int().positive().max(1_000_000).default(200),
  ADVISOR_GEMINI_SHARE: z.coerce.number().gt(0).max(1).default(0.25),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    // Cloud consoles and CI often set unused variables to "". Treat those as unset
    // so defaults apply instead of failing validation.
    const present = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ""),
    );
    const parsed = schema.safeParse(present);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Model calls the advisor may make per UTC day: floor(GEMINI_DAILY_REQUESTS x ADVISOR_GEMINI_SHARE). 50 by default. */
export function advisorDailyModelCalls(): number {
  const e = env();
  return Math.floor(e.GEMINI_DAILY_REQUESTS * e.ADVISOR_GEMINI_SHARE);
}

/** For tests only. */
export function resetEnvCache() {
  cached = undefined;
}
