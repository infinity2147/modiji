/**
 * The server's hypothesis-engine worker thread (engine.worker.ts): question generation for the live
 * interview. Imported by the composition root only.
 */
import type { QuestionGenerator } from "../interview/questions";
import { createRpcWorker } from "./client";
import { ENGINE_OPS } from "./engine-ops";

export type EngineWorker = { questions: QuestionGenerator; close: () => Promise<void> };

export function createEngineWorker(log: Pick<Console, "warn" | "error">): EngineWorker {
  // CPU-bound in one thread: one generation at a time (each session's engine work is serial anyway).
  const rpc = createRpcWorker({ name: "engine", entry: new URL("./engine.worker.ts", import.meta.url), ops: ENGINE_OPS, maxInFlight: 1, log });
  return { questions: (input) => rpc.call("questions", input), close: () => rpc.close() };
}
