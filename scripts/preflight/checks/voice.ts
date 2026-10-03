import { SET_OFF_RECORD_TOOL } from "../../../packages/core/src/voice/off-record";
import { authorizePreflight, CheckFailure, describeError, requireVars, type PreflightAuthorization } from "../http";
import { elevenLabsReachableTarget } from "../target";
import type { CheckOutcome, Facts, FactValue, PreflightContext, PreflightElevenLabs } from "../types";
import { VoiceSession, type ServerEvent } from "../voice-session";

type Ctx = Pick<
  PreflightContext,
  "env" | "target" | "fetch" | "now" | "wallClock" | "options" | "secrets" | "createElevenLabs" | "WebSocket"
>;

/** An ordinary, unauthorised user turn: the agent must stay silent. */
export const PHASE_A_TEXT = "Hello, is anyone there?";

/** An off-record phrase as the expert would say it: the custom LLM must answer with `set_off_record` and no speech. */
export const OFF_RECORD_PROBE_TEXT = "Let's go off the record for a moment.";

/** Events that mean the agent produced speech (text for TTS, or audio). */
const SPEECH_TYPES = new Set(["agent_response", "audio", "agent_chat_response_part", "internal_tentative_agent_response"]);

/** Everything a healthy text-driven conversation may send; anything else is reported as unexpected. */
const EXPECTED_TYPES = new Set([
  "conversation_initiation_metadata",
  "ping",
  "user_transcript",
  "agent_tool_response",
  "agent_tool_request",
  "agent_response",
  "agent_response_metadata",
  "agent_response_complete",
  "audio",
  "agent_chat_response_part",
  "internal_tentative_agent_response",
  "vad_score",
  "context_usage",
  "client_tool_call",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function countByType(events: readonly ServerEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}

export function agentResponseText(event: ServerEvent): string | null {
  const body = event.body.agent_response_event;
  return isRecord(body) && typeof body.agent_response === "string" ? body.agent_response : null;
}

function toolResponses(events: readonly ServerEvent[]): FactValue[] {
  return events.flatMap((e) => {
    if (e.type !== "agent_tool_response" || !isRecord(e.body.agent_tool_response)) return [];
    const r = e.body.agent_tool_response;
    const pick = (key: string): FactValue => {
      const v = r[key];
      return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null;
    };
    return [{ toolName: pick("tool_name"), toolType: pick("tool_type"), status: pick("status"), isError: pick("is_error"), isCalled: pick("is_called") }];
  });
}

function clientErrors(events: readonly ServerEvent[]): string[] {
  return events.flatMap((e) => {
    if (e.type !== "client_error") return [];
    const err = isRecord(e.body.error_event) ? e.body.error_event : {};
    const name = typeof err.error_name === "string" ? err.error_name : "unknown";
    const message = typeof err.message === "string" ? `: ${err.message.slice(0, 160)}` : "";
    return [`client_error ${String(err.code ?? "?")} ${name}${message}`];
  });
}

const truncate = (text: string, n = 120): string => (text.length > n ? `${text.slice(0, n)}…` : text);

type ClientToolCall = { toolName: string | null; parameters: Record<string, unknown> | null; at: number };

/** `client_tool_call` events (`{client_tool_call: {tool_name, tool_call_id, parameters}}`). */
function clientToolCalls(events: readonly ServerEvent[]): ClientToolCall[] {
  return events.flatMap((e) => {
    if (e.type !== "client_tool_call") return [];
    const call = isRecord(e.body.client_tool_call) ? e.body.client_tool_call : {};
    return [
      {
        toolName: typeof call.tool_name === "string" ? call.tool_name : null,
        parameters: isRecord(call.parameters) ? call.parameters : null,
        at: e.at,
      },
    ];
  });
}

function describeSpeech(speech: readonly ServerEvent[]): string {
  return Object.entries(countByType(speech))
    .map(([t, n]) => `${n} ${t}`)
    .join(", ");
}

/** A WebSocket conversation with the interviewer whose custom-LLM calls name `sessionId` (a preflight ledger session). */
async function openConversation(ctx: Ctx, client: PreflightElevenLabs, agentId: string, sessionId: string): Promise<VoiceSession> {
  const url = await getSignedUrl(client, agentId);
  ctx.secrets.add(url);
  return VoiceSession.connect({
    factory: ctx.WebSocket,
    url,
    // The custom LLM finds the ledger session (and so the authorization) through `elevenlabs_extra_body`.
    initiation: { custom_llm_extra_body: { sessionId } },
    timeoutMs: ctx.options.connectTimeoutMs,
    now: ctx.now,
  });
}

/**
 * The end-to-end proof that `skip_turn` is honoured on the live path (plan §12), through ElevenLabs:
 *   A. an ordinary user message ⇒ no agent text and no audio for the whole quiet window;
 *   B. the authorised control message ⇒ an `agent_response` equal to the authorised text, plus TTS audio.
 * ElevenLabs calls the deployed custom LLM itself, so this also observes the facts api-notes lists as UNVERIFIED.
 */
export async function checkVoiceSkipTurn(ctx: Ctx): Promise<CheckOutcome> {
  const target = elevenLabsReachableTarget(ctx.target, ctx.env.PUBLIC_BASE_URL);
  if (!target.ok) return { status: "fail", detail: target.error };
  const vars = requireVars(ctx.env, ["ELEVENLABS_API_KEY", "ELEVENLABS_INTERVIEWER_AGENT_ID", "CUSTOM_LLM_SECRET"]);
  const client = ctx.createElevenLabs(vars.ELEVENLABS_API_KEY);
  const { quietWindowMs, speechTimeoutMs, minAuthorizationRemainingMs } = ctx.options;

  const problems: string[] = [];
  const facts: Facts = { quietWindowMs, speechTimeoutMs };
  const conversations: string[] = [];

  const connect = async (auth: PreflightAuthorization): Promise<VoiceSession> => {
    const session = await openConversation(ctx, client, vars.ELEVENLABS_INTERVIEWER_AGENT_ID, auth.sessionId);
    if (session.conversationId !== null) conversations.push(session.conversationId);
    return session;
  };

  // Authorised first, so the ledger session named in the initiation data exists before ElevenLabs calls us.
  let auth = await authorizePreflight(ctx, target.baseUrl, vars.CUSTOM_LLM_SECRET);
  const connectStarted = ctx.now();
  let session = await connect(auth);
  facts.connectMs = Math.round(ctx.now() - connectStarted);
  const sessions = [session];

  try {
    // Phase A: unauthorised turn, then a quiet window.
    const aFrom = session.events.length;
    session.send({ type: "user_message", text: PHASE_A_TEXT });
    await session.waitFor(() => session.closed !== null, quietWindowMs);
    const aEvents = session.events.slice(aFrom);
    const aSpeech = aEvents.filter((e) => SPEECH_TYPES.has(e.type));
    const aTexts = aEvents.flatMap((e) => agentResponseText(e) ?? []);
    if (aSpeech.length > 0) problems.push(`phase A: agent spoke without authorization (${describeSpeech(aSpeech)})`);
    if (session.closed !== null) problems.push(`phase A: conversation ended during the quiet window${session.closeSuffix()}`);
    const aTools = toolResponses(aEvents);
    const aEchoed = aEvents.some((e) => e.type === "user_transcript");
    const phaseAOk = aSpeech.length === 0 && session.closed === null;
    facts.phaseA = {
      events: countByType(aEvents),
      agentResponses: aTexts.map((t) => truncate(t)),
      toolResponses: aTools,
      userTranscriptEchoed: aEchoed,
    };

    // Phase B: the authorization must outlive the turn; a fresh one needs a fresh conversation (it names the session).
    let reconnected = false;
    if (auth.expiresAt - ctx.wallClock() < minAuthorizationRemainingMs || session.closed !== null) {
      await session.close();
      auth = await authorizePreflight(ctx, target.baseUrl, vars.CUSTOM_LLM_SECRET);
      session = await connect(auth);
      sessions.push(session);
      reconnected = true;
    }
    const current = session;
    const bFrom = current.events.length;
    const sentAt = ctx.now();
    current.send({ type: "user_message", text: auth.controlMessage });
    const matches = (e: ServerEvent): boolean => agentResponseText(e)?.trim() === auth.text;
    await current.waitFor(
      () =>
        current.closed !== null ||
        current.since(bFrom, "client_error").length > 0 ||
        (current.since(bFrom, "audio").length > 0 && current.since(bFrom, "agent_response").some(matches)),
      speechTimeoutMs,
    );
    const bEvents = current.events.slice(bFrom);
    const bAudio = bEvents.filter((e) => e.type === "audio");
    const bResponses = bEvents.filter((e) => e.type === "agent_response");
    const match = bResponses.find(matches);
    const firstAudioMs = bAudio[0] ? Math.round(bAudio[0].at - sentAt) : null;
    const agentResponseMs = match ? Math.round(match.at - sentAt) : null;
    if (!match) {
      const got = bResponses.map((e) => JSON.stringify(truncate(agentResponseText(e) ?? ""))).join(", ");
      problems.push(`phase B: no agent_response equal to the authorised text within ${speechTimeoutMs} ms${got ? ` (got ${got})` : ""}`);
    }
    const others = bResponses.filter((e) => e !== match);
    if (match && others.length > 0) problems.push(`phase B: ${others.length} additional agent_response event(s)`);
    if (bAudio.length === 0) problems.push(`phase B: no audio within ${speechTimeoutMs} ms`);
    if (current.closed !== null && !(match && bAudio.length > 0)) problems.push(`phase B: conversation ended${current.closeSuffix()}`);
    facts.phaseB = {
      reconnected,
      events: countByType(bEvents),
      firstAudioMs,
      agentResponseMs,
      audioEvents: bAudio.length,
      toolResponses: toolResponses(bEvents),
      // Only whether it arrived: its text is the control message, which carries the nonce.
      userTranscriptEchoed: bEvents.some((e) => e.type === "user_transcript"),
    };

    const all = sessions.flatMap((s) => s.events);
    problems.push(...clientErrors(all));
    const unexpected = [...new Set(all.map((e) => e.type).filter((t) => !EXPECTED_TYPES.has(t)))];
    facts.unexpectedEventTypes = unexpected;
    facts.pongs = sessions.reduce((n, s) => n + s.pongs, 0);
    facts.pings = all.filter((e) => e.type === "ping").length;
    facts.protocolErrors = sessions.flatMap((s) => s.errors);
    facts.conversationIds = conversations;

    const phaseBOk = match !== undefined && bAudio.length > 0;
    const skipSeen = aTools.some((t) => isRecord(t) && t.toolName === "skip_turn");
    facts.observed = {
      bearerAuth: phaseBOk
        ? "verified: ElevenLabs reached the custom LLM with Authorization: Bearer <CUSTOM_LLM_SECRET> (the endpoint speaks only for that header)"
        : "not established (phase B did not speak)",
      streamedSkipTurn:
        phaseAOk && phaseBOk
          ? `accepted: no speech for ${quietWindowMs} ms after an unauthorised turn${skipSeen ? "; agent_tool_response skip_turn observed" : "; no agent_tool_response event for skip_turn reached the client"}`
          : "not established",
      preToolSpeech: phaseAOk ? "none: no audio or agent text around skip_turn" : "speech observed in phase A",
      userTranscriptForUserMessage: aEchoed ? "echoed as user_transcript" : "not echoed as user_transcript",
    };

    const unexpectedNote = unexpected.length > 0 ? `; unexpected events: ${unexpected.join(", ")}` : "";
    if (problems.length > 0) return { status: "fail", detail: `${problems.join("; ")}${unexpectedNote}`, facts };
    return {
      status: "pass",
      detail: `conversation ${conversations.join(", ")}: silent for ${quietWindowMs} ms on an unauthorised turn; authorised text after ${String(agentResponseMs)} ms, first audio after ${String(firstAudioMs)} ms${unexpectedNote}`,
      facts,
    };
  } finally {
    await Promise.all(sessions.map((s) => s.close()));
  }
}

/**
 * Off the record by voice, end to end through ElevenLabs (plan §7.8): the expert's off-record phrase reaches our custom
 * LLM as an ordinary, unauthorised user turn, which must produce exactly one `client_tool_call` to `set_off_record`
 * with `{offRecord: true}`, no agent text and no audio for the whole quiet window (and no repeated call, which would
 * mean ElevenLabs re-invoked the LLM with the same turn).
 */
export async function checkVoiceOffRecord(ctx: Ctx): Promise<CheckOutcome> {
  const target = elevenLabsReachableTarget(ctx.target, ctx.env.PUBLIC_BASE_URL);
  if (!target.ok) return { status: "fail", detail: target.error };
  const vars = requireVars(ctx.env, ["ELEVENLABS_API_KEY", "ELEVENLABS_INTERVIEWER_AGENT_ID", "CUSTOM_LLM_SECRET"]);
  const client = ctx.createElevenLabs(vars.ELEVENLABS_API_KEY);
  const { quietWindowMs } = ctx.options;

  // Only for its ledger session: the custom LLM records the phrase marker there. The authorization is never used.
  const auth = await authorizePreflight(ctx, target.baseUrl, vars.CUSTOM_LLM_SECRET);
  const session = await openConversation(ctx, client, vars.ELEVENLABS_INTERVIEWER_AGENT_ID, auth.sessionId);
  try {
    const from = session.events.length;
    const sentAt = ctx.now();
    session.send({ type: "user_message", text: OFF_RECORD_PROBE_TEXT });
    await session.waitFor(() => session.closed !== null, quietWindowMs);
    const events = session.events.slice(from);
    const speech = events.filter((e) => SPEECH_TYPES.has(e.type));
    const calls = clientToolCalls(events);
    const [call] = calls;

    const problems: string[] = [];
    if (speech.length > 0) problems.push(`agent spoke on the off-record phrase (${describeSpeech(speech)})`);
    if (calls.length !== 1) {
      problems.push(`expected exactly one client_tool_call, got ${calls.length}${calls.length > 0 ? ` (${calls.map((c) => String(c.toolName)).join(", ")})` : ""}`);
    }
    if (call !== undefined && (call.toolName !== SET_OFF_RECORD_TOOL || call.parameters?.offRecord !== true)) {
      problems.push(`client_tool_call was ${String(call.toolName)} ${JSON.stringify(call.parameters)}; expected ${SET_OFF_RECORD_TOOL} {"offRecord":true}`);
    }
    if (session.closed !== null) problems.push(`conversation ended during the quiet window${session.closeSuffix()}`);
    problems.push(...clientErrors(session.events), ...session.errors);
    const unexpected = [...new Set(session.events.map((e) => e.type).filter((t) => !EXPECTED_TYPES.has(t)))];

    const toolCallMs = call === undefined ? null : Math.round(call.at - sentAt);
    const facts: Facts = {
      quietWindowMs,
      conversationId: session.conversationId,
      events: countByType(events),
      toolCallMs,
      clientToolCalls: calls.map((c) => ({ toolName: c.toolName, offRecord: c.parameters?.offRecord === true })),
      toolResponses: toolResponses(events),
      userTranscriptEchoed: events.some((e) => e.type === "user_transcript"),
      unexpectedEventTypes: unexpected,
    };
    const unexpectedNote = unexpected.length > 0 ? `; unexpected events: ${unexpected.join(", ")}` : "";
    if (problems.length > 0) return { status: "fail", detail: `${problems.join("; ")}${unexpectedNote}`, facts };
    return {
      status: "pass",
      detail: `conversation ${String(session.conversationId)}: ${SET_OFF_RECORD_TOOL} client tool call after ${String(toolCallMs)} ms, no speech for ${quietWindowMs} ms${unexpectedNote}`,
      facts,
    };
  } finally {
    await session.close();
  }
}

async function getSignedUrl(client: PreflightElevenLabs, agentId: string): Promise<string> {
  try {
    return await client.getSignedUrl(agentId);
  } catch (error) {
    throw new CheckFailure(`signed URL for the interviewer: ${describeError(error)}`);
  }
}
