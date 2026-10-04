import { describe, expect, it } from "vitest";
import { kycCases } from "@vashistha/core/domains/kyc";
import { createCaseIdTracker, createRedactor, createRgba, type CaseIdTracker, type OcrFn, type OcrWord, type RgbaImage } from "@vashistha/perception";
import { decodePng, encodePng } from "../../../../packages/perception/src/png";
import { FrameMetadataSchema, type PostFrameResponse, type VisionState } from "../../lib/contracts/frames";
import type { FetchFn } from "../../lib/client/api";
import { personNames } from "../../lib/client/capture/browser";
import { CAPTURE_INTERVAL_MS, createCapturePipeline, type FrameGrabber } from "../../lib/client/capture/pipeline";

const SESSION = "6f9c1d52-7d4e-4a54-9a3e-6a3b1c2d3e4f";
const W = 320;
const H = 200;

/** A grey screen with a dark block whose position encodes `variant` (so variants differ to the detector). */
function screen(variant: number): RgbaImage {
  const image = createRgba(W, H);
  image.data.fill(230);
  const x0 = 20 + (variant % 5) * 50;
  for (let y = 40; y < 90; y += 1)
    for (let x = x0; x < x0 + 40; x += 1) {
      const i = (y * W + x) * 4;
      image.data[i] = 20;
      image.data[i + 1] = 20;
      image.data[i + 2] = 20;
    }
  return image;
}

function vision(over: Partial<VisionState> = {}): VisionState {
  return {
    extraction: "unavailable",
    unavailableReason: "no_api_key",
    privacyEpoch: 0,
    offRecord: false,
    lastFrameSeq: 0,
    inFlight: false,
    pendingFrameSeq: null,
    lastAppliedFrameSeq: null,
    counts: { received: 1, applied: 0, coalesced: 0, staleDropped: 0, failed: 0, events: 0, concepts: 0 },
    latencyMs: { captureToEvents: { n: 0, p50: null, p95: null }, receiptToEvents: { n: 0, p50: null, p95: null } },
    lastError: null,
    ...over,
  };
}

type Upload = { url: string; metadata: ReturnType<typeof FrameMetadataSchema.parse>; frame: Blob; crop: Blob | null; signal: AbortSignal | undefined };

/** Each upload waits until the test answers it. */
function uploadServer() {
  const uploads: Upload[] = [];
  const answers: Array<{ resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
  const fetch: FetchFn = async (url, init) => {
    const form = init?.body as FormData;
    const crop = form.get("crop");
    uploads.push({
      url,
      metadata: FrameMetadataSchema.parse(JSON.parse(String(form.get("metadata")))),
      frame: form.get("frame") as Blob,
      crop: crop instanceof Blob ? crop : null,
      signal: init?.signal ?? undefined,
    });
    return new Promise<Response>((resolve, reject) => {
      answers.push({ resolve, reject });
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  };
  const accept = (index: number) => {
    const upload = uploads[index];
    const body: PostFrameResponse = {
      frameId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ledgerId: `entry-${index}`,
      frameSeq: upload?.metadata.frameSeq ?? 1,
      mediaUrl: `/api/media/${SESSION}/frames/x.png`,
      vision: vision({ lastFrameSeq: upload?.metadata.frameSeq ?? 0 }),
    };
    answers[index]?.resolve(new Response(JSON.stringify(body), { status: 202, headers: { "Content-Type": "application/json" } }));
  };
  const refuse = (index: number, status: number, error: string) =>
    answers[index]?.resolve(new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } }));
  return { fetch, uploads, answers, accept, refuse };
}

/** OCR under test control: each call resolves when `release` is called. */
function controlledOcr(words: (region: { x: number; y: number }) => OcrWord[] = () => []) {
  const pending: Array<() => void> = [];
  let failNext = false;
  const ocr: OcrFn = (_image, region) =>
    new Promise((resolve, reject) => {
      pending.push(() => (failNext ? ((failNext = false), reject(new Error("worker crashed"))) : resolve(words(region))));
    });
  return {
    ocr,
    pending,
    release: () => pending.shift()?.(),
    failNext: () => {
      failNext = true;
    },
  };
}

function grabber(frames: () => RgbaImage | null) {
  const state = { stopped: 0, ended: [] as Array<() => void> };
  const g: FrameGrabber = { grab: frames, stop: () => void (state.stopped += 1), onEnded: (l) => void state.ended.push(l) };
  return { g, state };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function setup(options: { epoch?: number; offRecord?: boolean; lastFrameSeq?: number; words?: (region: { x: number; y: number }) => OcrWord[]; caseIdTracker?: CaseIdTracker } = {}) {
  const server = uploadServer();
  const ocr = controlledOcr(options.words);
  const ticks: Array<() => void> = [];
  let cleared = 0;
  const clock = { t: 1_790_000_000_000 };
  const pipeline = createCapturePipeline({
    sessionId: SESSION,
    fetch: server.fetch,
    privacy: { offRecord: options.offRecord ?? false, epoch: options.epoch ?? 0 },
    lastFrameSeq: options.lastFrameSeq ?? 0,
    redactor: createRedactor({ ocr: ocr.ocr, names: () => ["Mara Lindqvist"] }),
    ...(options.caseIdTracker !== undefined && { caseIdTracker: options.caseIdTracker }),
    encode: async (image) => new Blob([new Uint8Array(encodePng(image))], { type: "image/png" }),
    now: () => clock.t,
    timers: {
      setInterval: (fn) => {
        ticks.push(fn);
        return ticks.length;
      },
      clearInterval: () => {
        cleared += 1;
        ticks.length = 0;
      },
    },
  });
  let variant = 0;
  const shown = { image: screen(0) as RgbaImage | null };
  const share = grabber(() => shown.image);
  /** Advances the clock 500 ms and fires the interval (if capture is running). */
  const tick = () => {
    clock.t += 500;
    for (const fn of [...ticks]) fn();
  };
  const change = () => {
    variant += 1;
    shown.image = screen(variant);
  };
  return { pipeline, server, ocr, share, tick, change, clock, cleared: () => cleared, shown };
}

describe("capture pipeline: grab → change → redact → upload", () => {
  it("uploads a changed frame with its metadata, stamped with the session's epoch and the next vision frameSeq", async () => {
    const s = setup({ epoch: 3, lastFrameSeq: 41 });
    expect(s.pipeline.start(s.share.g)).toBe(true);
    expect(s.pipeline.status()).toEqual({ state: "capturing" });
    s.tick();
    s.ocr.release();
    await flush();
    expect(s.server.uploads).toHaveLength(1);
    const [upload] = s.server.uploads;
    expect(upload?.url).toBe(`/api/sessions/${SESSION}/frames`);
    expect(upload?.metadata).toMatchObject({ frameSeq: 42, privacyEpoch: 3, captureTime: s.clock.t, source: { width: W, height: H }, crop: null });
    const decoded = decodePng(new Uint8Array(await (upload?.frame ?? new Blob()).arrayBuffer()));
    expect([decoded.width, decoded.height]).toEqual([W, H]);

    s.server.accept(0);
    await flush();
    const stats = s.pipeline.stats();
    expect(stats).toMatchObject({ captured: 1, changed: 1, uploaded: 1, coalesced: 0, staleDropped: 0 });
    expect(stats.ocrMs.n).toBe(1);
    expect(stats.uploadMs.n).toBe(1);
    expect(stats.vision?.extraction).toBe("unavailable");
  });

  it("sends nothing for an unchanged frame and sends a local change with its native-resolution crop", async () => {
    const s = setup();
    s.pipeline.start(s.share.g);
    s.tick();
    s.ocr.release();
    await flush();
    s.server.accept(0);
    s.tick(); // same screen
    await flush();
    expect(s.server.uploads).toHaveLength(1);
    expect(s.pipeline.stats()).toMatchObject({ captured: 2, changed: 1 });

    s.change();
    s.tick();
    s.ocr.release();
    await flush();
    expect(s.server.uploads).toHaveLength(2);
    const second = s.server.uploads[1];
    expect(second?.metadata.bbox).not.toBeNull();
    expect(second?.metadata.crop).toEqual(second?.metadata.bbox);
    expect(second?.crop).not.toBeNull();
  });

  it("reads the case id from the OCR words and sends it as trusted metadata; the tick is 250 ms (team P2 decision)", async () => {
    expect(CAPTURE_INTERVAL_MS).toBe(250);
    const tracker = createCaseIdTracker({ pattern: /^NS-\d{4}-\d{4}$/, region: { x: 0, y: 0, width: 1, height: 1 } });
    const s = setup({ caseIdTracker: tracker, words: () => [{ text: "NS-2026-0301", line: 0, bbox: { x: 40, y: 20, width: 90, height: 14 }, confidence: 0.9 }] });
    s.pipeline.start(s.share.g);
    s.tick();
    s.ocr.release();
    await flush();
    // The id came from the redactor's words (carry-forward and region filtering are unit-tested in case-id.test.ts).
    expect(s.server.uploads[0]?.metadata.caseId).toEqual({ value: "NS-2026-0301", confidence: 0.9 });
  });

  it("blurs names from the session's people before upload and reports how many regions it blurred", async () => {
    const s = setup({ words: () => [{ text: "Mara", line: 0, bbox: { x: 50, y: 50, width: 20, height: 12 } }] });
    s.pipeline.start(s.share.g);
    s.tick();
    s.ocr.release();
    await flush();
    const upload = s.server.uploads[0];
    expect(upload?.metadata.redactedRegions).toBe(1);
    const sent = decodePng(new Uint8Array(await (upload?.frame ?? new Blob()).arrayBuffer()));
    const original = screen(0);
    // Inside the box the pixels were averaged (the box straddles the dark block's edge), outside untouched.
    const at = (img: RgbaImage, x: number, y: number) => img.data[(y * W + x) * 4];
    expect(at(sent, 50, 55)).not.toBe(at(original, 50, 55));
    expect(at(sent, 200, 150)).toBe(at(original, 200, 150));
    expect(s.pipeline.stats().redactedRegions).toBe(1);
  });

  it("processes one frame at a time: ticks during OCR are skipped, not queued", async () => {
    const s = setup();
    s.pipeline.start(s.share.g);
    s.tick();
    s.change();
    s.tick();
    s.tick();
    expect(s.pipeline.stats()).toMatchObject({ captured: 1, skippedBusy: 2 });
    s.ocr.release();
    await flush();
    s.tick(); // the screen changed meanwhile: picked up on the next free tick
    expect(s.pipeline.stats()).toMatchObject({ captured: 2, changed: 2 });
  });

  it("keeps one upload in flight and coalesces waiting frames to the newest", async () => {
    const s = setup();
    s.pipeline.start(s.share.g);
    for (let i = 0; i < 3; i += 1) {
      s.tick();
      s.ocr.release();
      await flush();
      s.change();
    }
    expect(s.server.uploads.map((u) => u.metadata.frameSeq)).toEqual([1]);
    s.server.accept(0);
    await flush();
    expect(s.server.uploads.map((u) => u.metadata.frameSeq)).toEqual([1, 3]);
    expect(s.pipeline.stats()).toMatchObject({ coalesced: 1, uploaded: 1 });
  });

  it("fails closed when redaction fails: nothing is uploaded and the next frame is re-read in full", async () => {
    const s = setup();
    s.pipeline.start(s.share.g);
    s.ocr.failNext();
    s.tick();
    s.ocr.release();
    await flush();
    expect(s.server.uploads).toEqual([]);
    expect(s.pipeline.stats()).toMatchObject({ redactionFailed: 1 });
    expect(s.pipeline.stats().lastError).toMatch(/redaction failed/);
    s.tick(); // same screen, but the detector was reset: a full re-read
    s.ocr.release();
    await flush();
    expect(s.server.uploads).toHaveLength(1);
  });
});

describe("off the record (plan §7.8)", () => {
  it("stops the share and cancels queued and in-flight uploads immediately; nothing more is sent", async () => {
    const s = setup();
    s.pipeline.start(s.share.g);
    s.tick();
    s.ocr.release();
    await flush(); // frame 1 uploading
    s.change();
    s.tick();
    s.ocr.release();
    await flush(); // frame 2 waiting
    s.change();
    s.tick(); // frame 3 being redacted
    const inFlight = s.server.uploads[0]?.signal;

    s.pipeline.setPrivacy({ offRecord: true, epoch: 0 });
    expect(s.pipeline.status()).toEqual({ state: "off_record" });
    expect(s.share.state.stopped).toBe(1);
    expect(s.cleared()).toBe(1);
    expect(inFlight?.aborted).toBe(true);

    s.ocr.release(); // frame 3's redaction finishes after the transition: discarded
    await flush();
    s.tick();
    await flush();
    expect(s.server.uploads.map((u) => u.metadata.frameSeq)).toEqual([1]);
    expect(s.pipeline.stats()).toMatchObject({ cancelled: 1, staleDropped: 1, uploaded: 0 });

    // The server confirms the new epoch; capture cannot restart while off the record.
    s.pipeline.setPrivacy({ offRecord: true, epoch: 1 });
    const again = grabber(() => screen(9));
    expect(s.pipeline.start(again.g)).toBe(false);
    expect(again.state.stopped).toBe(1);

    // Resumed: a new share is stamped with the new epoch (frame 3 was never submitted, so its seq is reused).
    s.pipeline.setPrivacy({ offRecord: false, epoch: 2 });
    expect(s.pipeline.status()).toEqual({ state: "idle" });
    expect(s.pipeline.start(again.g)).toBe(true);
    s.tick();
    s.ocr.release();
    await flush();
    expect(s.server.uploads.at(-1)?.metadata).toMatchObject({ privacyEpoch: 2, frameSeq: 3 });
  });

  it("starts paused when the session is already off the record", () => {
    const s = setup({ offRecord: true, epoch: 5 });
    expect(s.pipeline.status()).toEqual({ state: "off_record" });
    expect(s.pipeline.start(s.share.g)).toBe(false);
  });
});

describe("server answers", () => {
  it("a refusal (409) stops capture with its reason", async () => {
    const s = setup();
    s.pipeline.start(s.share.g);
    s.tick();
    s.ocr.release();
    await flush();
    s.server.refuse(0, 409, "stale_epoch");
    await flush();
    expect(s.pipeline.status()).toMatchObject({ state: "stopped", error: expect.stringContaining("stale_epoch") });
    expect(s.share.state.stopped).toBe(1);
  });

  it("a network failure is counted and capture continues", async () => {
    const s = setup();
    s.pipeline.start(s.share.g);
    s.tick();
    s.ocr.release();
    await flush();
    s.server.answers[0]?.reject(new TypeError("Failed to fetch"));
    await flush();
    expect(s.pipeline.status()).toEqual({ state: "capturing" });
    expect(s.pipeline.stats()).toMatchObject({ uploadFailed: 1 });
    s.change();
    s.tick();
    s.ocr.release();
    await flush();
    expect(s.server.uploads).toHaveLength(2);
  });

  it("the browser's own 'Stop sharing' ends capture", () => {
    const s = setup();
    s.pipeline.start(s.share.g);
    for (const listener of s.share.state.ended) listener();
    expect(s.pipeline.status()).toEqual({ state: "idle" });
  });
});

describe("redaction names", () => {
  it("are the session's people: owners, relationship managers and individual customers", () => {
    const cases = kycCases("training");
    const names = personNames(cases);
    for (const c of cases) {
      for (const owner of c.owners) expect(names).toContain(owner.name);
      expect(names).toContain(c.relationship.relationshipManager);
      if (c.customer.entityType !== "individual" && !c.owners.some((o) => o.name === c.customer.name))
        expect(names).not.toContain(c.customer.name);
    }
    expect(new Set(names).size).toBe(names.length);
  });
});
