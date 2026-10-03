/**
 * The custom-LLM wrapper ElevenLabs calls for every agent turn (plan §7.2, docs/api-notes.md §4).
 * Deliberately thin; its whole job is the invariant:
 *
 *   if (!validAuthorization(nonce, contextVersion)) return skip_turn
 *   else stream the precomputed question text
 *
 * A turn speaks only when the last message is a user turn that is exactly a control message whose
 * nonce the authorization store accepts for this agent, session and context version. Everything
 * else — expert speech, re-engagement turns, tool-result follow-ups, replays, malformed bodies —
 * gets the `skip_turn` tool-call stream. Authenticated requests never get an error status or an
 * empty completion: ElevenLabs retries the same custom LLM on errors, timeouts and empty responses.
 * A speech stream that aborts before it is fully written hands its nonce back, so that retry can
 * still speak the authorised text exactly once.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { IdSchema, parseControlMessage, type LedgerEntry } from "@vashistha/core";
import { parseAgentModelId, type AgentRole } from "@vashistha/core";
import type { Ledger } from "@vashistha/core/server";
import { nonceDigest, type AuthorizationLease, type AuthorizationStore, type ConsumeFailureReason } from "./authorizations";
import { rejectUnlessBearer } from "./bearer";

export type SkipReason =
  | "malformed_request"
  | "unknown_model"
  | "not_user_turn"
  | "not_control_message"
  | "missing_session"
  | ConsumeFailureReason
  | "ledger_write_failed";

export type CustomLlmDeps = {
  secret: string | undefined;
  authorizations: Pick<AuthorizationStore, "consume" | "getContextVersion">;
  ledger: Pick<Ledger, "getSession" | "append">;
  /** Wall clock (epoch ms) for expiry and ledger timestamps. */
  now: () => number;
  log: Pick<Console, "info" | "warn" | "error">;
};

/** Schema version of the `gate.*` and `llm.*` payloads written here. */
const PAYLOAD_SCHEMA_VERSION = 1;
const WORDS_PER_CHUNK = 4;
const MAX_LOGGED_MODEL_CHARS = 128;

const ContentPartSchema = z.object({ type: z.string(), text: z.string().optional() });

/**
 * The subset of an OpenAI chat-completions request we read. `z.object` accepts unknown keys and
 * drops them, so the parsed request never carries `elevenlabs_extra_body` (or anything else) onward.
 */
const ChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant", "tool"]),
      content: z.union([z.string(), z.null(), z.array(ContentPartSchema)]).optional(),
    }),
  ),
});
type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

/** The only field read from `elevenlabs_extra_body` (the browser's `customLlmExtraBody`). */
const ExtraBodySessionSchema = z.object({ elevenlabs_extra_body: z.object({ sessionId: IdSchema }) });

/** `nonce` is the control message's nonce when the last turn carried one (recorded as a digest only). */
type Turn =
  | { decision: "speak"; agent: AgentRole; questionId: string; text: string; nonce: string; lease: AuthorizationLease }
  | { decision: "skip_turn"; agent: AgentRole | null; reason: SkipReason; nonce: string | null };

/** Plain text of a message, or null when it has non-text parts (which can never be a control message). */
function textOf(content: ChatCompletionRequest["messages"][number]["content"]): string | null {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  let text = "";
  for (const part of content) {
    if (part.type !== "text" || part.text === undefined) return null;
    text += part.text;
  }
  return text;
}

function decide(request: ChatCompletionRequest, sessionId: string | null, deps: CustomLlmDeps): Turn {
  const last = request.messages.at(-1);
  const lastText = last?.role === "user" ? textOf(last.content) : null;
  const nonce = lastText === null ? null : parseControlMessage(lastText);
  const agent = parseAgentModelId(request.model)?.role ?? null;
  const skip = (reason: SkipReason): Turn => ({ decision: "skip_turn", agent, reason, nonce });

  if (agent === null) return skip("unknown_model");
  if (last?.role !== "user") return skip("not_user_turn");
  if (nonce === null) return skip("not_control_message");
  if (sessionId === null) return skip("missing_session");
  const result = deps.authorizations.consume(nonce, {
    sessionId,
    agent,
    currentContextVersion: deps.authorizations.getContextVersion(sessionId),
    now: deps.now(),
  });
  if (!result.ok) return skip(result.reason);
  const { authorization, text, lease } = result;
  return { decision: "speak", agent, questionId: authorization.questionId, text, nonce, lease };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await request.text()) as unknown;
  } catch {
    return undefined;
  }
}

type ChunkMeta = { id: string; created: number; model: string };

function chunk(meta: ChunkMeta, delta: Record<string, unknown>, finishReason: "stop" | "tool_calls" | null): string {
  const body = {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(body)}\n\n`;
}

const DONE = "data: [DONE]\n\n";

/** Word groups whose concatenation is exactly `text` (authorised text is trimmed and non-empty). */
function wordGroups(text: string): string[] {
  const words = text.match(/\S+\s*/g) ?? [];
  const groups: string[] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) groups.push(words.slice(i, i + WORDS_PER_CHUNK).join(""));
  return groups;
}

function speechEvents(meta: ChunkMeta, text: string): string[] {
  return [
    chunk(meta, { role: "assistant", content: "" }, null),
    ...wordGroups(text).map((group) => chunk(meta, { content: group }, null)),
    chunk(meta, {}, "stop"),
    DONE,
  ];
}

/** The streamed OpenAI tool call for ElevenLabs' `skip_turn` system tool (api-notes §4.2). */
function skipEvents(meta: ChunkMeta, reason: SkipReason): string[] {
  const toolCall = {
    index: 0,
    id: `call_skip_${randomBytes(9).toString("base64url")}`,
    type: "function",
    function: { name: "skip_turn", arguments: JSON.stringify({ reason }) },
  };
  return [
    chunk(meta, { role: "assistant", content: null, tool_calls: [toolCall] }, null),
    chunk(meta, {}, "tool_calls"),
    DONE,
  ];
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // no-transform also stops response compression, which would buffer the stream.
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

/** How a speech stream ended: `completed` once [DONE] has been handed on, `aborted` if the consumer went away first. */
type StreamOutcome = "completed" | "aborted";

/**
 * Pull-driven (high-water mark 0): each event is produced only when the consumer asks for it, so
 * "asked for more after [DONE]" means every byte was handed to the HTTP response — the latest
 * point at which this layer can observe delivery. The text is precomputed, so nothing waits.
 * `onSettled` runs exactly once: completed, or aborted by cancellation or `signal`.
 */
function sseResponse(events: readonly string[], signal: AbortSignal, onSettled?: (outcome: StreamOutcome) => void): Response {
  const encoder = new TextEncoder();
  let next = 0;
  let settled = false;
  const settle = (outcome: StreamOutcome) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", abort);
    onSettled?.(outcome);
  };
  const abort = () => settle("aborted");
  if (onSettled) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const event = events[next];
        next += 1;
        if (event === undefined) {
          controller.close();
          settle("completed");
        } else {
          controller.enqueue(encoder.encode(event));
        }
      },
      cancel: abort,
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

type Recorder = {
  /** Appends the control message (if any) and the decision; null, writing nothing, if the session is not in the ledger. */
  decision: (turn: Turn, payload: Record<string, unknown>) => LedgerEntry | null;
  aborted: (decision: LedgerEntry, questionId: string) => void;
};

function recorder(deps: CustomLlmDeps, sessionId: string, traceId: string): Recorder {
  const base = (privacyEpoch: number) => ({
    sessionId,
    occurredAt: deps.now(),
    traceId,
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    privacyEpoch,
  });
  return {
    decision(turn, payload) {
      const session = deps.ledger.getSession(sessionId);
      if (!session) return null;
      const control =
        turn.nonce === null
          ? null
          : deps.ledger.append({
              ...base(session.privacyEpoch),
              source: "system_control",
              kind: "gate.control_message",
              parentIds: [],
              payload: {
                nonceDigest: nonceDigest(turn.nonce),
                ...(turn.decision === "speak" ? { questionId: turn.questionId } : { reason: turn.reason }),
              },
            });
      return deps.ledger.append({
        ...base(session.privacyEpoch),
        source: "engine",
        kind: "llm.turn_decision",
        parentIds: control === null ? [] : [control.id],
        payload,
      });
    },
    aborted(decision, questionId) {
      const session = deps.ledger.getSession(sessionId);
      if (!session) return;
      deps.ledger.append({
        ...base(session.privacyEpoch),
        source: "engine",
        kind: "llm.stream_aborted",
        parentIds: [decision.id],
        payload: { questionId, nonceReleased: true },
      });
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
}

/**
 * Handles `POST /api/llm/chat/completions`. `receivedAt` is `performance.now()` taken as the request
 * arrived; the recorded `handlerLatencyMs` runs from there to the response body being ready
 * (it excludes only the synchronous ledger append that follows, typically well under 1 ms).
 */
export async function handleChatCompletion(request: Request, deps: CustomLlmDeps, receivedAt: number): Promise<Response> {
  const denied = rejectUnlessBearer(request.headers, deps.secret, "llm.chat_completions", deps.log);
  if (denied) return denied;

  const raw = await readJson(request);
  const sessionId = ExtraBodySessionSchema.safeParse(raw).data?.elevenlabs_extra_body.sessionId ?? null;
  const parsed = ChatCompletionRequestSchema.safeParse(raw);
  const model = parsed.success ? parsed.data.model : null;
  let turn: Turn = parsed.success
    ? decide(parsed.data, sessionId, deps)
    : { decision: "skip_turn", agent: null, reason: "malformed_request", nonce: null };

  const meta: ChunkMeta = {
    id: `chatcmpl-${randomBytes(12).toString("base64url")}`,
    created: Math.floor(deps.now() / 1000),
    model: model ?? "",
  };
  const handlerLatencyMs = Math.round((performance.now() - receivedAt) * 100) / 100;
  const record = sessionId === null ? null : recorder(deps, sessionId, meta.id);

  let decisionEntry: LedgerEntry | null = null;
  try {
    decisionEntry =
      record?.decision(turn, {
        decision: turn.decision,
        ...(turn.decision === "speak" ? { questionId: turn.questionId } : { reason: turn.reason }),
        agent: turn.agent,
        model: model?.slice(0, MAX_LOGGED_MODEL_CHARS) ?? null,
        handlerLatencyMs,
      }) ?? null;
  } catch (error) {
    // Fail closed: an unrecorded question must not be spoken. The nonce is spent, not handed back:
    // the gate authorises again once the ledger is healthy.
    deps.log.error(`[custom-llm] ledger write failed: ${describeError(error)}`);
    if (turn.decision === "speak") turn.lease.complete();
    turn = { decision: "skip_turn", agent: turn.agent, reason: "ledger_write_failed", nonce: turn.nonce };
  }

  deps.log.info(
    JSON.stringify({
      event: "llm.turn_decision",
      completionId: meta.id,
      decision: turn.decision,
      reason: turn.decision === "skip_turn" ? turn.reason : undefined,
      agent: turn.agent,
      model: model?.slice(0, MAX_LOGGED_MODEL_CHARS),
      recorded: decisionEntry !== null,
      handlerLatencyMs,
    }),
  );

  if (turn.decision === "skip_turn") return sseResponse(skipEvents(meta, turn.reason), request.signal);

  const { lease, questionId } = turn;
  return sseResponse(speechEvents(meta, turn.text), request.signal, (outcome) => {
    if (outcome === "completed") {
      lease.complete();
      return;
    }
    lease.release();
    deps.log.warn(`[custom-llm] speech stream ${meta.id} aborted before completion; nonce released for a retry`);
    if (decisionEntry === null || record === null) return;
    try {
      record.aborted(decisionEntry, questionId);
    } catch (error) {
      deps.log.error(`[custom-llm] ledger write failed: ${describeError(error)}`);
    }
  });
}
