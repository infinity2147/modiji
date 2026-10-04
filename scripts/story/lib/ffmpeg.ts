/**
 * ffmpeg for the story videos — NOT a repo dependency. `FFMPEG=/path/to/ffmpeg`, or the static build from the
 * npm registry tarball of @ffmpeg-installer/linux-x64 is fetched into the story cache (the registry is reachable
 * here; GitHub release downloads are not reliable). Playwright's `recordVideo` needs an ffmpeg too: we point
 * PLAYWRIGHT_BROWSERS_PATH at a cache directory that links the installed Chromium headless shell and this ffmpeg,
 * so nothing is installed into ~/.cache.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TARBALL = "https://registry.npmjs.org/@ffmpeg-installer/linux-x64/-/linux-x64-4.1.0.tgz";

export function ensureFfmpeg(cacheDir: string): string {
  if (process.env.FFMPEG !== undefined) return process.env.FFMPEG;
  const dir = join(cacheDir, "ffmpeg");
  const bin = join(dir, "package/ffmpeg");
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  execFileSync("sh", ["-c", `curl -4 -sSfL -o ff.tgz "${TARBALL}" && tar xzf ff.tgz && rm ff.tgz`], { cwd: dir, stdio: "inherit" });
  return bin;
}

/** A browsers directory for Playwright: the already-installed headless shell + our ffmpeg as Playwright's video encoder. */
export function playwrightBrowsers(cacheDir: string, ffmpeg: string): string {
  const dir = join(cacheDir, "pw-browsers");
  const installed = join(process.env.PLAYWRIGHT_INSTALLED ?? join(homedir(), ".cache/ms-playwright"));
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(installed).filter((n) => n.startsWith("chromium"))) {
    const link = join(dir, name);
    if (!existsSync(link)) symlinkSync(join(installed, name), link);
  }
  // Playwright 1.63 looks for ffmpeg-1011/ffmpeg-linux.
  const ffdir = join(dir, "ffmpeg-1011");
  mkdirSync(ffdir, { recursive: true });
  if (!existsSync(join(ffdir, "ffmpeg-linux"))) symlinkSync(ffmpeg, join(ffdir, "ffmpeg-linux"));
  return dir;
}

export function durationOf(ffmpeg: string, file: string): number {
  let out = "";
  try {
    execFileSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    out = String((error as { stderr?: string }).stderr ?? "");
  }
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(out);
  if (m === null) throw new Error(`cannot read the duration of ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function run(ffmpeg: string, args: string[]): void {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
}
