/**
 * Typed client for the voice half of the interview contract (`lib/contracts/interview.ts`) and the
 * conversation-token route. Every body is zod-validated before the UI sees it.
 */
import { z } from "zod";
import type { AgentRole } from "@vashistha/core";
import {
  OffRecordResponseSchema,
  PostUtteranceResponseSchema,
  type PostAgentUtteranceRequestSchema,
  type PostUtteranceRequestSchema,
} from "../../contracts/interview";
import { postJson, refusal, requestJson, send, validated, type FetchFn } from "../api";

const sessionPath = (sessionId: string, rest: string) => `/api/sessions/${encodeURIComponent(sessionId)}/${rest}`;

/** `GET /api/voice/token` success body (`lib/server/voice-token.ts`). */
const VoiceTokenSchema = z.strictObject({ token: z.string().min(1), conversationId: z.string().min(1) });
/** The 503 body when the server has no ElevenLabs key or agent id: names the missing variables. */
const VoiceNotConfiguredSchema = z.object({ error: z.literal("voice_not_configured"), missing: z.array(z.string()) });

export type VoiceToken = z.infer<typeof VoiceTokenSchema>;
export type VoiceTokenResult = { kind: "ok"; token: VoiceToken } | { kind: "not_configured"; missing: readonly string[] };

/** Mints a WebRTC conversation token for `agent`. "Voice not configured" is a result, not an error. */
export async function fetchVoiceToken(fetchFn: FetchFn, agent: AgentRole): Promise<VoiceTokenResult> {
  const raw = await send(fetchFn, `/api/voice/token?agent=${encodeURIComponent(agent)}`, {});
  if (raw.ok) return { kind: "ok", token: validated(VoiceTokenSchema, raw) };
  const notConfigured = VoiceNotConfiguredSchema.safeParse(raw.body);
  if (raw.status === 503 && notConfigured.success) return { kind: "not_configured", missing: notConfigured.data.missing };
  throw refusal(raw);
}

export function postUtterance(fetchFn: FetchFn, sessionId: string, body: z.input<typeof PostUtteranceRequestSchema>) {
  return requestJson(fetchFn, sessionPath(sessionId, "utterances"), PostUtteranceResponseSchema, postJson(body));
}

/** The agent-utterance route answers with no body we depend on; any 2xx is success. */
export async function postAgentUtterance(
  fetchFn: FetchFn,
  sessionId: string,
  body: z.input<typeof PostAgentUtteranceRequestSchema>,
): Promise<void> {
  const raw = await send(fetchFn, sessionPath(sessionId, "agent-utterances"), postJson(body));
  if (!raw.ok) throw refusal(raw);
}

export function postOffRecord(fetchFn: FetchFn, sessionId: string, offRecord: boolean) {
  return requestJson(fetchFn, sessionPath(sessionId, "off-record"), OffRecordResponseSchema, postJson({ offRecord }));
}
