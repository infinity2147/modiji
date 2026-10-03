import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  discoverOracleModules,
  findMarkersInText,
  parseOracleModule,
  scanForMarkers,
  type MarkerHit,
} from "./support/oracle-scan";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const FIXTURE_ORACLE = path.join(FIXTURES, "fixture.oracle.server.ts");
const FIXTURE_MARKER = "oracle:fixture:9e3019f4d3df24eddabea38ef7bba13d";
const EMPTY_MODULE = path.join(import.meta.dirname, "support", "empty-module.ts");

const VALID_SOURCE = `import "server-only";
import type { Thing } from "./thing";
export const ORACLE_MARKER = "oracle:kyc:0123456789abcdef";
export const policy = { marker: ORACLE_MARKER } satisfies Partial<Thing>;
`;

describe("oracle module convention", () => {
  it("holds for every oracle module in the repo (discovery throws on any violation)", async () => {
    const modules = await discoverOracleModules(REPO_ROOT);
    const files = modules.map((m) => m.file);
    expect(files).not.toContain(FIXTURE_ORACLE);
    expect(new Set(modules.map((m) => m.marker)).size).toBe(modules.length);
  });

  it("holds for the fixture oracle used by the leak controls", async () => {
    const source = await readFile(FIXTURE_ORACLE, "utf8");
    expect(parseOracleModule(FIXTURE_ORACLE, source)).toEqual({ file: FIXTURE_ORACLE, marker: FIXTURE_MARKER });
  });

  it("accepts a minimal valid module", () => {
    expect(parseOracleModule("ok.oracle.server.ts", VALID_SOURCE).marker).toBe("oracle:kyc:0123456789abcdef");
  });

  it.each([
    ["no server-only import", VALID_SOURCE.replace('import "server-only";\n', ""), "first import"],
    [
      "server-only not first",
      VALID_SOURCE.replace('import "server-only";\n', "").replace('from "./thing";', 'from "./thing";\nimport "server-only";'),
      "first import",
    ],
    ["named import from server-only", VALID_SOURCE.replace('import "server-only"', 'import x from "server-only"'), "first import"],
    ["missing marker", 'import "server-only";\nexport const policy = {};\n', "exactly one ORACLE_MARKER"],
    ["two markers", `${VALID_SOURCE}export const ORACLE_MARKER = "oracle:kyc:fedcba9876543210";\n`, "exactly one ORACLE_MARKER"],
    ["marker not exported", VALID_SOURCE.replace("export const ORACLE_MARKER", "const ORACLE_MARKER"), "must be `export const"],
    ["marker is let", VALID_SOURCE.replace("export const ORACLE_MARKER", "export let ORACLE_MARKER"), "must be `export const"],
    ["marker is a template", VALID_SOURCE.replace('"oracle:kyc:0123456789abcdef"', "`oracle:kyc:0123456789abcdef`"), "must be `export const"],
    ["hex too short", VALID_SOURCE.replace("0123456789abcdef", "0123456789abcde"), "must match"],
    ["uppercase hex", VALID_SOURCE.replace("0123456789abcdef", "0123456789ABCDEF"), "must match"],
    ["invalid domain id", VALID_SOURCE.replace("oracle:kyc:", "oracle:1kyc:"), "must match"],
    ["marker never referenced", VALID_SOURCE.replace("{ marker: ORACLE_MARKER }", "{}"), "must be referenced"],
  ])("rejects a module with %s", (_case, source, message) => {
    expect(() => parseOracleModule("bad.oracle.server.ts", source)).toThrow(message);
  });

  describe("discovery", () => {
    let root: string;
    const put = async (relative: string, content: string): Promise<string> => {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      return file;
    };

    beforeAll(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), "oracle-discovery-"));
    });
    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("finds oracle modules and skips node_modules, dot-directories and the scanner's own fixtures", async () => {
      const real = await put("packages/domains/kyc/domain.oracle.server.ts", VALID_SOURCE);
      const otherMarker = "oracle:kyc:fedcba9876543210";
      const inOtherFixtures = await put(
        "packages/domains/fixtures/domain.oracle.server.ts",
        VALID_SOURCE.replace("oracle:kyc:0123456789abcdef", otherMarker),
      );
      const invalid = "export const nothing = 1;\n";
      await put("node_modules/pkg/domain.oracle.server.ts", invalid);
      await put(".next/server/domain.oracle.server.ts", invalid);
      await put("apps/web/test/fixtures/domain.oracle.server.ts", invalid);
      await put("packages/domains/kyc/domain.public.ts", invalid);

      expect(await discoverOracleModules(root)).toEqual([
        { file: inOtherFixtures, marker: otherMarker },
        { file: real, marker: "oracle:kyc:0123456789abcdef" },
      ]);
    });

    it("rejects a duplicated marker", async () => {
      await put("packages/domains/copy/domain.oracle.server.ts", VALID_SOURCE);
      await expect(discoverOracleModules(root)).rejects.toThrow("Duplicate ORACLE_MARKER");
    });
  });
});

describe("client bundle leak controls (esbuild, browser target)", () => {
  let outRoot: string;
  let leakyHits: MarkerHit[];
  let cleanHits: MarkerHit[];

  const bundle = async (entry: string): Promise<string> => {
    const outdir = path.join(outRoot, path.basename(entry, ".ts"));
    await build({
      entryPoints: [path.join(FIXTURES, entry)],
      outdir,
      bundle: true,
      platform: "browser",
      format: "esm",
      minify: true,
      sourcemap: true,
      // Simulates a bundler that does not enforce `server-only`, so the scanner is the last line of defence.
      alias: { "server-only": EMPTY_MODULE },
      logLevel: "silent",
    });
    return outdir;
  };

  beforeAll(async () => {
    outRoot = await mkdtemp(path.join(os.tmpdir(), "oracle-leak-"));
    leakyHits = await scanForMarkers(await bundle("leaky-client.ts"), [FIXTURE_MARKER]);
    cleanHits = await scanForMarkers(await bundle("clean-client.ts"), [FIXTURE_MARKER]);
  });
  afterAll(async () => {
    await rm(outRoot, { recursive: true, force: true });
  });

  it("negative control: detects the marker in minified JS when a client imports an oracle", () => {
    const leakedFiles = leakyHits.map((hit) => path.basename(hit.file));
    expect(leakedFiles).toContain("leaky-client.js");
    expect(leakyHits.every((hit) => hit.marker === FIXTURE_MARKER)).toBe(true);
  });

  it("positive control: reports nothing for a client with no oracle import", () => {
    expect(cleanHits).toEqual([]);
  });
});

describe("findMarkersInText", () => {
  const prompt = (middle: string): string =>
    `${"You are interviewing an expert reviewer. ".repeat(500)}${middle}${" Ask one question.".repeat(500)}`;

  it("finds a marker embedded in a long prompt", () => {
    expect(findMarkersInText(prompt(`rules: ${FIXTURE_MARKER} ...`), [FIXTURE_MARKER, "oracle:other:00000000000000000"])).toEqual([
      FIXTURE_MARKER,
    ]);
  });

  it("returns nothing when no marker is present", () => {
    expect(findMarkersInText(prompt("case 42: amount=12000"), [FIXTURE_MARKER])).toEqual([]);
  });
});
