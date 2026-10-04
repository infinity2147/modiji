/**
 * `POST /api/sessions/:sessionId/frames` and `GET /api/sessions/:sessionId/frames` (plan §7.1, §7.8).
 *
 * POST order, each step refusing before anything is kept:
 * 1. body ≤ MAX_FRAME_REQUEST_BYTES (413), multipart with valid `metadata` (400);
 * 2. `frame` (and `crop` iff `metadata.crop`) are PNG by signature + IHDR (415), within byte and
 *    dimension limits (413 / 400), and the crop's size matches its rect (≤ 1568 px long edge);
 * 3. CaseDesk session (404), on the record and at the frame's privacy epoch (409 `off_record` /
 *    `stale_epoch`) — so nothing captured off the record is ever written;
 * 4. vision frameSeq strictly newer than the session's last (409 `stale_frame`);
 * 5. the redacted frame is written atomically to DATA_DIR/media, then `client` / `frame.received` is
 *    appended (the ledger re-checks epoch and off-record atomically; if it refuses, the file is
 *    removed and the request is 409);
 * 6. the frame is handed to the extraction worker; the 202 response does not wait for it.
 *
 * Only the redacted frame is stored. The crop is kept in memory for the extraction and dropped.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Ledger } from "@vashistha/core/server";
import { fitLongEdge } from "@vashistha/perception";
import {
  FRAME_PARTS,
  FrameMetadataSchema,
  MAX_CROP_BYTES,
  MAX_FRAME_BYTES,
  MAX_FRAME_LONG_EDGE,
  MAX_FRAME_REQUEST_BYTES,
  frameMediaPath,
  frameMediaUrl,
  type FrameMetadata,
  type PostFrameResponseSchema,
  type VisionStateResponseSchema,
} from "../../contracts/frames";
import { ApiFailure, json, parseOr400, respond } from "../casedesk/http";
import { CASEDESK_SCHEMA_VERSION, loadSession, requireOnRecord, type CaseDeskStore } from "../casedesk/session";
import type { PerceptionService } from "./service";
import type { FrameStore } from "./frame-store";
import { pngDimensions } from "./storage";

export type PerceptionDeps = {
  ledger: Ledger;
  store: CaseDeskStore;
  perception: PerceptionService;
  frames: FrameStore;
  now: () => number;
  log: Pick<Console, "error">;
};

type Png = { bytes: Uint8Array; width: number; height: number };

async function readForm(request: Request): Promise<FormData> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_FRAME_REQUEST_BYTES)
    throw new ApiFailure(413, "payload_too_large", `body exceeds ${MAX_FRAME_REQUEST_BYTES} bytes`);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data"))
    throw new ApiFailure(400, "invalid_request", "body must be multipart/form-data");
  // A body without content-length (chunked) is bounded here, before multipart parsing buffers it.
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_FRAME_REQUEST_BYTES)
    throw new ApiFailure(413, "payload_too_large", `body exceeds ${MAX_FRAME_REQUEST_BYTES} bytes`);
  try {
    return await new Response(body, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
  } catch {
    throw new ApiFailure(400, "invalid_request", "malformed multipart body");
  }
}

function readMetadata(form: FormData): FrameMetadata {
  const raw = form.get(FRAME_PARTS.metadata);
  if (typeof raw !== "string") throw new ApiFailure(400, "invalid_request", `missing "${FRAME_PARTS.metadata}" text part`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiFailure(400, "invalid_json", `"${FRAME_PARTS.metadata}" is not valid JSON`);
  }
  return parseOr400(FrameMetadataSchema, parsed, "invalid_metadata");
}

async function readPng(form: FormData, part: string, maxBytes: number): Promise<Png | null> {
  const value = form.get(part);
  if (value === null) return null;
  if (typeof value === "string") throw new ApiFailure(400, "invalid_request", `"${part}" must be a file part`);
  if (value.size > maxBytes) throw new ApiFailure(413, "payload_too_large", `"${part}" exceeds ${maxBytes} bytes`);
  const bytes = new Uint8Array(await value.arrayBuffer());
  const size = pngDimensions(bytes);
  if (size === null) throw new ApiFailure(415, "unsupported_media_type", `"${part}" is not a PNG image`);
  if (Math.max(size.width, size.height) > MAX_FRAME_LONG_EDGE)
    throw new ApiFailure(400, "invalid_dimensions", `"${part}" long edge exceeds ${MAX_FRAME_LONG_EDGE} px`);
  return { bytes, ...size };
}

/** `prepareUpload` sizes: within a pixel of `rect` fitted to the long-edge limit (never upscaled). */
function checkSize(image: Png, rect: { width: number; height: number }, what: string): void {
  const expected = fitLongEdge(rect.width, rect.height, MAX_FRAME_LONG_EDGE);
  if (Math.abs(image.width - expected.width) > 1 || Math.abs(image.height - expected.height) > 1)
    throw new ApiFailure(
      400,
      "invalid_dimensions",
      `${what} is ${image.width}×${image.height}; expected ${expected.width}×${expected.height} for its ${rect.width}×${rect.height} source`,
    );
}

function checkCrop(crop: Png | null, metadata: FrameMetadata): void {
  if ((crop === null) !== (metadata.crop === null))
    throw new ApiFailure(400, "invalid_request", `"${FRAME_PARTS.crop}" must be sent exactly when metadata.crop is set`);
  if (crop !== null && metadata.crop !== null) checkSize(crop, metadata.crop, "crop");
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

export function handlePostFrame(request: Request, sessionId: string, deps: PerceptionDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const form = await readForm(request);
    const metadata = readMetadata(form);
    const frame = await readPng(form, FRAME_PARTS.frame, MAX_FRAME_BYTES);
    if (frame === null) throw new ApiFailure(400, "invalid_request", `missing "${FRAME_PARTS.frame}" file part`);
    const crop = await readPng(form, FRAME_PARTS.crop, MAX_CROP_BYTES);
    checkSize(frame, metadata.source, "frame");
    checkCrop(crop, metadata);

    const { session, info } = loadSession(deps, sessionId);
    requireOnRecord(session);
    if (metadata.privacyEpoch !== session.privacyEpoch)
      throw new ApiFailure(409, "stale_epoch", `privacy epoch ${metadata.privacyEpoch} is stale (current ${session.privacyEpoch})`);
    if (!deps.perception.claimFrameSeq(session.id, metadata.frameSeq))
      throw new ApiFailure(409, "stale_frame", `frameSeq ${metadata.frameSeq} is not newer than the last accepted vision frame`);

    const frameId = randomUUID();
    const traceId = randomUUID();
    await deps.frames.put(session.id, frameId, frame.bytes);
    let ledgerId: string;
    try {
      ledgerId = deps.ledger.append({
        sessionId: session.id,
        source: "client",
        kind: "frame.received",
        occurredAt: metadata.captureTime,
        traceId,
        parentIds: [info.startedEntryId],
        schemaVersion: CASEDESK_SCHEMA_VERSION,
        privacyEpoch: metadata.privacyEpoch,
        payload: {
          frameId,
          frameSeq: metadata.frameSeq,
          captureTime: metadata.captureTime,
          width: frame.width,
          height: frame.height,
          mediaPath: frameMediaPath(session.id, frameId),
          redactedRegions: metadata.redactedRegions,
          changeScore: metadata.changeScore,
        },
      }).id;
    } catch (error) {
      // Refused (e.g. the session went off the record while the file was written): keep nothing.
      await deps.frames.remove(session.id, frameId);
      throw error;
    }

    deps.perception.submit({
      sessionId: session.id,
      ledgerId,
      traceId,
      frameSeq: metadata.frameSeq,
      captureTime: metadata.captureTime,
      receivedAt: deps.now(),
      epoch: metadata.privacyEpoch,
      clientCaseId: metadata.caseId,
      frame: { base64Png: base64(frame.bytes), width: frame.width, height: frame.height, sourceWidth: metadata.source.width, sourceHeight: metadata.source.height },
      crop: crop === null || metadata.crop === null ? null : { base64Png: base64(crop.bytes), width: crop.width, height: crop.height, rect: metadata.crop },
    });
    const body: z.infer<typeof PostFrameResponseSchema> = {
      frameId,
      ledgerId,
      frameSeq: metadata.frameSeq,
      mediaUrl: frameMediaUrl(session.id, frameId),
      vision: deps.perception.state(deps.ledger.getSession(session.id) ?? session),
    };
    return json(body, 202);
  });
}

export function handleVisionState(sessionId: string, deps: PerceptionDeps): Promise<Response> {
  return respond(deps.log, () => {
    const { session } = loadSession(deps, sessionId);
    const body: z.infer<typeof VisionStateResponseSchema> = { vision: deps.perception.state(session) };
    return json(body);
  });
}
