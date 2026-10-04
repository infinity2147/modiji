/**
 * Disk visibility for the persistent volume (Railway mounts it at `/data`; SQLite and stored media live on it). A full
 * volume makes every ledger write fail, so sign-in and every capture stop, and nothing used to warn before that.
 * `volumeStats` is cheap and rides on `/api/health/deep`; `usageBreakdown` is the on-demand "what is using it" report.
 */
import { lstat, readdir } from "node:fs/promises";
import { statfsSync } from "node:fs";
import path from "node:path";

const MB = 1024 * 1024;

export type VolumeStats = { totalMB: number; freeMB: number; usedPct: number };

/** Capacity of the filesystem holding `dir`, or null when the platform cannot say. */
export function volumeStats(dir: string): VolumeStats | null {
  try {
    const s = statfsSync(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    if (total <= 0) return null;
    return { totalMB: round1(total / MB), freeMB: round1(free / MB), usedPct: round1(((total - free) / total) * 100) };
  } catch {
    return null;
  }
}

export type UsageEntry = { path: string; mb: number; files: number };
export type UsageReport = {
  root: string;
  /** Top-level folders and files under `root`, largest first. */
  entries: UsageEntry[];
  /** The biggest single files anywhere under `root`. */
  largestFiles: { path: string; mb: number }[];
  /** True when the walk stopped at a limit, so the totals are a lower bound. */
  truncated: boolean;
};

export type UsageLimits = { maxFiles: number; deadlineMs: number; topFiles: number };
export const DEFAULT_USAGE_LIMITS: UsageLimits = { maxFiles: 200_000, deadlineMs: 8_000, topFiles: 15 };

/** `du`-style breakdown of `root` by its immediate children. Read-only, async, and bounded by file count and time. */
export async function usageBreakdown(root: string, limits: UsageLimits = DEFAULT_USAGE_LIMITS, now: () => number = Date.now): Promise<UsageReport> {
  const started = now();
  let seen = 0;
  let truncated = false;
  const biggest: { path: string; bytes: number }[] = [];

  const stop = (): boolean => {
    if (seen >= limits.maxFiles || now() - started > limits.deadlineMs) {
      truncated = true;
      return true;
    }
    return false;
  };

  const keepBiggest = (file: string, bytes: number): void => {
    biggest.push({ path: file, bytes });
    biggest.sort((a, b) => b.bytes - a.bytes);
    if (biggest.length > limits.topFiles) biggest.length = limits.topFiles;
  };

  /** Total bytes and file count under `target` (symlinks are not followed). */
  async function walk(target: string): Promise<{ bytes: number; files: number }> {
    if (stop()) return { bytes: 0, files: 0 };
    let info;
    try {
      info = await lstat(target);
    } catch {
      return { bytes: 0, files: 0 };
    }
    if (info.isSymbolicLink()) return { bytes: 0, files: 0 };
    if (!info.isDirectory()) {
      seen += 1;
      keepBiggest(target, info.size);
      return { bytes: info.size, files: 1 };
    }
    let names: string[];
    try {
      names = await readdir(target);
    } catch {
      return { bytes: 0, files: 0 };
    }
    let bytes = 0;
    let files = 0;
    for (const name of names) {
      const child = await walk(path.join(target, name));
      bytes += child.bytes;
      files += child.files;
    }
    return { bytes, files };
  }

  const children = await readdir(root).catch(() => [] as string[]);
  const entries: UsageEntry[] = [];
  for (const name of children) {
    const total = await walk(path.join(root, name));
    entries.push({ path: name, mb: round1(total.bytes / MB), files: total.files });
  }
  entries.sort((a, b) => b.mb - a.mb);
  return {
    root,
    entries,
    largestFiles: biggest.map((f) => ({ path: path.relative(root, f.path), mb: round1(f.bytes / MB) })),
    truncated,
  };
}

/**
 * The folder to report on: the volume mount when the host says where it is (Railway sets `RAILWAY_VOLUME_MOUNT_PATH`),
 * so data left in sibling folders is visible too; otherwise just the data directory.
 */
export function volumeRoot(dataDir: string, mountPath: string | undefined): string {
  return mountPath !== undefined && mountPath !== "" ? path.resolve(mountPath) : path.resolve(dataDir);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
