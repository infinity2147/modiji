/**
 * End-to-end tests against the PRODUCTION server (`next build` must run first; `pnpm test:e2e` does
 * both). Each run gets a fresh DATA_DIR, so the ledger starts empty. Secrets are placeholders that
 * satisfy production env validation; no test reaches Anthropic or ElevenLabs.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 4391);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Workers re-load this file; they inherit the variable, so all share the one directory.
process.env.E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), "vashistha-e2e-"));

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
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
    },
  },
});
