/**
 * The pixel work of one extraction: decode the uploaded frame and plan the read (`prepareRead`:
 * thumbnail, change plan, trimmed or cropped re-encodes). Tens to hundreds of milliseconds of
 * synchronous CPU per frame, so the server runs it in its vision worker thread (workers/vision.ts),
 * off the event loop that serves the gate and the custom LLM; tests run it in process.
 */
import { prepareRead, type ExtractionContext, type PreparedRead } from "@vashistha/perception/extraction";
import { decodePng } from "@vashistha/perception/png";
import type { VisionCrop, VisionFrame } from "./service";

export type FrameToRead = ExtractionContext & { frame: VisionFrame; crop: VisionCrop | null };
export type ReadPreparer = (input: FrameToRead) => Promise<PreparedRead>;

export function prepareFrame({ frame, crop, ...context }: FrameToRead): PreparedRead {
  const image = decodePng(Buffer.from(frame.base64Png, "base64"));
  const { base64Png, sourceWidth, sourceHeight } = frame;
  return prepareRead({ ...context, frame: { image, base64Png, sourceWidth, sourceHeight }, ...(crop !== null && { crop }) });
}
