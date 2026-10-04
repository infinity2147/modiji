/**
 * Where redacted frames live. `volume` keeps them under DATA_DIR/media (see storage.ts); `r2` keeps them in a private
 * Cloudflare R2 bucket so they stop filling the Railway volume. With R2 configured, new frames go to the bucket and
 * reads fall back to the volume for frames written before the switch. The bucket is never public: the media route
 * still checks the session and the ledger before it reads anything.
 *
 * Retention: the bucket is capped (`maxBytes`, 2 GB by default). When the stored frames reach the cap, the oldest
 * objects are deleted until about half of the bytes remain. This is by age alone: a frame that a confirmed rule
 * cites can be deleted too, and its evidence link then shows the frame as gone.
 */
import { AwsClient } from "aws4fetch";
import { randomUUID } from "node:crypto";
import { frameMediaPath } from "../../contracts/frames";
import { isUuid, readFrame, removeFrame, writeFrame } from "./storage";

export type ProbeResult = { ok: true; ms: number } | { ok: false; error: string };

export type PruneRecord = { at: number; deleted: number; freedBytes: number; remainingBytes: number };
export type FrameStoreStats = {
  backend: "volume" | "r2";
  /** Bytes in the bucket as of the last count; null for the volume or before the first count. */
  usedBytes: number | null;
  capBytes: number | null;
  prunes: number;
  lastPrune: PruneRecord | null;
};

export type FrameStore = {
  readonly backend: "volume" | "r2";
  put(sessionId: string, frameId: string, png: Uint8Array): Promise<void>;
  /** The stored PNG, or null when there is no such frame. */
  get(sessionId: string, frameId: string): Promise<Uint8Array | null>;
  /** Missing frames are fine. */
  remove(sessionId: string, frameId: string): Promise<void>;
  /** A write, read and delete of a throwaway object; the volume backend is covered by the DATA_DIR check. */
  probe(): Promise<ProbeResult>;
  stats(): FrameStoreStats;
};

export function createVolumeFrameStore(dataDir: string): FrameStore {
  return {
    backend: "volume",
    put: async (sessionId, frameId, png) => void (await writeFrame(dataDir, sessionId, frameId, png)),
    get: (sessionId, frameId) => readFrame(dataDir, sessionId, frameId),
    remove: (sessionId, frameId) => removeFrame(dataDir, sessionId, frameId),
    probe: async () => ({ ok: true, ms: 0 }),
    stats: () => ({ backend: "volume", usedBytes: null, capBytes: null, prunes: 0, lastPrune: null }),
  };
}

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint?: string | undefined;
  /** Cap on stored frame bytes; the oldest half is deleted when it is reached. */
  maxBytes: number;
};

export type R2Options = { fetch?: typeof fetch; now?: () => number; log?: Pick<Console, "info" | "warn"> };

const REQUEST_TIMEOUT_MS = 15_000;
const PROBE_BYTES = new Uint8Array([0x76, 0x61, 0x73, 0x68]);
/** Bytes counted since the last full listing after which the next put lists again, to correct drift. */
const RESYNC_EVERY_BYTES = 64 * 1024 * 1024;
const DELETE_CONCURRENCY = 8;
/** Share of the stored bytes a prune removes, oldest first. */
const PRUNE_FRACTION = 0.5;
const FRAME_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/frames\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;

type Listed = { key: string; size: number; modified: number };

/** The frame objects in one ListObjectsV2 XML page. Keys here are server-made UUID paths, so no XML escapes occur. */
function parseListing(xml: string): { items: Listed[]; next: string | null } {
  const items: Listed[] = [];
  for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = block[1] ?? "";
    const key = /<Key>([^<]*)<\/Key>/.exec(body)?.[1];
    const size = Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1]);
    const modified = Date.parse(/<LastModified>([^<]*)<\/LastModified>/.exec(body)?.[1] ?? "");
    if (key !== undefined && FRAME_KEY.test(key) && Number.isFinite(size) && Number.isFinite(modified)) items.push({ key, size, modified });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { items, next: truncated && next !== undefined ? next : null };
}

/** Cloudflare R2 over its S3-compatible API (SigV4, region `auto`, path-style URLs), capped at `config.maxBytes`. */
export function createR2FrameStore(config: R2Config, options: R2Options = {}): FrameStore {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? console;
  const endpoint = (config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, "");
  const client = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: "s3", region: "auto", retries: 2 });
  const url = (key: string): string => `${endpoint}/${config.bucket}/${key}`;

  /** The error names the operation and HTTP status only; never a key, URL or credential. */
  async function send(operation: string, target: string, init: RequestInit): Promise<Response> {
    const signed = await client.sign(target, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const response = await fetchImpl(signed);
    if (response.ok || (response.status === 404 && operation !== "put" && operation !== "list")) return response;
    void response.body?.cancel();
    throw new Error(`R2 ${operation} failed: HTTP ${response.status}`);
  }

  const frameKey = (sessionId: string, frameId: string): string => {
    if (!isUuid(sessionId) || !isUuid(frameId)) throw new RangeError("session and frame ids must be lower-case UUIDs");
    return frameMediaPath(sessionId, frameId);
  };

  async function put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const response = await send("put", url(key), { method: "PUT", headers: { "Content-Type": contentType }, body: new Blob([bytes.slice()], { type: contentType }) });
    void response.body?.cancel();
  }

  async function get(key: string): Promise<Uint8Array | null> {
    const response = await send("get", url(key), { method: "GET" });
    if (response.status === 404) {
      void response.body?.cancel();
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async function remove(key: string): Promise<void> {
    const response = await send("delete", url(key), { method: "DELETE" });
    void response.body?.cancel();
  }

  async function listFrames(): Promise<Listed[]> {
    const all: Listed[] = [];
    let token: string | null = null;
    do {
      const query = `list-type=2&max-keys=1000${token === null ? "" : `&continuation-token=${encodeURIComponent(token)}`}`;
      const response = await send("list", `${endpoint}/${config.bucket}?${query}`, { method: "GET" });
      const page = parseListing(await response.text());
      all.push(...page.items);
      token = page.next;
    } while (token !== null);
    return all;
  }

  // Retention state. `usedBytes` is the last full count plus bytes written since.
  let usedBytes: number | null = null;
  let bytesSinceCount = 0;
  let prunes = 0;
  let lastPrune: PruneRecord | null = null;
  let working: Promise<void> | null = null;

  /** Lists the bucket for the true total and, at or over the cap, deletes the oldest objects until about half remain. */
  async function countAndPrune(): Promise<void> {
    const frames = await listFrames();
    let total = frames.reduce((sum, f) => sum + f.size, 0);
    usedBytes = total;
    bytesSinceCount = 0;
    if (total < config.maxBytes) return;
    const target = total * (1 - PRUNE_FRACTION);
    const oldestFirst = [...frames].sort((a, b) => a.modified - b.modified || (a.key < b.key ? -1 : 1));
    const doomed: Listed[] = [];
    let freed = 0;
    for (const f of oldestFirst) {
      if (total - freed <= target) break;
      doomed.push(f);
      freed += f.size;
    }
    let deleted = 0;
    let deletedBytes = 0;
    for (let i = 0; i < doomed.length; i += DELETE_CONCURRENCY) {
      const batch = doomed.slice(i, i + DELETE_CONCURRENCY);
      const results = await Promise.allSettled(batch.map((f) => remove(f.key)));
      results.forEach((r, index) => {
        if (r.status === "fulfilled") {
          deleted += 1;
          deletedBytes += batch[index]?.size ?? 0;
        }
      });
    }
    total -= deletedBytes;
    usedBytes = total;
    prunes += 1;
    lastPrune = { at: now(), deleted, freedBytes: deletedBytes, remainingBytes: total };
    log.info(`> frames: R2 reached its ${config.maxBytes}-byte cap; deleted the ${deleted} oldest frames (${deletedBytes} bytes), ${total} bytes remain`);
    if (deleted < doomed.length) log.warn(`> frames: ${doomed.length - deleted} frame deletions failed during the prune and will be retried at the next one`);
  }

  /** One pass at a time, never on the request path, and a failure only logs. */
  function schedule(): void {
    if (working !== null) return;
    working = countAndPrune()
      .catch((error: unknown) => log.warn(`> frames: R2 retention pass failed: ${error instanceof Error ? error.message : "unknown error"}`))
      .finally(() => {
        working = null;
      });
  }

  return {
    backend: "r2",
    put: async (sessionId, frameId, png) => {
      await put(frameKey(sessionId, frameId), png, "image/png");
      bytesSinceCount += png.byteLength;
      if (usedBytes === null) schedule();
      else {
        usedBytes += png.byteLength;
        if (usedBytes >= config.maxBytes || bytesSinceCount >= RESYNC_EVERY_BYTES) schedule();
      }
    },
    get: async (sessionId, frameId) => get(frameKey(sessionId, frameId)),
    remove: async (sessionId, frameId) => {
      await remove(frameKey(sessionId, frameId));
    },
    probe: async () => {
      const started = performance.now();
      const key = `probe/${randomUUID()}`;
      try {
        await put(key, PROBE_BYTES, "application/octet-stream");
        const back = await get(key);
        await remove(key);
        if (back === null || Buffer.compare(Buffer.from(back), Buffer.from(PROBE_BYTES)) !== 0) return { ok: false, error: "R2 probe read back different bytes" };
        return { ok: true, ms: Math.round((performance.now() - started) * 10) / 10 };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "R2 probe failed" };
      }
    },
    stats: () => ({ backend: "r2", usedBytes, capBytes: config.maxBytes, prunes, lastPrune }),
  };
}

/** New frames go to `primary`; reads and removals also look in `legacy` for frames written before the switch. */
export function createTieredFrameStore(primary: FrameStore, legacy: FrameStore): FrameStore {
  return {
    backend: primary.backend,
    put: (sessionId, frameId, png) => primary.put(sessionId, frameId, png),
    get: async (sessionId, frameId) => (await primary.get(sessionId, frameId)) ?? (await legacy.get(sessionId, frameId)),
    remove: async (sessionId, frameId) => {
      await primary.remove(sessionId, frameId);
      await legacy.remove(sessionId, frameId);
    },
    probe: () => primary.probe(),
    stats: () => primary.stats(),
  };
}

export type FrameStoreEnv = {
  DATA_DIR: string;
  R2_ACCOUNT_ID?: string | undefined;
  R2_ACCESS_KEY_ID?: string | undefined;
  R2_SECRET_ACCESS_KEY?: string | undefined;
  R2_BUCKET?: string | undefined;
  R2_ENDPOINT?: string | undefined;
  R2_MAX_BYTES: number;
};

/** R2 (with the volume as a read fallback) when all four R2 variables are set, otherwise the volume alone. */
export function createFrameStore(env: FrameStoreEnv, options: R2Options = {}): FrameStore {
  const volume = createVolumeFrameStore(env.DATA_DIR);
  const { R2_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_BUCKET: bucket } = env;
  if (accountId === undefined || accessKeyId === undefined || secretAccessKey === undefined || bucket === undefined) return volume;
  return createTieredFrameStore(createR2FrameStore({ accountId, accessKeyId, secretAccessKey, bucket, endpoint: env.R2_ENDPOINT, maxBytes: env.R2_MAX_BYTES }, options), volume);
}
