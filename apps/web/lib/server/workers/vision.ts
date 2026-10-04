/**
 * The server's vision worker thread (vision.worker.ts): each frame that reaches the model is decoded
 * and its read planned there. The read comes back without its output schema, which is rebuilt here
 * from the domain and screen profile, and with the caller's own context (domain, profile, previous
 * reading). Imported by the composition root only.
 */
import { fullReadSchema, localReadSchema, refreshReadSchema, type PreparedRead } from "@vashistha/perception/extraction";
import type { ReadPreparer } from "../perception/prepare";
import { createRpcWorker } from "./client";
import { VISION_OPS } from "./vision-ops";

/** Sessions extract one frame at a time each; two in flight keep one session's frame from waiting behind another's. */
const MAX_IN_FLIGHT = 2;

export type VisionWorker = { prepare: ReadPreparer; close: () => Promise<void> };

export function createVisionWorker(log: Pick<Console, "warn" | "error">): VisionWorker {
  const rpc = createRpcWorker({ name: "vision", entry: new URL("./vision.worker.ts", import.meta.url), ops: VISION_OPS, maxInFlight: MAX_IN_FLIGHT, log });
  return {
    prepare: async (input): Promise<PreparedRead> => {
      const { domain, profile, previous, frameSeq, captureTime, sessionEpoch } = input;
      const planned = await rpc.call("prepare", input);
      const context = { domain, profile, previous, frameSeq, captureTime, sessionEpoch, thumbnail: planned.thumbnail, switchPossible: planned.switchPossible };
      switch (planned.mode) {
        case "full":
          return { mode: "full", request: { ...planned.request, schema: fullReadSchema(domain, profile) }, context: { ...context, mode: "full" } };
        case "refresh":
          return { mode: "refresh", request: { ...planned.request, schema: refreshReadSchema(domain, profile) }, context: { ...context, mode: "refresh" } };
        case "local":
          return { mode: "local", rect: planned.rect, request: { ...planned.request, schema: localReadSchema(domain, profile) }, context: { ...context, mode: "local" } };
      }
    },
    close: () => rpc.close(),
  };
}
