import { createHash } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";
import { CLOUDS } from "@/lib/db/schema";
import { text } from "@/lib/text";

/**
 * The shape of `apps.yaml` in 30-apps-infra, as far as this app reads it. Everything in the file is data: titles
 * are free text, so control characters (NUL included) become spaces and the length is capped before they reach
 * the database or, later, a prompt. Unknown keys (image, tag, timeout, ...) are ignored, so the infra repo can
 * add fields without breaking the import.
 */
const title = z
  .string()
  .transform((s) => s.replace(/\p{Cc}/gu, " "))
  .pipe(text(120));

const appEntry = z.looseObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  title: title.optional(),
  clouds: z.array(z.enum(CLOUDS)).min(1).max(CLOUDS.length),
  domain: z
    .string()
    .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, "Must be a hostname")
    .nullable()
    .optional(),
  ai: z.enum(["demo", "gemini"]),
  storage: z.boolean().optional(),
  secrets: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/))
    .max(50)
    .optional(),
});

export const appsFile = z
  .object({ apps: z.array(appEntry).min(1).max(200) })
  .refine((f) => new Set(f.apps.map((a) => a.name)).size === f.apps.length, "Duplicate app names");

export type FootprintEntry = {
  name: string;
  title: string;
  clouds: string[];
  domain: string | null;
  storage: boolean;
  secretCount: number;
  ai: "demo" | "gemini";
};

export const MAX_APPS_YAML_BYTES = 256 * 1024;

/** Parse and validate the text of `apps.yaml`. Throws `ZodError` or a YAML error; callers map both to a code. */
export function parseAppsYaml(source: string): { apps: FootprintEntry[]; sourceCommit: string } {
  if (Buffer.byteLength(source) > MAX_APPS_YAML_BYTES) throw new Error("apps.yaml too large");
  // `core` schema, no merge keys, a small alias budget: the file is ours, but it is still input.
  const raw: unknown = parse(source, { schema: "core", merge: false, maxAliasCount: 10 });
  const file = appsFile.parse(raw);
  return {
    apps: file.apps.map((a) => ({
      name: a.name,
      title: a.title && a.title.length > 0 ? a.title : a.name,
      clouds: [...new Set(a.clouds)],
      domain: a.domain ?? null,
      storage: a.storage === true,
      secretCount: a.secrets?.length ?? 0,
      ai: a.ai,
    })),
    sourceCommit: createHash("sha256").update(source).digest("hex").slice(0, 12),
  };
}
