/** Typed client for the tutor HTTP contract (`lib/contracts/tutor.ts`); every response is validated before the UI sees it. */
import type { z } from "zod";
import {
  BriefingResponseSchema,
  type BriefingRequestSchema,
  JudgeCaseResponseSchema,
  PracticeResponseSchema,
  PredictionResponseSchema,
  TutorIntentResponseSchema,
  TutorStateSchema,
  type JudgeCaseRequestSchema,
  type PredictionRequestSchema,
  type TutorIntentRequestSchema,
} from "../../contracts/tutor";
import { postJson, requestJson, type FetchFn } from "../api";

function tutorPath(sessionId: string, rest = ""): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/tutor${rest}`;
}

export function fetchTutorState(fetchFn: FetchFn, sessionId: string) {
  return requestJson(fetchFn, tutorPath(sessionId), TutorStateSchema);
}

export function postIntent(fetchFn: FetchFn, sessionId: string, body: z.input<typeof TutorIntentRequestSchema>) {
  return requestJson(fetchFn, tutorPath(sessionId, "/intent"), TutorIntentResponseSchema, postJson(body));
}

export function postPrediction(fetchFn: FetchFn, sessionId: string, body: z.input<typeof PredictionRequestSchema>) {
  return requestJson(fetchFn, tutorPath(sessionId, "/prediction"), PredictionResponseSchema, postJson(body));
}

export function postPractice(fetchFn: FetchFn, sessionId: string) {
  return requestJson(fetchFn, tutorPath(sessionId, "/practice"), PracticeResponseSchema, { method: "POST" });
}

export function postJudgeCase(fetchFn: FetchFn, sessionId: string, body: z.input<typeof JudgeCaseRequestSchema>) {
  return requestJson(fetchFn, tutorPath(sessionId, "/cases"), JudgeCaseResponseSchema, postJson(body));
}

export function postBriefing(fetchFn: FetchFn, sessionId: string, body: z.input<typeof BriefingRequestSchema> = {}) {
  return requestJson(fetchFn, tutorPath(sessionId, "/briefing"), BriefingResponseSchema, postJson(body));
}
