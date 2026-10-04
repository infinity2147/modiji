/**
 * End-to-end tests against the PRODUCTION server (`next build` must run first; `pnpm test:e2e` does
 * both). Each run gets a fresh DATA_DIR, so the ledger starts empty. Secrets are placeholders that
 * satisfy production env validation; LLM_CALLS=off guarantees zero model calls, and no test reaches ElevenLabs.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 4391);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Workers re-load this file; they inherit the variable, so all share the one directory.
process.env.E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), "vashistha-e2e-"));

/**
 * The perception fixture recorder (`@record`) and the OCR latency measurement (`@measure`) run only
 * when asked for, e.g. `playwright test --grep @record`. The test list is built in this (runner)
 * process, so only its command line matters.
 */
const ON_DEMAND = /@record|@measure/;
const onDemand = process.argv.some((arg) => ON_DEMAND.test(arg));

export default defineConfig({
  testDir: "./e2e",
  // LIVE runs against the deployed service (real voice and models) have their own config: e2e/live/.
  testIgnore: "**/live/**",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  ...(!onDemand && { grepInvert: ON_DEMAND }),
  retries: 0,
  reporter: [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: "npx tsx server.ts",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NODE_ENV: "production",
      PORT: String(PORT),
      DATA_DIR: process.env.E2E_DATA_DIR,
      PUBLIC_BASE_URL: "https://casedesk-e2e.invalid",
      CUSTOM_LLM_SECRET: "e2e-placeholder-secret-not-used-0123456789",
      ANTHROPIC_API_KEY: "e2e-placeholder-not-a-key",
      ELEVENLABS_API_KEY: "e2e-placeholder-not-a-key",
      // Hermetic: no Anthropic client exists (interview, debrief and vision included), so the placeholder key is never
      // sent anywhere; frames are still stored and ledgered, and the vision state reports "disabled".
      LLM_CALLS: "off",
    },
  },
});
