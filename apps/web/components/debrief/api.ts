/** Typed client for the debrief, Work Map and lineage routes; every body is validated with the contract. */
import { postJson, requestJson, type FetchFn } from "@/lib/client/api";
import {
  DebriefConversationSchema,
  DebriefStateSchema,
  ExpertActionResponseSchema,
  LineageResponseSchema,
  WorkMapResponseSchema,
  type DebriefConversationRequest,
  type ExpertActionRequest,
} from "@/lib/contracts/debrief";

const base = (sessionId: string): string => `/api/sessions/${encodeURIComponent(sessionId)}`;

export const getDebrief = (f: FetchFn, sessionId: string) => requestJson(f, `${base(sessionId)}/debrief`, DebriefStateSchema);
export const rebuildWitnesses = (f: FetchFn, sessionId: string) => requestJson(f, `${base(sessionId)}/witnesses`, DebriefStateSchema, { method: "POST" });
export const generateTeachBack = (f: FetchFn, sessionId: string) => requestJson(f, `${base(sessionId)}/teachback`, DebriefStateSchema, { method: "POST" });
export const expertAction = (f: FetchFn, sessionId: string, body: ExpertActionRequest) =>
  requestJson(f, `${base(sessionId)}/debrief`, ExpertActionResponseSchema, postJson(body));
export const getWorkMap = (f: FetchFn, sessionId: string) => requestJson(f, `${base(sessionId)}/workmap`, WorkMapResponseSchema);
export const getLineage = (f: FetchFn, sessionId: string, entryId: string) =>
  requestJson(f, `${base(sessionId)}/lineage?entryId=${encodeURIComponent(entryId)}`, LineageResponseSchema);
export const exportUrl = (sessionId: string, format: "json" | "procedure"): string => `${base(sessionId)}/workmap/export?format=${format}`;

export const getConversation = (f: FetchFn, sessionId: string) => requestJson(f, `${base(sessionId)}/debrief/conversation`, DebriefConversationSchema);
export const postConversation = (f: FetchFn, sessionId: string, body: DebriefConversationRequest) =>
  requestJson(f, `${base(sessionId)}/debrief/conversation`, DebriefConversationSchema, postJson(body));
