/** Repo paths and small file helpers shared by the story scripts (deck, demo video, tech video). */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const EVIDENCE = join(REPO, "docs/evidence");
export const DECK_DIR = join(REPO, "docs/deck");
export const VIDEO_DIR = join(REPO, "docs/video");

/** Repo-relative path (what speaker notes and slides cite). */
export const rel = (abs: string): string => relative(REPO, abs);
export const readText = (abs: string): string => readFileSync(abs, "utf8");
export const readJson = <T>(abs: string): T => JSON.parse(readFileSync(abs, "utf8")) as T;
export const sha256 = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex");

/** A PNG/SVG as a data URI, so the deck stays one self-contained file. */
export function dataUri(abs: string): string {
  const ext = abs.slice(abs.lastIndexOf(".") + 1).toLowerCase();
  const mime = ext === "svg" ? "image/svg+xml" : ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream";
  return `data:${mime};base64,${readFileSync(abs).toString("base64")}`;
}

let trackedFiles: Set<string> | undefined;
/** Repo-relative paths git tracks: evidence must be committed, not a file someone is still writing. */
export function isTracked(abs: string): boolean {
  trackedFiles ??= new Set(execFileSync("git", ["ls-files", "docs", "PROGRESS.md", "plan.md"], { cwd: REPO, encoding: "utf8" }).split("\n"));
  return trackedFiles.has(rel(abs));
}

/** The newest COMMITTED file in `dir` whose name matches `pattern` (names sort by their ISO timestamp). */
export function newest(dir: string, pattern: RegExp, accept: (abs: string) => boolean = () => true): string {
  const names = readdirSync(dir)
    .filter((n) => pattern.test(n) && isTracked(join(dir, n)))
    .sort()
    .reverse();
  for (const n of names) {
    const abs = join(dir, n);
    if (accept(abs)) return abs;
  }
  throw new Error(`no file matching ${pattern} in ${rel(dir)}`);
}

export function must(abs: string): string {
  if (!existsSync(abs)) throw new Error(`missing evidence file: ${rel(abs)}`);
  return abs;
}

/** First regex capture in a text, or a loud failure naming the file (never a silent default). */
export function grab(text: string, re: RegExp, file: string): string[] {
  const m = re.exec(text);
  if (m === null) throw new Error(`pattern ${re} not found in ${file}`);
  return m.slice(1).map((x) => x ?? "");
}

/** A file as committed at HEAD (PROGRESS.md is edited continuously; the story cites only what is committed). */
export function readCommitted(relPath: string): string {
  return execFileSync("git", ["show", `HEAD:${relPath}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
