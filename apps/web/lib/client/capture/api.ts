/** Typed client for the vision-channel contract (`lib/contracts/frames.ts`); bodies are zod-validated. */
import type { z } from "zod";
import { FRAME_PARTS, PostFrameResponseSchema, VisionStateResponseSchema, type FrameMetadataSchema } from "../../contracts/frames";
import { requestJson, type FetchFn } from "../api";

const framesPath = (sessionId: string): string => `/api/sessions/${encodeURIComponent(sessionId)}/frames`;

export type FrameUpload = { metadata: z.input<typeof FrameMetadataSchema>; frame: Blob; crop: Blob | null };

/** Uploads one redacted frame (multipart). `signal` aborts the upload (off the record). */
export function postFrame(fetchFn: FetchFn, sessionId: string, upload: FrameUpload, signal?: AbortSignal) {
  const form = new FormData();
  form.set(FRAME_PARTS.metadata, JSON.stringify(upload.metadata));
  form.set(FRAME_PARTS.frame, upload.frame, "frame.png");
  if (upload.crop !== null) form.set(FRAME_PARTS.crop, upload.crop, "crop.png");
  return requestJson(fetchFn, framesPath(sessionId), PostFrameResponseSchema, {
    method: "POST",
    body: form,
    ...(signal !== undefined && { signal }),
  });
}

export function fetchVisionState(fetchFn: FetchFn, sessionId: string) {
  return requestJson(fetchFn, framesPath(sessionId), VisionStateResponseSchema);
}
