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
  const { quietWindowMs, speechTimeoutMs, connectTimeoutMs, minAuthorizationRemainingMs } = ctx.options;

  const problems: string[] = [];
  const facts: Facts = { quietWindowMs, speechTimeoutMs };
  const conversations: string[] = [];

  const connect = async (auth: PreflightAuthorization): Promise<VoiceSession> => {
    const url = await getSignedUrl(client, vars.ELEVENLABS_INTERVIEWER_AGENT_ID);
    ctx.secrets.add(url);
    const session = await VoiceSession.connect({
      factory: ctx.WebSocket,
      url,
      // The custom LLM finds the ledger session (and so the authorization) through `elevenlabs_extra_body`.
      initiation: { custom_llm_extra_body: { sessionId: auth.sessionId } },
      timeoutMs: connectTimeoutMs,
      now: ctx.now,
    });
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
    if (aSpeech.length > 0) {
      problems.push(
        `phase A: agent spoke without authorization (${Object.entries(countByType(aSpeech))
          .map(([t, n]) => `${n} ${t}`)
          .join(", ")})`,
      );
    }
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

async function getSignedUrl(client: PreflightElevenLabs, agentId: string): Promise<string> {
  try {
    return await client.getSignedUrl(agentId);
  } catch (error) {
    throw new CheckFailure(`signed URL for the interviewer: ${describeError(error)}`);
  }
}
