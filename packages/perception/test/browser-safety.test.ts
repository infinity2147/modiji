import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "../src");

/** Module specifiers imported (statically or dynamically) by a TypeScript source file. */
function specifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map((m) => m[1] ?? "");
}

/** Every specifier reachable from `entry` through relative imports. */
function graph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    const deps = specifiers(file);
    seen.set(file, deps);
    for (const d of deps) if (d.startsWith(".")) visit(join(file, "..", `${d}.ts`));
  };
  visit(entry);
  return seen;
}

describe("browser-safe entry (@vashistha/perception)", () => {
  it("never reaches node: modules, the server wrapper or an oracle", () => {
    const modules = graph(join(SRC, "index.ts"));
    expect([...modules.keys()].map((f) => f.slice(SRC.length + 1)).sort()).toEqual([
      "change-detector.ts",
      "evaluation.ts",
      "image.ts",
      "index.ts",
      "privacy.ts",
      "queue.ts",
    ]);
    for (const [file, deps] of modules)
      for (const d of deps) {
        expect(d.startsWith("node:"), `${file} imports ${d}`).toBe(false);
        expect(d, `${file} imports ${d}`).not.toMatch(/@vashistha\/core\/server|oracle|server-only/);
      }
  });
});
