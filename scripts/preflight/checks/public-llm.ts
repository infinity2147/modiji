import { randomBytes } from "node:crypto";
import { CUSTOM_LLM_PATH, agentModelId } from "../../../packages/core/src/server/elevenlabs-agents";
import { authorizePreflight, bearer, CheckFailure, describeError, joinUrl, requireVars } from "../http";
import { interpretChatStream, readSseResponse, type ChatStream } from "../sse";
import { httpTarget } from "../target";
import type { CheckOutcome, Facts, PreflightContext } from "../types";

/** The path ElevenLabs calls: `custom_llm.url` plus the `/chat/completions` it appends (api-notes §4.1). */
export const CHAT_COMPLETIONS_PATH = `${CUSTOM_LLM_PATH}/chat/completions`;

type Ctx = Pick<PreflightContext, "env" | "target" | "fetch" | "now" | "options" | "secrets" | "loadAgentSpec" | "sleep">;

/** An ElevenLabs-shaped request body: system prompt, conversation, system tools, `elevenlabs_extra_body`. */
export function chatRequestBody(model: string, userText: string, sessionId: string | null): Record<string, unknown> {
  return {
    model,
    stream: true,
    temperature: 0,
    max_tokens: 256,
    messages: [
      { role: "system", content: "Preflight check." },
      { role: "user", content: userText },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "skip_turn",
          description: "Skip the agent's turn.",
          parameters: { type: "object", properties: { reason: { type: "string" } }, required: [] },
        },
      },
    ],
    ...(sessionId === null ? {} : { elevenlabs_extra_body: { sessionId } }),
  };
}

export type StreamCall = { status: number; contentType: string; stream: ChatStream | null; firstChunkMs: number | null; totalMs: number };

async function postChat(ctx: Ctx, url: string, body: unknown, headers: Record<string, string>): Promise<StreamCall> {
  const started = ctx.now();
  let firstChunkMs: number | null = null;
  try {
    const response = await ctx.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ctx.options.httpTimeoutMs),
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status !== 200 || !contentType.startsWith("text/event-stream")) {
      await response.body?.cancel();
      return { status: response.status, contentType, stream: null, firstChunkMs, totalMs: Math.round(ctx.now() - started) };
    }
    const { events, errors } = await readSseResponse(response, () => {
      firstChunkMs = Math.round(ctx.now() - started);
    });
    return {
      status: response.status,
      contentType,
      stream: interpretChatStream(events, errors),
      firstChunkMs,
      totalMs: Math.round(ctx.now() - started),
    };
  } catch (error) {
    throw new CheckFailure(`POST ${CHAT_COMPLETIONS_PATH}: ${describeError(error)}`);
  }
}

/** Problems with a stream that should be exactly one `skip_turn` tool call and nothing else. */
export function skipTurnProblems(call: StreamCall): string[] {
  if (call.stream === null) return [`expected a 200 SSE stream, got HTTP ${call.status} (${call.contentType || "no content-type"})`];
  const s = call.stream;
  const problems = [...s.errors];
  if (s.toolCalls.length !== 1 || s.toolCalls[0]?.name !== "skip_turn") {
    problems.push(`expected one skip_turn tool call, got [${s.toolCalls.map((c) => c.name).join(", ")}]`);
  } else {
    try {
      const args: unknown = JSON.parse(s.toolCalls[0].arguments || "{}");
      if (args === null || typeof args !== "object" || Array.isArray(args)) problems.push("skip_turn arguments are not a JSON object");
    } catch {
      problems.push("skip_turn arguments are not valid JSON");
    }
  }
  if (s.content !== "") problems.push(`expected no content, got ${s.content.length} characters`);
  if (s.finishReasons.join(",") !== "tool_calls") problems.push(`expected finish_reason [tool_calls], got [${s.finishReasons.join(", ")}]`);
  return problems;
}

/** The `reason` argument of a skip_turn call (the endpoint's diagnostic), if any. */
export function skipReason(call: StreamCall): string | null {
  const args = call.stream?.toolCalls[0]?.arguments;
  if (args === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed !== null && typeof parsed === "object" && "reason" in parsed && typeof parsed.reason === "string" ? parsed.reason : null;
  } catch {
    return null;
  }
}

/** Problems with a stream that should speak exactly `text` and nothing else. */
export function speechProblems(call: StreamCall, text: string): string[] {
  if (call.stream === null) return [`expected a 200 SSE stream, got HTTP ${call.status} (${call.contentType || "no content-type"})`];
  const s = call.stream;
  const problems = [...s.errors];
  if (s.content !== text) problems.push(`content differs from the authorised text (${s.content.length} vs ${text.length} characters)`);
  if (s.toolCalls.length > 0) problems.push(`unexpected tool calls [${s.toolCalls.map((c) => c.name).join(", ")}]`);
  if (s.finishReasons.join(",") !== "stop") problems.push(`expected finish_reason [stop], got [${s.finishReasons.join(", ")}]`);
  return problems;
}

/** Mirrors `RESPEAK_WINDOW_MS` in apps/web/lib/server/authorizations.ts (scripts cannot import the web app's modules). */
const RESPEAK_WINDOW_MS = 10_000;
/** Slack past the window, for network and clock differences between this machine and the server. */
const RESPEAK_MARGIN_MS = 1_500;

/**
 * The custom-LLM endpoint, called from this machine over the public internet exactly as ElevenLabs will:
 * refuses missing and wrong credentials, answers an unauthorised user turn with a streamed `skip_turn`, speaks the
 * authorised text for a valid control message, and speaks the same text again for a retry inside the retry window, and refuses once the window has passed.
 */
export async function checkPublicLlm(ctx: Ctx): Promise<CheckOutcome> {
  const { CUSTOM_LLM_SECRET: secret } = requireVars(ctx.env, ["CUSTOM_LLM_SECRET"]);
  const target = httpTarget(ctx.target);
  if (!target.ok) return { status: "fail", detail: target.error };
  const url = joinUrl(target.baseUrl, CHAT_COMPLETIONS_PATH);
  const model = agentModelId(await ctx.loadAgentSpec("interviewer"));
  const problems: string[] = [];
  const facts: Facts = { path: CHAT_COMPLETIONS_PATH, model };

  // 1–2. Credentials. A random wrong secret, registered so it is never printed either.
  const wrong = randomBytes(36).toString("base64url");
  ctx.secrets.add(wrong);
  const plainBody = chatRequestBody(model, "Hello, is anyone there?", null);
  for (const [label, headers] of [
    ["no credentials", {}],
    ["wrong bearer", bearer(wrong)],
  ] as const) {
    const r = await postChat(ctx, url, plainBody, headers);
    if (r.status !== 401) problems.push(`${label}: expected HTTP 401, got ${r.status}`);
  }

  // 3. Unauthorised user turn in a real preflight session.
  const auth = await authorizePreflight(ctx, target.baseUrl, secret);
  facts.sessionId = auth.sessionId;
  const plain = await postChat(ctx, url, chatRequestBody(model, "Hello, is anyone there?", auth.sessionId), bearer(secret));
  const plainProblems = skipTurnProblems(plain);
  problems.push(...plainProblems.map((p) => `unauthorised turn: ${p}`));
  facts.skipTurn = { ok: plainProblems.length === 0, reason: skipReason(plain), firstChunkMs: plain.firstChunkMs, totalMs: plain.totalMs };

  // 4. Authorised control message.
  const speech = await postChat(ctx, url, chatRequestBody(model, auth.controlMessage, auth.sessionId), bearer(secret));
  const speechIssues = speechProblems(speech, auth.text);
  problems.push(...speechIssues.map((p) => `authorised turn: ${p}`));
  facts.speech = { ok: speechIssues.length === 0, firstChunkMs: speech.firstChunkMs, totalMs: speech.totalMs };

  // 5. A retry of the same nonce. ElevenLabs retries a custom-LLM turn that errored or came back empty, so inside
  //    the retry window the same authorised text is spoken again (and nothing else); once the window has passed the
  //    nonce is spent and a replay is refused.
  const retry = await postChat(ctx, url, chatRequestBody(model, auth.controlMessage, auth.sessionId), bearer(secret));
  const retryIssues = speechProblems(retry, auth.text);
  problems.push(...retryIssues.map((p) => `retry inside the window: ${p}`));
  facts.retry = { ok: retryIssues.length === 0, totalMs: retry.totalMs };

  await ctx.sleep(RESPEAK_WINDOW_MS + RESPEAK_MARGIN_MS);
  const replay = await postChat(ctx, url, chatRequestBody(model, auth.controlMessage, auth.sessionId), bearer(secret));
  const replayProblems = skipTurnProblems(replay);
  problems.push(...replayProblems.map((p) => `replayed nonce after the window: ${p}`));
  facts.replay = { ok: replayProblems.length === 0, reason: skipReason(replay), totalMs: replay.totalMs };

  if (problems.length > 0) return { status: "fail", detail: problems.join("; "), facts };
  return {
    status: "pass",
    detail: `401 without/with wrong bearer; unauthorised → skip_turn (${plain.totalMs} ms); authorised → exact text (first chunk ${speech.firstChunkMs ?? "?"} ms); retry inside the window → same text; replay after it → skip_turn (${skipReason(replay) ?? "no reason"})`,
    facts,
  };
}
