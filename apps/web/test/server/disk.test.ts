import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usageBreakdown, volumeRoot, volumeStats } from "../../lib/server/disk";

const MB = 1024 * 1024;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "disk-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(rel: string, bytes: number): Promise<void> {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(bytes, 1));
}

describe("usageBreakdown", () => {
  it("sums each top-level entry, largest first, and lists the biggest files", async () => {
    await put("old-ledger/vashistha.db", 3 * MB);
    await put("old-ledger/media/frames/a.png", 1 * MB);
    await put("demo-1/vashistha.db", 1 * MB);
    await put("stray.log", Math.floor(0.5 * MB));

    const r = await usageBreakdown(root);
    expect(r.entries.map((e) => e.path)).toEqual(["old-ledger", "demo-1", "stray.log"]);
    expect(r.entries[0]).toEqual({ path: "old-ledger", mb: 4, files: 2 });
    expect(r.entries[1]).toEqual({ path: "demo-1", mb: 1, files: 1 });
    expect(r.largestFiles[0]).toEqual({ path: path.join("old-ledger", "vashistha.db"), mb: 3 });
    expect(r.truncated).toBe(false);
  });

  it("does not follow symlinks, so a link out of the volume is never counted", async () => {
    await put("real/file.bin", 1 * MB);
    const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
    try {
      await writeFile(path.join(outside, "huge.bin"), Buffer.alloc(5 * MB));
      await symlink(outside, path.join(root, "link"));
      const r = await usageBreakdown(root);
      expect(r.entries.find((e) => e.path === "link")).toEqual({ path: "link", mb: 0, files: 0 });
      expect(r.entries.find((e) => e.path === "real")?.mb).toBe(1);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("stops at the file limit and says the totals are a lower bound", async () => {
    for (let i = 0; i < 12; i += 1) await put(`d/f${i}.bin`, 1024);
    const r = await usageBreakdown(root, { maxFiles: 5, deadlineMs: 10_000, topFiles: 3 });
    expect(r.truncated).toBe(true);
    expect(r.entries[0]?.files).toBeLessThanOrEqual(5);
    expect(r.largestFiles.length).toBeLessThanOrEqual(3);
  });

  it("stops at the deadline", async () => {
    await put("a/f.bin", 1024);
    let t = 0;
    const clock = () => (t += 10_000);
    const r = await usageBreakdown(root, { maxFiles: 1000, deadlineMs: 5_000, topFiles: 5 }, clock);
    expect(r.truncated).toBe(true);
  });

  it("returns an empty report for a folder that does not exist", async () => {
    const r = await usageBreakdown(path.join(root, "missing"));
    expect(r).toMatchObject({ entries: [], largestFiles: [], truncated: false });
  });
});

describe("volumeStats and volumeRoot", () => {
  it("reports capacity for an existing folder with consistent numbers", () => {
    const s = volumeStats(root);
    expect(s).not.toBeNull();
    expect(s!.totalMB).toBeGreaterThan(0);
    expect(s!.freeMB).toBeGreaterThanOrEqual(0);
    expect(s!.freeMB).toBeLessThanOrEqual(s!.totalMB);
    expect(s!.usedPct).toBeGreaterThanOrEqual(0);
    expect(s!.usedPct).toBeLessThanOrEqual(100);
  });

  it("returns null instead of throwing for a path that does not exist", () => {
    expect(volumeStats(path.join(root, "nope", "nowhere"))).toBeNull();
  });

  it("uses the host's volume mount when it is set, otherwise the data directory", () => {
    expect(volumeRoot("/data/demo-20261004", "/data")).toBe("/data");
    expect(volumeRoot("/data/demo-20261004", undefined)).toBe("/data/demo-20261004");
    expect(volumeRoot("/data/demo-20261004", "")).toBe("/data/demo-20261004");
  });
});
