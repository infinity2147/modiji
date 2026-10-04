/**
 * Playwright from the web app's own dev dependency (no new root dependency). The Chromium headless
 * shell is the one already installed for the e2e suite (~/.cache/ms-playwright); nothing is downloaded.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
/** Types via pnpm's hoisted store (a path through apps/web/node_modules would not resolve playwright/test for tsc). */
import type * as PlaywrightTest from "../../../node_modules/.pnpm/node_modules/@playwright/test";
import { REPO } from "./repo";

export type { Browser, BrowserContext, Page, Locator, APIRequestContext } from "../../../node_modules/.pnpm/node_modules/@playwright/test";

const require = createRequire(join(REPO, "apps/web/package.json"));
export const playwright = require("@playwright/test") as typeof PlaywrightTest;
