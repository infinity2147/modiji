/**
 * The production concept re-reader (plan §6.6): Claude Haiku 4.5 structured output over the last stored
 * redacted frames of a case, built by `buildBackfillRequest` from the session's PUBLIC feature model.
 * `runtime.claude` refuses any request carrying a hidden-policy marker. Loaded by the composition root
 * only (it pulls the model routing table and reads the media store).
 */
import type { Claude } from "@vashistha/core/server";
import { BACKFILL_MAX_FRAMES, buildBackfillRequest, toBackfillReading, type BackfillFrame } from "@vashistha/perception/backfill";
import type { FrameStore } from "../perception/frame-store";
import type { ConceptReread } from "./deps";

/** Bound on one re-read; a late call is a `model_error`, never a guess. */
const REREAD_DEADLINE_MS = 30_000;

export type FrameLoader = (sessionId: string, frameId: string) => Promise<Uint8Array | null>;

/** Stored frames (R2 or the volume); a frame id that is not a server-made UUID counts as missing. */
export function mediaFrameLoader(frames: FrameStore): FrameLoader {
  return async (sessionId, frameId) => {
    try {
      return await frames.get(sessionId, frameId);
    } catch (error) {
      if (error instanceof RangeError) return null;
      throw error;
    }
  };
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`re-read did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function createConceptReread(claude: Claude, loadFrame: FrameLoader, log: Pick<Console, "warn">): ConceptReread {
  return async ({ sessionId, domain, feature, caseId, frames }) => {
    const loaded: (BackfillFrame & { entryId: string })[] = [];
    for (const f of frames.slice(-BACKFILL_MAX_FRAMES)) {
      const bytes = await loadFrame(sessionId, f.frameId);
      if (bytes !== null) loaded.push({ entryId: f.entryId, frameId: f.frameId, width: f.width, height: f.height, base64Png: Buffer.from(bytes).toString("base64") });
    }
    if (loaded.length === 0) return { ok: false, failure: "frames_missing", frameIds: [] };
    const frameIds = loaded.map((f) => f.entryId);
    try {
      const { output } = await withDeadline(claude.structured(buildBackfillRequest({ domain, feature, caseId, frames: loaded })), REREAD_DEADLINE_MS);
      const reading = toBackfillReading(output, domain, feature);
      return reading.ok
        ? { ok: true, value: reading.value, evidence: reading.evidence, frameIds }
        : { ok: false, failure: reading.failure, evidence: reading.evidence, frameIds };
    } catch (error) {
      log.warn(`[schema] re-read of ${feature} for ${caseId} failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      return { ok: false, failure: "model_error", frameIds };
    }
  };
}
