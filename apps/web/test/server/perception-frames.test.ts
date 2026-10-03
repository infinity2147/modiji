import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseLedgerPayload } from "@vashistha/core";
import { PostFrameResponseSchema, VisionStateResponseSchema, MAX_FRAME_REQUEST_BYTES } from "../../lib/contracts/frames";
import { handleGetFrameMedia } from "../../lib/server/perception/media";
import { framePath, pngDimensions } from "../../lib/server/perception/storage";
import { T0, domEvent } from "../support/casedesk-harness";
import { createPerceptionHarness, metadata, png, SOURCE, type PerceptionHarness } from "../support/perception-harness";

let h: PerceptionHarness;
let sessionId: string;
beforeEach(async () => {
  h = createPerceptionHarness({ unavailable: "no_api_key" });
  sessionId = await h.session("training");
});
afterEach(() => h.cleanup());

const frames = () => h.ledger.list(sessionId, { kinds: ["frame.received"] });
const storedFiles = (sid = sessionId): string[] => {
  const dir = join(h.dataDir, "media", sid, "frames");
  return existsSync(dir) ? readdirSync(dir) : [];
};
const errorOf = (body: unknown) => (body as { error: string }).error;
const offRecord = (on: boolean) => h.ledger.setOffRecord(sessionId, on, { occurredAt: T0, traceId: "privacy-trace" });

describe("POST /api/sessions/:sessionId/frames — accepted frame", () => {
  it("stores the redacted PNG atomically and appends client/frame.received under the session root", async () => {
    const bytes = png();
    const { status, body } = await h.postFrame(sessionId, { metadata: metadata({ frameSeq: 3, captureTime: T0 + 40 }), frame: bytes });
    expect(status).toBe(202);
    const response = PostFrameResponseSchema.parse(body);
    expect(response.frameSeq).toBe(3);
    expect(response.mediaUrl).toBe(`/api/media/${sessionId}/frames/${response.frameId}.png`);

    const path = join(h.dataDir, "media", sessionId, "frames", `${response.frameId}.png`);
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(storedFiles()).toEqual([`${response.frameId}.png`]); // no temporary file left behind

    const [entry] = frames();
    const root = h.ledger.list(sessionId, { kinds: ["session.started"] })[0];
    expect(entry).toMatchObject({ id: response.ledgerId, source: "client", occurredAt: T0 + 40, privacyEpoch: 0, parentIds: [root?.id] });
    expect(parseLedgerPayload(entry ?? { kind: "", source: "client", payload: null }, "frame.received")).toEqual({
      frameId: response.frameId,
      frameSeq: 3,
      captureTime: T0 + 40,
      width: SOURCE.width,
      height: SOURCE.height,
      mediaPath: `${sessionId}/frames/${response.frameId}.png`,
      redactedRegions: 2,
      changeScore: 12.5,
    });
  });

  it("accepts a downscaled frame with a native-resolution crop of the changed region", async () => {
    const source = { width: 3136, height: 1960 };
    const rect = { x: 100, y: 200, width: 300, height: 80 };
    const { status } = await h.postFrame(sessionId, {
      metadata: metadata({ source, bbox: rect, crop: rect }),
      frame: png(1568, 980),
      crop: png(300, 80),
    });
    expect(status).toBe(202);
  });

  it("reports honestly that vision is unavailable without a model: nothing is extracted", async () => {
    const { body } = await h.postFrame(sessionId, { metadata: metadata(), frame: png() });
    const { vision } = PostFrameResponseSchema.parse(body);
    expect(vision).toMatchObject({ extraction: "unavailable", unavailableReason: "no_api_key", inFlight: false, lastAppliedFrameSeq: null });
    expect(vision.counts).toEqual({ received: 1, applied: 0, coalesced: 0, staleDropped: 0, failed: 0, events: 0, concepts: 0 });
    expect(h.ledger.list(sessionId, { sources: ["vision"] })).toEqual([]);

    const state = VisionStateResponseSchema.parse((await h.visionState(sessionId)).body).vision;
    expect(state).toMatchObject({ extraction: "unavailable", lastFrameSeq: 1, privacyEpoch: 0, offRecord: false });
  });
});

describe("POST /api/sessions/:sessionId/frames — validation (nothing is kept on refusal)", () => {
  const refused = async (parts: Parameters<PerceptionHarness["postFrame"]>[1], status: number, error: string) => {
    const reply = await h.postFrame(sessionId, parts);
    expect(reply.status).toBe(status);
    expect(errorOf(reply.body)).toBe(error);
    expect(frames()).toEqual([]);
    expect(storedFiles()).toEqual([]);
  };

  it("refuses a body that is not multipart", async () => {
    const request = new Request(`http://localhost/api/sessions/${sessionId}/frames`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(metadata()),
    });
    const { handlePostFrame } = await import("../../lib/server/perception/frames");
    const response = await handlePostFrame(request, sessionId, h.perceptionDeps);
    expect(response.status).toBe(400);
  });

  it("refuses an oversized body with 413 before parsing it", async () => {
    await refused({ metadata: metadata(), frame: new Uint8Array(MAX_FRAME_REQUEST_BYTES + 1) }, 413, "payload_too_large");
  });

  it("refuses missing, malformed or invalid metadata", async () => {
    await refused({ frame: png() }, 400, "invalid_request");
    await refused({ metadata: "{not json", frame: png() }, 400, "invalid_json");
    await refused({ metadata: metadata({ frameSeq: 0 }), frame: png() }, 400, "invalid_metadata");
    await refused({ metadata: { ...metadata(), extra: true }, frame: png() }, 400, "invalid_metadata");
    await refused({ metadata: metadata({ bbox: { x: 150, y: 0, width: 20, height: 10 } }), frame: png() }, 400, "invalid_metadata");
  });

  it("refuses anything that is not a PNG by its bytes, whatever the declared type (415)", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0]);
    await refused({ metadata: metadata(), frame: jpeg }, 415, "unsupported_media_type");
    await refused({ metadata: metadata(), frame: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>") }, 415, "unsupported_media_type");
    await refused({ metadata: metadata(), frame: "a text part" }, 400, "invalid_request");
  });

  it("refuses frames whose dimensions are over the limit or do not match the metadata", async () => {
    await refused({ metadata: metadata({ source: { width: 1600, height: 1000 } }), frame: png(1600, 1000) }, 400, "invalid_dimensions");
    await refused({ metadata: metadata(), frame: png(80, 50) }, 400, "invalid_dimensions");
    await refused({ metadata: metadata(), frame: png(160, 160) }, 400, "invalid_dimensions");
  });

  it("refuses a crop that is missing, unexpected or the wrong size", async () => {
    const rect = { x: 10, y: 10, width: 40, height: 20 };
    await refused({ metadata: metadata({ crop: rect }), frame: png() }, 400, "invalid_request");
    await refused({ metadata: metadata(), frame: png(), crop: png(40, 20) }, 400, "invalid_request");
    await refused({ metadata: metadata({ crop: rect }), frame: png(), crop: png(80, 40) }, 400, "invalid_dimensions");
  });

  it("is 404 for a session that does not exist", async () => {
    const reply = await h.postFrame("6f9c1d52-7d4e-4a54-9a3e-6a3b1c2d3e4f", { metadata: metadata(), frame: png() });
    expect(reply.status).toBe(404);
  });
});

describe("privacy epoch and off the record (plan §7.8)", () => {
  it("captures nothing while off the record: 409, no file, no ledger entry", async () => {
    offRecord(true);
    const reply = await h.postFrame(sessionId, { metadata: metadata({ privacyEpoch: 1 }), frame: png() });
    expect(reply.status).toBe(409);
    expect(errorOf(reply.body)).toBe("off_record");
    expect(frames()).toEqual([]);
    expect(storedFiles()).toEqual([]);
  });

  it("refuses a frame stamped with a stale epoch after resuming (409 stale_epoch)", async () => {
    offRecord(true);
    offRecord(false);
    const stale = await h.postFrame(sessionId, { metadata: metadata({ privacyEpoch: 0 }), frame: png() });
    expect(stale.status).toBe(409);
    expect(errorOf(stale.body)).toBe("stale_epoch");
    const fresh = await h.postFrame(sessionId, { metadata: metadata({ privacyEpoch: 2 }), frame: png() });
    expect(fresh.status).toBe(202);
    expect(frames().map((e) => e.privacyEpoch)).toEqual([2]);
  });

  it("removes the stored file when the ledger refuses the entry (the session went off record mid-request)", async () => {
    const original = h.ledger.append;
    h.ledger.append = (entry) => {
      offRecord(true);
      return original(entry);
    };
    const reply = await h.postFrame(sessionId, { metadata: metadata(), frame: png() });
    h.ledger.append = original;
    expect(reply.status).toBe(409);
    expect(errorOf(reply.body)).toBe("off_record");
    expect(storedFiles()).toEqual([]);
    expect(frames()).toEqual([]);
  });
});

describe("vision frame order (independent of the DOM channel)", () => {
  it("requires strictly increasing frameSeq per session (409 stale_frame)", async () => {
    expect((await h.postFrame(sessionId, { metadata: metadata({ frameSeq: 2 }), frame: png() })).status).toBe(202);
    for (const frameSeq of [2, 1]) {
      const reply = await h.postFrame(sessionId, { metadata: metadata({ frameSeq }), frame: png() });
      expect(reply.status).toBe(409);
      expect(errorOf(reply.body)).toBe("stale_frame");
    }
    expect((await h.postFrame(sessionId, { metadata: metadata({ frameSeq: 7 }), frame: png() })).status).toBe(202);
    expect(frames().map((e) => (e.payload as { frameSeq: number }).frameSeq)).toEqual([2, 7]);
    expect(storedFiles()).toHaveLength(2);
  });

  it("recovers the last vision frameSeq from the ledger after a restart", async () => {
    await h.postFrame(sessionId, { metadata: metadata({ frameSeq: 5 }), frame: png() });
    h.restartPerception();
    expect((await h.postFrame(sessionId, { metadata: metadata({ frameSeq: 5 }), frame: png() })).status).toBe(409);
    expect((await h.postFrame(sessionId, { metadata: metadata({ frameSeq: 6 }), frame: png() })).status).toBe(202);
  });

  it("does not share its sequence with the DOM channel", async () => {
    expect((await h.postEvents(sessionId, { events: [domEvent({ frameSeq: 40 })] })).status).toBe(200);
    expect((await h.postFrame(sessionId, { metadata: metadata({ frameSeq: 1 }), frame: png() })).status).toBe(202);
    expect((await h.postEvents(sessionId, { events: [domEvent({ frameSeq: 41 })] })).status).toBe(200);
  });

  it("keeps sessions apart", async () => {
    const other = await h.session("practice");
    await h.postFrame(sessionId, { metadata: metadata({ frameSeq: 9 }), frame: png() });
    expect((await h.postFrame(other, { metadata: metadata({ frameSeq: 1 }), frame: png() })).status).toBe(202);
  });
});

describe("storage path safety and GET /api/media/:sessionId/frames/:file", () => {
  const media = async (sid: string, file: string) => {
    const response = await handleGetFrameMedia(sid, file, h.perceptionDeps);
    return { status: response.status, type: response.headers.get("content-type"), bytes: Buffer.from(await response.arrayBuffer()) };
  };

  it("builds paths only from UUIDs and keeps them inside DATA_DIR/media", () => {
    const sid = "6f9c1d52-7d4e-4a54-9a3e-6a3b1c2d3e4f";
    expect(framePath("/data", sid, sid)).toBe(`/data/media/${sid}/frames/${sid}.png`);
    for (const bad of ["../etc", "..", "a/b", `${sid}/../x`, sid.toUpperCase(), ""])
      expect(() => framePath("/data", bad, sid), bad).toThrow(RangeError);
    expect(() => framePath("/data", sid, "../../passwd")).toThrow(RangeError);
  });

  it("reads PNG dimensions from the IHDR only for real PNG bytes", () => {
    expect(pngDimensions(png(33, 17))).toEqual({ width: 33, height: 17 });
    expect(pngDimensions(new Uint8Array(24))).toBeNull();
    expect(pngDimensions(png().subarray(0, 20))).toBeNull();
  });

  it("serves a recorded frame of the session as image/png", async () => {
    const bytes = png();
    const { body } = await h.postFrame(sessionId, { metadata: metadata(), frame: bytes });
    const { frameId } = PostFrameResponseSchema.parse(body);
    const served = await media(sessionId, `${frameId}.png`);
    expect(served.status).toBe(200);
    expect(served.type).toBe("image/png");
    expect(served.bytes.equals(bytes)).toBe(true);
  });

  it("is 404 for another session's frame, traversal attempts, and files the ledger does not know", async () => {
    const { body } = await h.postFrame(sessionId, { metadata: metadata(), frame: png() });
    const { frameId } = PostFrameResponseSchema.parse(body);
    const other = await h.session("practice");
    expect((await media(other, `${frameId}.png`)).status).toBe(404);
    for (const file of [`../${frameId}.png`, `..%2F${frameId}.png`, frameId, `${frameId}.png.tmp`, `${frameId.toUpperCase()}.png`])
      expect((await media(sessionId, file)).status, file).toBe(404);
    expect((await media("../../etc", `${frameId}.png`)).status).toBe(404);

    // A PNG planted on disk without a frame.received entry is never served.
    const planted = "0d3c2b1a-1111-4222-8333-944455556666";
    mkdirSync(join(h.dataDir, "media", sessionId, "frames"), { recursive: true });
    writeFileSync(framePath(h.dataDir, sessionId, planted), png());
    expect((await media(sessionId, `${planted}.png`)).status).toBe(404);
  });
});
