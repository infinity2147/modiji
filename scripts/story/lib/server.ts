/**
 * A LOCAL production server of the committed tree for recording and measuring — never the deployed one.
 *
 * `prepareTree()` exports HEAD with `git archive` into a cache directory outside the repo, installs from the
 * offline pnpm store and runs `next build` there, so a recording never picks up another engineer's
 * uncommitted work and never writes build output into the repo. `startServer()` runs `server.ts` from
 * that tree with NODE_ENV=production, a fresh DATA_DIR, placeholder secrets that satisfy env validation,
 * and LLM_CALLS=off (no model client exists, so no model call can happen).
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "./repo";

export const OPERATOR_SECRET = "story-local-operator-secret-0123456789abcdef";
export const MCP_TOKEN = "story-local-mcp-token-0123456789abcdef";

export function headCommit(): string {
  return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
}

/** A built copy of HEAD (or `STORY_TREE`, an already-built tree). Cached per commit under STORY_CACHE or the OS temp dir. */
export function prepareTree(): { dir: string; commit: string } {
  if (process.env.STORY_TREE !== undefined) {
    const marker = join(process.env.STORY_TREE, ".story-commit");
    return { dir: process.env.STORY_TREE, commit: existsSync(marker) ? readFileSync(marker, "utf8").trim() : "unknown" };
  }
  const commit = headCommit();
  const dir = join(process.env.STORY_CACHE ?? join(tmpdir(), "vashistha-story"), `tree-${commit}`);
  const built = join(dir, "apps/web/.next/BUILD_ID");
  if (existsSync(built)) return { dir, commit };
  mkdirSync(dir, { recursive: true });
  console.info(`story: exporting HEAD ${commit} → ${dir}`);
  execFileSync("sh", ["-c", `git archive HEAD | tar -x -C "${dir}"`], { cwd: REPO, stdio: "inherit" });
  execFileSync("pnpm", ["install", "--offline", "--frozen-lockfile"], { cwd: dir, stdio: "inherit" });
  const tesseract = join(REPO, "apps/web/public/tesseract");
  if (existsSync(tesseract)) cpSync(tesseract, join(dir, "apps/web/public/tesseract"), { recursive: true });
  else execFileSync("pnpm", ["--filter", "@vashistha/web", "vendor:tesseract"], { cwd: dir, stdio: "inherit" });
  execFileSync("pnpm", ["--filter", "@vashistha/web", "build"], { cwd: dir, stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  writeFileSync(join(dir, ".story-commit"), `${commit}\n`);
  return { dir, commit };
}

export type LocalServer = { baseUrl: string; dataDir: string; commit: string; stop: () => Promise<void> };

/** Starts `server.ts` from a built tree on `port` with a fresh DATA_DIR (optionally pre-seeded with replay bundles). */
export async function startServer(opts: { tree: { dir: string; commit: string }; port: number; replays?: string[]; log?: string }): Promise<LocalServer> {
  const dataDir = mkdtempSync(join(tmpdir(), "vashistha-story-data-"));
  for (const bundle of opts.replays ?? []) {
    const name = bundle.slice(bundle.lastIndexOf("/") + 1);
    cpSync(bundle, join(dataDir, "replays", name), { recursive: true });
  }
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(opts.port),
    DATA_DIR: dataDir,
    PUBLIC_BASE_URL: "https://story-local.invalid",
    CUSTOM_LLM_SECRET: OPERATOR_SECRET,
    ANTHROPIC_API_KEY: "story-placeholder-not-a-key",
    ELEVENLABS_API_KEY: "story-placeholder-not-a-key",
    MCP_BEARER_TOKEN: MCP_TOKEN,
    LLM_CALLS: "off",
    GIT_COMMIT: opts.tree.commit,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const child: ChildProcess = spawn("npx", ["tsx", "server.ts"], { cwd: join(opts.tree.dir, "apps/web"), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const lines: string[] = [];
  const keep = (b: Buffer): void => {
    lines.push(b.toString());
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const baseUrl = `http://127.0.0.1:${opts.port}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`local server did not start:\n${lines.join("")}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    baseUrl,
    dataDir,
    commit: opts.tree.commit,
    stop: async () => {
      if (opts.log !== undefined) writeFileSync(opts.log, lines.join(""));
      if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    },
  };
}
