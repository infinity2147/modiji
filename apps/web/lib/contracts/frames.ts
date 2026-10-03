/**
 * HTTP contract for the vision channel (plan §7.1, P2): redacted screen frames uploaded by the
 * browser, and the server's extraction state for the HUD / engineering view. Browser-safe.
 *
 * `POST /api/sessions/:sessionId/frames` is `multipart/form-data` with three parts:
 * - `metadata`: JSON text matching `FrameMetadataSchema`;
 * - `frame`: the redacted full frame as PNG, long edge ≤ `MAX_FRAME_LONG_EDGE`;
 * - `crop` (optional, present exactly when `metadata.crop` is non-null): the redacted changed region
 *   at native resolution as PNG.
 *
 * PNG only: the server checks the PNG signature and IHDR (never the declared content type), and the
 * extraction request sends PNG to the model. Refusals: 400 malformed, 413 too large, 415 not PNG,
 * 409 `stale_epoch` / `off_record` (privacy) or `stale_frame` (frameSeq not strictly increasing for
 * the session's vision channel — its own sequence, independent of the DOM channel's).
 */
import { z } from "zod";
import { EpochMsSchema, IdSchema } from "@vashistha/core";
import { MAX_UPLOAD_LONG_EDGE } from "@vashistha/perception";

/** Long edge of the uploaded full frame and of the crop (Haiku's standard vision tier, see `prepareUpload`). */
export const MAX_FRAME_LONG_EDGE = MAX_UPLOAD_LONG_EDGE;
/** Largest captured screen accepted (8K); the uploaded frame is a downscale of it. */
export const MAX_SOURCE_EDGE = 8192;
/** A 1568 px UI frame is typically 0.1–1 MB as PNG; photos or noise can reach a few MB. */
export const MAX_FRAME_BYTES = 6 * 1024 * 1024;
export const MAX_CROP_BYTES = 6 * 1024 * 1024;
/** Whole multipart body: both images plus metadata and multipart overhead. */
export const MAX_FRAME_REQUEST_BYTES = MAX_FRAME_BYTES + MAX_CROP_BYTES + 64 * 1024;

export const FRAME_PARTS = { metadata: "metadata", frame: "frame", crop: "crop" } as const;

export const PixelRectSchema = z.strictObject({
  x: z.int().nonnegative(),
  y: z.int().nonnegative(),
  width: z.int().positive(),
  height: z.int().positive(),
});
export type PixelRect = z.infer<typeof PixelRectSchema>;

const SizeSchema = z.strictObject({ width: z.int().positive().max(MAX_SOURCE_EDGE), height: z.int().positive().max(MAX_SOURCE_EDGE) });

const inside = (rect: PixelRect, size: { width: number; height: number }): boolean =>
  rect.x + rect.width <= size.width && rect.y + rect.height <= size.height;

export const FrameMetadataSchema = z
  .strictObject({
    /** Vision-channel sequence for the session: 1, 2, 3, … strictly increasing (gaps allowed: coalesced frames are never sent). */
    frameSeq: z.int().positive(),
    /** Browser `Date.now()` when the frame was grabbed, before redaction. */
    captureTime: EpochMsSchema,
    /** The privacy epoch the frame was captured under; must equal the session's current epoch. */
    privacyEpoch: z.int().nonnegative(),
    /** Change detector score (mean thumbnail difference, 0–255). */
    changeScore: z.number().nonnegative().max(255),
    /** Word boxes pixelated by the browser's best-effort PII pass. */
    redactedRegions: z.int().nonnegative().max(10_000),
    /** The captured frame's size before the upload downscale. */
    source: SizeSchema,
    /** Changed region in source pixels; null when the whole frame changed without a local bbox. */
    bbox: PixelRectSchema.nullable(),
    /** Rect (source pixels) of the `crop` part; null when no crop is sent. */
    crop: PixelRectSchema.nullable(),
  })
  .superRefine((m, ctx) => {
    if (m.bbox !== null && !inside(m.bbox, m.source))
      ctx.addIssue({ code: "custom", path: ["bbox"], message: "bbox must lie inside the source frame" });
    if (m.crop !== null && !inside(m.crop, m.source))
      ctx.addIssue({ code: "custom", path: ["crop"], message: "crop must lie inside the source frame" });
  });
export type FrameMetadata = z.infer<typeof FrameMetadataSchema>;

const LatencySchema = z.strictObject({ n: z.int().nonnegative(), p50: z.number().nullable(), p95: z.number().nullable() });

/**
 * The session's vision channel as the server sees it. `extraction: "unavailable"` means frames are
 * stored and ledgered (`frame.received`) but no model reads them and no vision events exist — the
 * UI must say so rather than imply vision is running.
 */
export const VisionStateSchema = z.strictObject({
  extraction: z.enum(["available", "unavailable"]),
  /** Why extraction is unavailable: no ANTHROPIC_API_KEY, or VISION_EXTRACTION=off. */
  unavailableReason: z.enum(["no_api_key", "disabled"]).nullable(),
  /** Session privacy state, so a capture client can start without another request. */
  privacyEpoch: z.int().nonnegative(),
  offRecord: z.boolean(),
  /** Highest frameSeq accepted on this session's vision channel (0 when none). */
  lastFrameSeq: z.int().nonnegative(),
  inFlight: z.boolean(),
  pendingFrameSeq: z.int().positive().nullable(),
  lastAppliedFrameSeq: z.int().nonnegative().nullable(),
  counts: z.strictObject({
    /** Frames accepted since this process started (stored and ledgered). */
    received: z.int().nonnegative(),
    /** Extractions whose result was applied. */
    applied: z.int().nonnegative(),
    /** Frames skipped because a newer one arrived while an extraction was in flight. */
    coalesced: z.int().nonnegative(),
    /** Results discarded: superseded, or the privacy epoch moved on before they were applied. */
    staleDropped: z.int().nonnegative(),
    failed: z.int().nonnegative(),
    events: z.int().nonnegative(),
    concepts: z.int().nonnegative(),
  }),
  /**
   * Per applied frame. `captureToEvents`: browser capture → events appended (spans both clocks, so it
   * is exact only when browser and server share a host). `receiptToEvents`: server receipt → appended.
   */
  latencyMs: z.strictObject({ captureToEvents: LatencySchema, receiptToEvents: LatencySchema }),
  /** Last extraction failure, as a short code-level description (never prompt or output text). */
  lastError: z.string().nullable(),
});
export type VisionState = z.infer<typeof VisionStateSchema>;

/** 202: the frame is stored and ledgered; extraction (if available) runs asynchronously. */
export const PostFrameResponseSchema = z.strictObject({
  frameId: IdSchema,
  /** The `client` / `frame.received` ledger entry; vision events cite it as their parent. */
  ledgerId: IdSchema,
  frameSeq: z.int().positive(),
  /** Session-scoped URL of the stored redacted frame. */
  mediaUrl: z.string().startsWith("/api/media/"),
  vision: VisionStateSchema,
});
export type PostFrameResponse = z.infer<typeof PostFrameResponseSchema>;

/** `GET /api/sessions/:sessionId/frames`: the vision state alone. */
export const VisionStateResponseSchema = z.strictObject({ vision: VisionStateSchema });

/** Path of a stored frame, relative to `DATA_DIR/media` (also the `frame.received` `mediaPath`). */
export function frameMediaPath(sessionId: string, frameId: string): string {
  return `${sessionId}/frames/${frameId}.png`;
}

export function frameMediaUrl(sessionId: string, frameId: string): string {
  return `/api/media/${encodeURIComponent(sessionId)}/frames/${encodeURIComponent(frameId)}.png`;
}
