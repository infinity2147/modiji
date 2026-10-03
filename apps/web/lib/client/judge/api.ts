/** Typed client for the engine-state route of the interview contract (judge engineering view). */
import type { z } from "zod";
import { EngineStateResponseSchema } from "../../contracts/interview";
import { requestJson, type FetchFn } from "../api";

export type EngineState = z.infer<typeof EngineStateResponseSchema>;

export function fetchEngineState(fetchFn: FetchFn, sessionId: string, signal?: AbortSignal): Promise<EngineState> {
  return requestJson(
    fetchFn,
    `/api/sessions/${encodeURIComponent(sessionId)}/engine`,
    EngineStateResponseSchema,
    signal ? { signal } : {},
  );
}
