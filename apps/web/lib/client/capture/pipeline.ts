/**
 * Browser screen-capture pipeline (plan §7.1, §7.8), independent of the DOM so it runs under test:
 *
 *   every `intervalMs` (500): grab → change detector → (changed) best-effort PII redaction (OCR of
 *   the changed region, names of the session's synthetic people) → `prepareUpload` (≤1568 px frame +
 *   native crop) → PNG → ordered perception queue (one upload in flight, newest pending frame kept)
 *   → `POST /api/sessions/:id/frames`.
 *
 * - One frame is processed at a time; ticks that arrive while redaction/encoding runs are skipped
 *   (counted), so OCR cost lowers the frame rate instead of building a backlog.
 * - Fail closed: if redaction fails the frame is not uploaded, and the detector and redactor are
 *   reset so the next frame is re-read in full.
 * - Off the record (`setPrivacy({ offRecord: true })`): the screen share is stopped (the browser's
 *   own capture ends), the frame being redacted is discarded, and the queue drops the waiting frame
 *   and aborts the upload in flight — synchronously, before anything else happens. Frames carry the
 *   privacy epoch they were captured under; the queue refuses frames from an older epoch and the
 *   server refuses them too (409). Resuming the record needs a new "Share screen" click.
 * - A refusal from the server (4xx) stops capture with its reason; network errors and 5xx are
 *   counted and capture continues with the next frame.
 *
 * Privacy claim, exactly: frames are change-detected and pass a best-effort PII blur in the browser
 * before upload. OCR can miss text; the real guarantee is that CaseDesk data is synthetic.
 */
import {
  createChangeDetector,
  createPerceptionQueue,
  percentile,
  prepareUpload,
  type ChangeDetector,
  type PerceptionQueue,
  type RedactionResult,
  type Redactor,
  type RgbaImage,
} from "@vashistha/perception";
import type { PostFrameResponse, VisionState } from "../../contracts/frames";
import { ApiError, describeError, type FetchFn } from "../api";
import { postFrame } from "./api";

export const CAPTURE_INTERVAL_MS = 500;

/** A running screen share. `grab` returns null until the first video frame is available. */
export type FrameGrabber = {
  grab(): RgbaImage | null;
  /** Ends the share (stops every track). */
  stop(): void;
  /** Called when the share ends outside our control (the browser's "Stop sharing"). */
  onEnded(listener: () => void): void;
};

export type PngEncoder = (image: RgbaImage) => Promise<Blob>;

/** What the off-record flow publishes; V2's `PrivacyController` satisfies it. */
export type PrivacySnapshot = { offRecord: boolean; epoch: number };

export type CaptureStatus =
  | { state: "idle" }
  | { state: "capturing" }
  /** Off the record: nothing is captured or sent. */
  | { state: "off_record" }
  /** The server refused a frame; capture stopped. */
  | { state: "stopped"; error: string };

export type Latency = { n: number; p50: number | null; p95: number | null };

export type CaptureStats = {
  /** Grabs that were examined by the change detector. */
  captured: number;
  changed: number;
  /** Ticks skipped because the previous frame was still being redacted/encoded. */
  skippedBusy: number;
  /** Frames not uploaded because redaction failed (fail closed). */
  redactionFailed: number;
  /** PII word boxes pixelated, summed over uploaded frames. */
  redactedRegions: number;
  uploaded: number;
  coalesced: number;
  staleDropped: number;
  cancelled: number;
  uploadFailed: number;
  /** OCR + redaction time per changed frame. */
  ocrMs: Latency;
  /** Upload request time (start → server answer). */
  uploadMs: Latency;
  /** The server's vision state from the latest upload. */
  vision: VisionState | null;
  lastError: string | null;
};

type Timers = { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (handle: unknown) => void };

export type CapturePipelineOptions = {
  sessionId: string;
  fetch: FetchFn;
  /** The session's privacy state when the pipeline is created. */
  privacy: PrivacySnapshot;
  /** Highest vision frameSeq the server already accepted for this session (from `GET …/frames`). */
  lastFrameSeq: number;
  redactor: Redactor;
  encode: PngEncoder;
  now?: () => number;
  intervalMs?: number;
  timers?: Timers;
};

export type CapturePipeline = {
  /** Starts capturing from `grabber`; returns false (and stops the grabber) when off the record. */
  start(grabber: FrameGrabber): boolean;
  /** Stops capturing (the share ends); frames already queued still upload. */
  stop(): void;
  /** The off-record hook: call on every privacy change, synchronously. */
  setPrivacy(privacy: PrivacySnapshot): void;
  status(): CaptureStatus;
  stats(): CaptureStats;
  subscribe(listener: () => void): () => void;
  /** Resolves when no frame is being processed, waiting or uploading (tests). */
  idle(): Promise<void>;
  dispose(): void;
};

type PixelRect = { x: number; y: number; width: number; height: number };
type Payload = {
  frame: Blob;
  crop: Blob | null;
  cropRect: PixelRect | null;
  bbox: PixelRect | null;
  source: { width: number; height: number };
  changeScore: number;
  redactedRegions: number;
};

const MAX_SAMPLES = 512;

const summary = (samples: readonly number[]): Latency => ({ n: samples.length, p50: percentile(samples, 50), p95: percentile(samples, 95) });

/** Rects from the detector are whole pixels already; rounding guards the integer-only contract. */
const whole = (r: PixelRect): PixelRect => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });

export function createCapturePipeline(options: CapturePipelineOptions): CapturePipeline {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? CAPTURE_INTERVAL_MS;
  const timers: Timers = options.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const detector: ChangeDetector = createChangeDetector();
  const listeners = new Set<() => void>();
  const ocrMs: number[] = [];
  const counts = { captured: 0, changed: 0, skippedBusy: 0, redactionFailed: 0, redactedRegions: 0, uploaded: 0 };
  let status: CaptureStatus = options.privacy.offRecord ? { state: "off_record" } : { state: "idle" };
  let grabber: FrameGrabber | null = null;
  let timer: unknown;
  /** Bumped whenever capture halts, so a frame still being redacted is discarded when it finishes. */
  let generation = 0;
  let processing: Promise<void> | null = null;
  let vision: VisionState | null = null;
  let lastError: string | null = null;
  let disposed = false;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const sample = (value: number): void => {
    ocrMs.push(value);
    if (ocrMs.length > MAX_SAMPLES) ocrMs.shift();
  };

  const queue: PerceptionQueue<Payload> = createPerceptionQueue<Payload, PostFrameResponse>({
    epoch: options.privacy.epoch,
    lastFrameSeq: options.lastFrameSeq,
    now,
    maxSamples: MAX_SAMPLES,
    send: (frame, signal) =>
      postFrame(
        options.fetch,
        options.sessionId,
        {
          metadata: {
            frameSeq: frame.frameSeq,
            captureTime: frame.captureTime,
            privacyEpoch: frame.epoch,
            changeScore: Math.min(255, frame.payload.changeScore),
            redactedRegions: frame.payload.redactedRegions,
            source: frame.payload.source,
            bbox: frame.payload.bbox,
            crop: frame.payload.cropRect,
          },
          frame: frame.payload.frame,
          crop: frame.payload.crop,
        },
        signal,
      ),
    apply: (response) => {
      counts.uploaded += 1;
      vision = response.vision;
      notify();
    },
    onError: (error) => {
      lastError = describeError(error);
      // A refusal is final (privacy, order or validation); retrying blindly must not happen.
      if (error instanceof ApiError && error.kind === "http" && error.status < 500) halt({ state: "stopped", error: lastError });
      notify();
    },
  });

  function halt(next: CaptureStatus): void {
    generation += 1;
    if (timer !== undefined) timers.clearInterval(timer);
    timer = undefined;
    const ending = grabber;
    grabber = null;
    ending?.stop();
    status = next;
    notify();
  }

  async function process(image: RgbaImage, captureTime: number, change: ReturnType<ChangeDetector["push"]>): Promise<void> {
    const mine = generation;
    const epoch = queue.epoch();
    const started = now();
    let redacted: RedactionResult;
    try {
      redacted = await options.redactor.redact(image, change.bbox);
    } catch (error) {
      counts.redactionFailed += 1;
      lastError = `redaction failed, frame not uploaded: ${describeError(error)}`;
      detector.reset();
      options.redactor.reset();
      return;
    }
    sample(now() - started);
    if (mine !== generation) return;
    const upload = prepareUpload(redacted.image, change.bbox);
    const [frame, crop] = await Promise.all([options.encode(upload.frame), upload.crop === null ? null : options.encode(upload.crop.image)]);
    if (mine !== generation) return;
    const submitted = queue.submit(
      {
        frame,
        crop,
        cropRect: upload.crop === null ? null : whole(upload.crop.rect),
        bbox: change.bbox === null ? null : whole(change.bbox),
        source: { width: image.width, height: image.height },
        changeScore: change.score,
        redactedRegions: redacted.boxes.length,
      },
      captureTime,
      epoch,
    );
    if (submitted !== null) counts.redactedRegions += redacted.boxes.length;
  }

  function tick(): void {
    if (grabber === null) return;
    if (processing !== null) {
      counts.skippedBusy += 1;
      return;
    }
    const captureTime = now();
    const image = grabber.grab();
    if (image === null) return;
    counts.captured += 1;
    const change = detector.push(image);
    if (!change.changed) return notify();
    counts.changed += 1;
    processing = process(image, captureTime, change)
      .catch((error: unknown) => {
        lastError = describeError(error);
      })
      .finally(() => {
        processing = null;
        notify();
      });
    notify();
  }

  return {
    start(next) {
      if (disposed || status.state === "off_record") {
        next.stop();
        return false;
      }
      if (grabber !== null) halt({ state: "idle" });
      detector.reset();
      options.redactor.reset();
      grabber = next;
      lastError = null;
      status = { state: "capturing" };
      const mine = generation;
      next.onEnded(() => {
        if (mine === generation && grabber === next) halt({ state: "idle" });
      });
      timer = timers.setInterval(tick, intervalMs);
      notify();
      return true;
    },

    stop() {
      if (grabber !== null || status.state === "capturing") halt({ state: "idle" });
    },

    setPrivacy({ offRecord, epoch }) {
      if (offRecord) {
        if (status.state !== "off_record") halt({ state: "off_record" });
        queue.cancelAll();
        detector.reset();
        options.redactor.reset();
      }
      if (epoch > queue.epoch()) queue.setEpoch(epoch);
      if (!offRecord && status.state === "off_record") {
        status = { state: "idle" };
      }
      notify();
    },

    status: () => status,

    stats() {
      const q = queue.stats();
      return {
        ...counts,
        coalesced: q.coalesced,
        staleDropped: q.staleDropped + q.epochRejected,
        cancelled: q.cancelled,
        uploadFailed: q.failed,
        ocrMs: summary(ocrMs),
        uploadMs: summary(q.requestMs),
        vision,
        lastError,
      };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async idle() {
      while (processing !== null) await processing;
      await queue.idle();
    },

    dispose() {
      if (disposed) return;
      halt(status.state === "off_record" ? status : { state: "idle" });
      disposed = true;
      queue.cancelAll();
      listeners.clear();
    },
  };
}
