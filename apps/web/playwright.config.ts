/**
 * End-to-end tests against the PRODUCTION server (`next build` must run first; `pnpm test:e2e` does
 * both). Secrets are placeholders that satisfy production env validation; LLM_CALLS=off guarantees zero
 * model calls, and no test reaches ElevenLabs.
 *
 * Isolation: every spec file runs against its OWN server with its own fresh DATA_DIR (a Playwright
 * project + web server per file, on consecutive ports from E2E_PORT). No spec sees another spec's
 * sessions or rules — the shared rulebook, the expert directory and replay bundles are global server
 * state — so the suite gives the same result in any order and on every run. A spec reads its server's
 * DATA_DIR with `serverDataDir()` (e2e/support/server.ts).
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { E2E_OPERATOR_SECRET } from "./e2e/support/operator";

const BASE_PORT = Number(process.env.E2E_PORT ?? 4391);
const TEST_DIR = join(import.meta.dirname, "e2e");

// Workers re-load this file; they inherit the variable, so all agree on the one root directory.
process.env.E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), "vashistha-e2e-"));
const DATA_ROOT = process.env.E2E_DATA_DIR;

/**
 * The perception fixture recorder (`@record`) and the OCR latency measurement (`@measure`) run only
 * when asked for, e.g. `playwright test --grep @record`. The test list is built in this (runner)
 * process, so only its command line matters. A spec whose tests are all on demand gets no server otherwise.
 */
const ON_DEMAND = /@record|@measure/;
const onDemand = process.argv.some((arg) => ON_DEMAND.test(arg));

const specs = readdirSync(TEST_DIR)
  .filter((file) => file.endsWith(".spec.ts"))
  .sort()
  .filter((file) => {
    const titles = [...readFileSync(join(TEST_DIR, file), "utf8").matchAll(/^test\("([^"]*)"/gm)].map((m) => m[1] ?? "");
    return onDemand || titles.length === 0 || titles.some((title) => !ON_DEMAND.test(title));
  })
  .map((file, i) => {
    const name = file.replace(/\.spec\.ts$/, "");
    const dataDir = join(DATA_ROOT, name);
    mkdirSync(dataDir, { recursive: true });
    return { name, file, dataDir, port: BASE_PORT + i };
  });

const viewport = { width: 1440, height: 900 };

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
  use: { viewport, trace: "retain-on-failure" },
  projects: specs.map(({ name, file, dataDir, port }) => ({
    name,
    testMatch: file,
    metadata: { dataDir },
    use: { ...devices["Desktop Chrome"], viewport, baseURL: `http://127.0.0.1:${port}` },
  })),
  webServer: specs.map(({ name, dataDir, port }) => ({
    name,
    command: "npx tsx server.ts",
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      NODE_ENV: "production",
      PORT: String(port),
      DATA_DIR: dataDir,
      PUBLIC_BASE_URL: "https://casedesk-e2e.invalid",
      CUSTOM_LLM_SECRET: E2E_OPERATOR_SECRET,
      ANTHROPIC_API_KEY: "e2e-placeholder-not-a-key",
      ELEVENLABS_API_KEY: "e2e-placeholder-not-a-key",
      // Hermetic: no Anthropic client exists (interview, debrief and vision included), so the placeholder key is never
      // sent anywhere; frames are still stored and ledgered, and the vision state reports "disabled".
      LLM_CALLS: "off",
    },
  })),
});
