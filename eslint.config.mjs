import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Model calls go through src/lib/ai only (AGENTS.md): no ADK or Gemini SDK anywhere else.
  {
    files: ["src/**/*.{ts,tsx}", "scripts/**/*.{ts,mts}", "test/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@google/adk", "@google/adk/*", "@google/genai", "@google/genai/*"], message: "Create agents, runners and models only in src/lib/ai (use runAgent() or generate())." },
          ],
        },
      ],
    },
  },
  { files: ["src/lib/ai/**/*.ts", "test/ai-*.ts"], rules: { "no-restricted-imports": "off" } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
