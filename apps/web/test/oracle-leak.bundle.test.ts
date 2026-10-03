/**
 * Scans the real production build for oracle canaries. Needs `next build` first:
 * run `pnpm test:bundle` from the repo root (builds, then runs this project).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PRODUCT_THESIS } from "../lib/product";
import { discoverOracleModules, listTextFiles, scanFilesForMarkers, type OracleModule } from "./support/oracle-scan";

const WEB_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "../..");
const NEXT_DIR = path.join(WEB_ROOT, ".next");
const STATIC_DIR = path.join(NEXT_DIR, "static");
const SERVER_APP_DIR = path.join(NEXT_DIR, "server", "app");

/**
 * Files under .next/server/app whose contents reach the browser: prerendered HTML, RSC payloads
 * (incl. per-segment `.segment.rsc`), cached route bodies, and client reference manifests.
 */
function isBrowserFacingServerFile(file: string): boolean {
  return /\.(html|rsc|body)$/.test(file) || /_client-reference-manifest\.js$/.test(file);
}

describe("production client output contains no oracle marker", () => {
  let oracles: OracleModule[];
  let staticFiles: string[];
  let browserFacingServerFiles: string[];

  beforeAll(async () => {
    if (!existsSync(path.join(NEXT_DIR, "BUILD_ID"))) {
      throw new Error(
        `No production build at ${NEXT_DIR}. Run \`pnpm test:bundle\` from the repo root ` +
          "(or `pnpm --filter @vashistha/web build` first).",
      );
    }
    oracles = await discoverOracleModules(REPO_ROOT);
    staticFiles = await listTextFiles(STATIC_DIR);
    browserFacingServerFiles = existsSync(SERVER_APP_DIR)
      ? (await listTextFiles(SERVER_APP_DIR)).filter(isBrowserFacingServerFile)
      : [];
  });

  it("scans a non-empty client bundle", () => {
    expect(staticFiles.filter((file) => file.endsWith(".js")).length).toBeGreaterThan(0);
  });

  it("reads the browser-facing server output (control: the home page's text is found)", async () => {
    const hits = await scanFilesForMarkers(browserFacingServerFiles, [PRODUCT_THESIS]);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("finds no oracle marker in .next/static or browser-facing .next/server/app files", async () => {
    const hits = await scanFilesForMarkers([...staticFiles, ...browserFacingServerFiles], oracles.map((o) => o.marker));
    expect(hits.map((hit) => ({ ...hit, file: path.relative(WEB_ROOT, hit.file) }))).toEqual([]);
  });
});
