/**
 * LIVE acceptance runs (@live) against the deployed service — real ElevenLabs voice, real Anthropic
 * calls, the production ledger. Never part of the default suite (`playwright.config.ts` ignores
 * `e2e/live/**`). See e2e/live/README.md.
 *
 *   NODE_OPTIONS=--dns-result-order=ipv4first pnpm --filter @vashistha/web exec \
 *     playwright test -c e2e/live/playwright.live.config.ts --grep @p3
 */
import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./support/env";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.live.spec.ts",
  grep: /@live/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../../test-results/live",
  timeout: 15 * 60_000,
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    launchOptions: {
      args: [
        // Microphone and screen: the page's getUserMedia (audio) and getDisplayMedia are replaced by
        // the harness (support/harness.ts); these flags keep Chromium from prompting or failing first.
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        // The harness's AudioContext (the synthetic microphone) and the agent's audio must run without a click.
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  projects: [{ name: "chromium-live", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
