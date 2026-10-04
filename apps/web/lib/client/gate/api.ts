/** Typed client for the gate half of the interview contract (`lib/contracts/interview.ts`). */
import type { z } from "zod";
import {
  GateAuthorizeResponseSchema,
  QuestionQueueResponseSchema,
  type GateAuthorizeRequestSchema,
} from "../../contracts/interview";
import { postJson, requestJson, type FetchFn } from "../api";

export type QuestionQueue = z.infer<typeof QuestionQueueResponseSchema>;
export type GateAuthorizeResponse = z.infer<typeof GateAuthorizeResponseSchema>;

const sessionPath = (sessionId: string, rest: string) => `/api/sessions/${encodeURIComponent(sessionId)}/${rest}`;

export function fetchQuestionQueue(fetchFn: FetchFn, sessionId: string, signal?: AbortSignal): Promise<QuestionQueue> {
  return requestJson(fetchFn, sessionPath(sessionId, "questions"), QuestionQueueResponseSchema, signal ? { signal } : {});
}

/** Gives up (a `network` ApiError) after `timeoutMs`. */
export function authorizeQuestion(
  fetchFn: FetchFn,
  sessionId: string,
  body: z.input<typeof GateAuthorizeRequestSchema>,
  timeoutMs: number,
): Promise<GateAuthorizeResponse> {
  return requestJson(fetchFn, sessionPath(sessionId, "gate/authorize"), GateAuthorizeResponseSchema, {
    ...postJson(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
