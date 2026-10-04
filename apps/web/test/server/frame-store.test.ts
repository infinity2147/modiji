import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadServerEnv } from "@vashistha/core/server";
import { createFrameStore, createR2FrameStore, createTieredFrameStore, createVolumeFrameStore, type R2Config } from "../../lib/server/perception/frame-store";

const PNG = (n: number): Uint8Array => new Uint8Array(n).fill(7);
const BUCKET = "vashistha-frames";
const CONFIG: R2Config = { accountId: "0123456789abcdef0123456789abcdef", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", bucket: BUCKET, maxBytes: 10_000 };

type Stored = { bytes: Uint8Array; modified: number };

/** An in-memory stand-in for R2's S3 API: path-style PUT/GET/DELETE and ListObjectsV2 with paging. */
function fakeR2(options: { pageSize?: number; failDeletes?: boolean } = {}) {
  const objects = new Map<string, Stored>();
  const calls: { method: string; url: string; authorization: string | null }[] = [];
  let clock = 1_700_000_000_000;
  const handler = async (input: Request | string | URL): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input);
    const url = new URL(request.url);
    calls.push({ method: request.method, url: request.url, authorization: request.headers.get("authorization") });
    const prefix = `/${BUCKET}/`;
    if (request.method === "GET" && url.pathname === `/${BUCKET}` && url.searchParams.get("list-type") === "2") {
      const all = [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const start = Number(url.searchParams.get("continuation-token") ?? "0");
      const size = options.pageSize ?? 1000;
      const page = all.slice(start, start + size);
      const more = start + size < all.length;
      const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + size}</NextContinuationToken>` : ""}${page
        .map(([key, v]) => `<Contents><Key>${key}</Key><LastModified>${new Date(v.modified).toISOString()}</LastModified><Size>${v.bytes.byteLength}</Size></Contents>`)
        .join("")}</ListBucketResult>`;
      return new Response(xml, { status: 200, headers: { "Content-Type": "application/xml" } });
    }
    if (!url.pathname.startsWith(prefix)) return new Response("bad path", { status: 400 });
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    if (request.method === "PUT") {
      objects.set(key, { bytes: new Uint8Array(await request.arrayBuffer()), modified: (clock += 1000) });
      return new Response(null, { status: 200 });
    }
    if (request.method === "GET") {
      const hit = objects.get(key);
      return hit === undefined ? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }) : new Response(hit.bytes.slice(), { status: 200 });
    }
    if (request.method === "DELETE") {
      if (options.failDeletes === true) return new Response("nope", { status: 500 });
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response("unsupported", { status: 405 });
  };
  return { objects, calls, fetch: handler as typeof fetch };
}

const quiet = { info: vi.fn(), warn: vi.fn() };
const ids = () => ({ sessionId: randomUUID(), frameId: randomUUID() });
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("R2 frame store", () => {
  it("puts, gets and removes a frame with a SigV4 signature for region auto and service s3", async () => {
    const r2 = fakeR2();
    const store = createR2FrameStore(CONFIG, { fetch: r2.fetch, log: quiet });
    const { sessionId, frameId } = ids();
    await store.put(sessionId, frameId, PNG(100));
    const put = r2.calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe(`https://${CONFIG.accountId}.r2.cloudflarestorage.com/${BUCKET}/${sessionId}/frames/${frameId}.png`);
    expect(put?.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.*, Signature=[0-9a-f]{64}$/);
    expect(put?.authorization).not.toContain(CONFIG.secretAccessKey);
    expect(Buffer.from((await store.get(sessionId, frameId)) ?? new Uint8Array())).toEqual(Buffer.from(PNG(100)));
    await store.remove(sessionId, frameId);
    expect(await store.get(sessionId, frameId)).toBeNull();
    await store.remove(sessionId, frameId);
  });

  it("refuses ids that are not UUIDs before any request", async () => {
    const r2 = fakeR2();
    const store = createR2FrameStore(CONFIG, { fetch: r2.fetch, log: quiet });
    await expect(store.put("../x", randomUUID(), PNG(1))).rejects.toBeInstanceOf(RangeError);
    await expect(store.get(randomUUID(), "a/b")).rejects.toBeInstanceOf(RangeError);
    expect(r2.calls).toHaveLength(0);
  });

  it("reports failures by operation and status without leaking keys, URLs or credentials", async () => {
    const store = createR2FrameStore(CONFIG, { fetch: (async () => new Response("denied", { status: 403 })) as typeof fetch, log: quiet });
    const { sessionId, frameId } = ids();
    await expect(store.put(sessionId, frameId, PNG(1))).rejects.toThrow(/^R2 put failed: HTTP 403$/);
    await expect(store.get(sessionId, frameId)).rejects.toThrow(/^R2 get failed: HTTP 403$/);
  });

  it("probes with a real write, read and delete and leaves no object behind", async () => {
    const r2 = fakeR2();
    const store = createR2FrameStore(CONFIG, { fetch: r2.fetch, log: quiet });
    expect(await store.probe()).toMatchObject({ ok: true });
    expect(r2.objects.size).toBe(0);
    const broken = createR2FrameStore(CONFIG, { fetch: (async () => new Response("x", { status: 500 })) as typeof fetch, log: quiet });
    expect(await broken.probe()).toEqual({ ok: false, error: "R2 put failed: HTTP 500" });
  });

  describe("retention cap", () => {
    it("counts the bucket once, then stays under the cap without deleting anything", async () => {
      const r2 = fakeR2();
      const store = createR2FrameStore({ ...CONFIG, maxBytes: 10_000 }, { fetch: r2.fetch, log: quiet });
      for (let i = 0; i < 5; i += 1) await store.put(randomUUID(), randomUUID(), PNG(1000));
      await settle();
      expect(store.stats()).toMatchObject({ backend: "r2", usedBytes: 5000, capBytes: 10_000, prunes: 0 });
      expect(r2.objects.size).toBe(5);
    });

    it("at the cap deletes the oldest half of the bytes and keeps the newest frames", async () => {
      const r2 = fakeR2({ pageSize: 3 });
      const store = createR2FrameStore({ ...CONFIG, maxBytes: 10_000 }, { fetch: r2.fetch, log: quiet });
      const written: { sessionId: string; frameId: string }[] = [];
      for (let i = 0; i < 10; i += 1) {
        const id = ids();
        written.push(id);
        await store.put(id.sessionId, id.frameId, PNG(1000));
        await settle();
      }
      const stats = store.stats();
      expect(stats.prunes).toBe(1);
      expect(stats.lastPrune).toMatchObject({ deleted: 5, freedBytes: 5000, remainingBytes: 5000 });
      expect(stats.usedBytes).toBe(5000);
      expect(r2.objects.size).toBe(5);
      for (const old of written.slice(0, 5)) expect(await store.get(old.sessionId, old.frameId)).toBeNull();
      for (const recent of written.slice(5)) expect(await store.get(recent.sessionId, recent.frameId)).not.toBeNull();
      expect(quiet.info).toHaveBeenCalledWith(expect.stringContaining("deleted the 5 oldest frames"));
    });

    it("starts from the real bucket total, so a restart does not forget what is stored", async () => {
      const r2 = fakeR2();
      const first = createR2FrameStore({ ...CONFIG, maxBytes: 100_000 }, { fetch: r2.fetch, log: quiet });
      for (let i = 0; i < 4; i += 1) await first.put(randomUUID(), randomUUID(), PNG(2000));
      await settle();
      const restarted = createR2FrameStore({ ...CONFIG, maxBytes: 10_000 }, { fetch: r2.fetch, log: quiet });
      await restarted.put(randomUUID(), randomUUID(), PNG(2500));
      await settle();
      expect(restarted.stats().prunes).toBe(1);
      expect(restarted.stats().usedBytes).toBeLessThanOrEqual(5250);
    });

    it("ignores objects that are not frames, and a failed deletion is logged and retried later, never thrown", async () => {
      const r2 = fakeR2({ failDeletes: true });
      r2.objects.set("notes/readme.txt", { bytes: PNG(50_000), modified: 1 });
      const warn = vi.fn();
      const store = createR2FrameStore({ ...CONFIG, maxBytes: 3000 }, { fetch: r2.fetch, log: { info: vi.fn(), warn } });
      for (let i = 0; i < 4; i += 1) await store.put(randomUUID(), randomUUID(), PNG(1000));
      await settle();
      expect(r2.objects.has("notes/readme.txt")).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("deletions failed"));
      expect(r2.objects.size).toBe(5);
    });

    it("a listing failure only logs; the frame write still succeeded", async () => {
      const warn = vi.fn();
      const inner = fakeR2();
      const flaky = (async (input: Request) => (new URL(input.url).searchParams.has("list-type") ? new Response("x", { status: 500 }) : inner.fetch(input))) as typeof fetch;
      const store = createR2FrameStore(CONFIG, { fetch: flaky, log: { info: vi.fn(), warn } });
      await expect(store.put(randomUUID(), randomUUID(), PNG(10))).resolves.toBeUndefined();
      await settle();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("retention pass failed: R2 list failed: HTTP 500"));
      expect(inner.objects.size).toBe(1);
    });
  });
});

describe("tiered and configured stores", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "vashistha-frames-"));
    dirs.push(dir);
    return dir;
  };

  it("writes new frames to R2 only, and still reads and removes frames written to the volume earlier", async () => {
    const volume = createVolumeFrameStore(tmp());
    const r2 = fakeR2();
    const store = createTieredFrameStore(createR2FrameStore(CONFIG, { fetch: r2.fetch, log: quiet }), volume);
    const old = ids();
    await volume.put(old.sessionId, old.frameId, PNG(30));
    const fresh = ids();
    await store.put(fresh.sessionId, fresh.frameId, PNG(40));
    expect(await volume.get(fresh.sessionId, fresh.frameId)).toBeNull();
    expect(r2.objects.size).toBe(1);
    expect((await store.get(old.sessionId, old.frameId))?.byteLength).toBe(30);
    expect((await store.get(fresh.sessionId, fresh.frameId))?.byteLength).toBe(40);
    await store.remove(old.sessionId, old.frameId);
    expect(await store.get(old.sessionId, old.frameId)).toBeNull();
  });

  it("uses the volume alone unless all four R2 variables are set", () => {
    const base = { DATA_DIR: tmp(), R2_MAX_BYTES: 2_000_000_000 };
    expect(createFrameStore(base).backend).toBe("volume");
    expect(createFrameStore({ ...base, R2_ACCOUNT_ID: CONFIG.accountId, R2_ACCESS_KEY_ID: CONFIG.accessKeyId, R2_SECRET_ACCESS_KEY: CONFIG.secretAccessKey, R2_BUCKET: BUCKET }, { log: quiet }).backend).toBe("r2");
    expect(createFrameStore({ ...base, R2_BUCKET: BUCKET }).backend).toBe("volume");
  });
});

describe("R2 environment variables", () => {
  const base = { NODE_ENV: "test", PUBLIC_BASE_URL: "http://localhost:3000", DATA_DIR: "/tmp/x" };
  const all = { R2_ACCOUNT_ID: CONFIG.accountId, R2_ACCESS_KEY_ID: CONFIG.accessKeyId, R2_SECRET_ACCESS_KEY: CONFIG.secretAccessKey, R2_BUCKET: BUCKET };

  it("defaults the cap to 2 GB and accepts an override", () => {
    expect(loadServerEnv({ ...base }).R2_MAX_BYTES).toBe(2_000_000_000);
    expect(loadServerEnv({ ...base, ...all, R2_MAX_BYTES: "5000000" }).R2_MAX_BYTES).toBe(5_000_000);
  });

  it("rejects a partial R2 configuration, naming the missing variables but never a value", () => {
    const error = (() => {
      try {
        loadServerEnv({ ...base, R2_ACCOUNT_ID: CONFIG.accountId, R2_ACCESS_KEY_ID: CONFIG.accessKeyId });
      } catch (e) {
        return e as Error & { variables: string[] };
      }
      throw new Error("expected an EnvError");
    })();
    expect(error.variables).toEqual(["R2_SECRET_ACCESS_KEY", "R2_BUCKET"]);
    expect(error.message).not.toContain(CONFIG.accessKeyId);
    expect(error.message).not.toContain(CONFIG.accountId);
  });

  it("rejects a malformed account id, bucket name or cap", () => {
    expect(() => loadServerEnv({ ...base, ...all, R2_ACCOUNT_ID: "nope" })).toThrow(/R2_ACCOUNT_ID/);
    expect(() => loadServerEnv({ ...base, ...all, R2_BUCKET: "Bad_Bucket" })).toThrow(/R2_BUCKET/);
    expect(() => loadServerEnv({ ...base, ...all, R2_MAX_BYTES: "12" })).toThrow(/R2_MAX_BYTES/);
  });
});
