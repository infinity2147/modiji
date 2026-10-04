/**
 * Deterministic fakes for preflight tests: an in-memory deployment (fetch), a scripted ElevenLabs Agent WebSocket,
 * fake ElevenLabs and Claude clients, and a context builder. No network, no real timers beyond a few milliseconds.
 */
import { randomBytes } from "node:crypto";
import type { Claude, TextResult } from "../../../packages/core/src/server/claude";
import { loadAgentSpec, type AgentRole } from "../../../packages/core/src/server/elevenlabs-agents";
import { isOffRecordPhrase } from "../../../packages/core/src/voice/off-record";
import { createSecretRegistry } from "../../preflight/redact";
import { resolveTarget } from "../../preflight/target";
import { DEFAULT_OPTIONS, type PreflightContext, type PreflightElevenLabs } from "../../preflight/types";
import type { WebSocketFactory, WebSocketHandlers } from "../../preflight/voice-session";

export const BASE_URL = "https://preflight.example.org";
export const SECRET = "s3cret-custom-llm-value-0123456789abcdefXYZ";
export const ANTHROPIC_KEY = "sk-ant-api03-fake-anthropic-key-0123456789";
export const ELEVEN_KEY = "xi_fake_elevenlabs_key_0123456789abcdef";
export const PREFLIGHT_TEXT = "Preflight check. Can you hear me clearly?";

export const GOOD_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: ANTHROPIC_KEY,
  ELEVENLABS_API_KEY: ELEVEN_KEY,
  ELEVENLABS_INTERVIEWER_AGENT_ID: "agent_interviewer_1",
  ELEVENLABS_TUTOR_AGENT_ID: "agent_tutor_1",
  CUSTOM_LLM_SECRET: SECRET,
  PUBLIC_BASE_URL: BASE_URL,
};

export function makeUsage(overrides: Partial<TextResult["usage"]> = {}): TextResult["usage"] {
  return {
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: null,
    input_tokens: 20,
    output_tokens: 3,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: "standard",
    ...overrides,
  };
}

/** A Claude whose structured call parses `structuredJson` with the caller's schema (so validation is real). */
export function fakeClaude(options: { structuredJson?: unknown; failModel?: string } = {}): Claude & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async structured(req) {
      calls.push(`structured:${req.model}`);
      if (options.failModel === req.model) throw new Error(`${req.model}: 529 overloaded`);
      return {
        output: req.schema.parse(options.structuredJson ?? { unknown: true, reason: "not_visible" }),
        usage: makeUsage({ input_tokens: 180, output_tokens: 12 }),
        latencyMs: 412.4,
        stopReason: "end_turn",
      };
    },
    async text(req) {
      calls.push(`text:${req.model}:${req.maxTokens}`);
      if (options.failModel === req.model) throw new Error(`${req.model}: 404 model not found`);
      return { text: "OK", usage: makeUsage(), latencyMs: 250 };
    },
  };
}

export function sseResponse(events: readonly string[], chunkBytes = 7): Response {
  const bytes = new TextEncoder().encode(events.join(""));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkBytes));
      offset += chunkBytes;
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

export function skipTurnEvents(): string[] {
  const call = { index: 0, id: "call_skip_1", type: "function", function: { name: "skip_turn", arguments: '{"reason":"not_control_message"}' } };
  return [chunk({ role: "assistant", content: null, tool_calls: [call] }, null), chunk({}, "tool_calls"), "data: [DONE]\n\n"];
}

export function offRecordEvents(): string[] {
  const call = { index: 0, id: "call_off_record_1", type: "function", function: { name: "set_off_record", arguments: '{"offRecord":true}' } };
  return [chunk({ role: "assistant", content: null, tool_calls: [call] }, null), chunk({}, "tool_calls"), "data: [DONE]\n\n"];
}

export function speechEvents(text: string): string[] {
  const words = text.match(/\S+\s*/g) ?? [];
  return [
    chunk({ role: "assistant", content: "" }, null),
    ...words.map((w) => chunk({ content: w }, null)),
    chunk({}, "stop"),
    "data: [DONE]\n\n",
  ];
}

/** Mirrors `RESPEAK_WINDOW_MS` in apps/web/lib/server/authorizations.ts: a retry of a spoken nonce re-speaks the same text. */
export const RESPEAK_WINDOW_MS = 10_000;

type Authorization = { sessionId: string; nonce: string; expiresAt: number; used: boolean; spokenAt?: number };

export type FakeServerBehaviour = {
  /** Answer the unauthenticated chat request with 200 instead of 401. */
  acceptMissingAuth?: boolean;
  /** Speak for any user message (the bug the gate exists to prevent). */
  speakWithoutAuthorization?: boolean;
  /** Never mark nonces used, so a replay speaks again, even long after the retry window. */
  allowReplay?: boolean;
  /** Strict single use: no retry window, so a retry of a spoken nonce is refused at once (the pre-window behaviour). */
  strictSingleUse?: boolean;
  /** Behave like a server without the off-record branch: an off-record phrase gets skip_turn. */
  ignoreOffRecordPhrase?: boolean;
  deep?: { db?: boolean; dataDir?: boolean; z3?: boolean };
  /** What `/api/health/deep` reports as `llmCalls` (default "on"); null omits the field, as an older server would. */
  llmCalls?: "on" | "off" | null;
  /** Event-loop delay p99 `/api/health/deep` reports (default 4 ms); null omits `eventLoop`, as an older server would. */
  eventLoopP99Ms?: number | null;
  /** GC pause stats `/api/health/deep` reports; omitted by default (an older server does not report them). */
  gc?: { count: number; totalPauseMs: number; maxPauseMs: number; sinceMs: number };
  /** CPU-throttle counters `/api/health/deep` reports; `null` means the cgroup exposes none; omitted by default. */
  cpuThrottle?: { nrPeriods: number; nrThrottled: number; throttledMs: number } | null;
  /** Volume capacity `/api/health/deep` reports (default: 5 GB, 40% used); null means the platform cannot say; `"omit"` leaves it out, as an older server would. */
  disk?: { totalMB: number; freeMB: number; usedPct: number } | null | "omit";
  /** Behave like a server without accounts: the workbench and the voice-token endpoint answer anonymous callers. */
  accountsOff?: boolean;
};

/** An in-memory deployment implementing the server contract (health, deep, sandbox, authorize, custom LLM, token). */
export function fakeServer(behaviour: FakeServerBehaviour = {}, wallClock: () => number = Date.now) {
  const authorizations = new Map<string, Authorization>();
  const requests: { method: string; path: string; authorized: boolean }[] = [];
  let authorizeCount = 0;

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const authorized = headers.get("authorization") === `Bearer ${SECRET}`;
    requests.push({ method, path: `${url.pathname}${url.search}`, authorized });
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

    if (!url.href.startsWith(BASE_URL) && !url.href.startsWith("http://127.0.0.1")) throw new TypeError("fetch failed");
    switch (`${method} ${url.pathname}`) {
      case "GET /api/health":
        return json({ ok: true, uptimeS: 12, version: "0.1.0" });
      case "GET /api/health/deep": {
        if (!authorized) return json({ error: "unauthorized" }, 401);
        const d = { db: true, dataDir: true, z3: true, ...behaviour.deep };
        const part = (ok: boolean) => (ok ? { ok: true, ms: 1.5 } : { ok: false, error: "EACCES: permission denied" });
        const ok = d.db && d.dataDir && d.z3;
        const llmCalls = behaviour.llmCalls === undefined ? "on" : behaviour.llmCalls;
        const p99Ms = behaviour.eventLoopP99Ms === undefined ? 4 : behaviour.eventLoopP99Ms;
        const eventLoop = p99Ms === null ? null : { p50Ms: 0.5, p99Ms, maxMs: p99Ms * 3, samples: 6000, sinceMs: 60_000 };
        const body = {
          ok,
          db: part(d.db),
          dataDir: part(d.dataDir),
          z3: part(d.z3),
          ...(llmCalls !== null && { llmCalls }),
          ...(eventLoop !== null && { eventLoop }),
          ...(behaviour.gc !== undefined && { gc: behaviour.gc }),
          ...(behaviour.disk !== "omit" && { disk: behaviour.disk === undefined ? { totalMB: 5120, freeMB: 3072, usedPct: 40 } : behaviour.disk }),
          ...("cpuThrottle" in behaviour && { cpuThrottle: behaviour.cpuThrottle }),
        };
        return json(body, ok ? 200 : 503);
      }
      case "GET /sandbox":
        if (behaviour.accountsOff) return html("<!doctype html><title>CaseDesk</title><h1>CaseDesk</h1>");
        return new Response(null, { status: 302, headers: { location: `${BASE_URL}/login?next=%2Fsandbox` } });
      case "GET /login":
        return html("<!doctype html><title>Sign in</title><h1>Sign in</h1>");
      case "GET /api/voice/token":
        if (!behaviour.accountsOff) return json({ error: "unauthorized" }, 401);
        return json({ token: `public-token-${randomBytes(12).toString("hex")}`, conversationId: "conv_public_1" });
      case "POST /api/preflight/authorize": {
        if (!authorized) return json({ error: "unauthorized" }, 401);
        authorizeCount += 1;
        const nonce = randomBytes(32).toString("base64url");
        const sessionId = `preflight-${authorizeCount}`;
        const expiresAt = wallClock() + 60_000;
        authorizations.set(nonce, { sessionId, nonce, expiresAt, used: false });
        return json({ sessionId, nonce, controlMessage: `⟦ctl:${nonce}⟧`, text: PREFLIGHT_TEXT, expiresAt });
      }
      case "POST /api/llm/chat/completions": {
        if (!authorized && !behaviour.acceptMissingAuth) return json({ error: "unauthorized" }, 401);
        const body = JSON.parse(String(init?.body)) as {
          messages: { role: string; content: string }[];
          elevenlabs_extra_body?: { sessionId?: string };
        };
        return sseResponse(decide(body.messages.at(-1)?.content ?? "", body.elevenlabs_extra_body?.sessionId));
      }
      default:
        return json({ error: "not_found" }, 404);
    }
  };

  /** The custom-LLM invariant, shared with the fake ElevenLabs socket (which "calls" the same server). */
  function decide(text: string, sessionId: string | undefined): string[] {
    const nonce = /^⟦ctl:([A-Za-z0-9_-]+)⟧$/.exec(text)?.[1];
    const auth = nonce === undefined ? undefined : authorizations.get(nonce);
    const live = auth !== undefined && auth.sessionId === sessionId && auth.expiresAt > wallClock();
    const retry = live && auth.used && !behaviour.strictSingleUse && wallClock() - (auth.spokenAt ?? 0) <= RESPEAK_WINDOW_MS;
    if (live && (!auth.used || retry)) {
      if (!behaviour.allowReplay && !auth.used) {
        auth.used = true;
        auth.spokenAt = wallClock();
      }
      return speechEvents(PREFLIGHT_TEXT);
    }
    if (behaviour.speakWithoutAuthorization) return speechEvents("Sure, I can help with that.");
    return nonce === undefined && !behaviour.ignoreOffRecordPhrase && isOffRecordPhrase(text) ? offRecordEvents() : skipTurnEvents();
  }

  /** What the custom LLM would do for this turn: speak a text, or call a tool (skip_turn or a client tool). */
  function turnFor(text: string, sessionId: string | undefined): { speech: string } | { tool: string; args: Record<string, unknown> } {
    const deltas = decide(text, sessionId).flatMap((e) => {
      const data = e.slice("data: ".length).trim();
      if (data === "[DONE]") return [];
      const parsed = JSON.parse(data) as {
        choices: { delta: { content?: string | null; tool_calls?: { function: { name: string; arguments: string } }[] } }[];
      };
      return parsed.choices[0] ? [parsed.choices[0].delta] : [];
    });
    const call = deltas.find((d) => d.tool_calls)?.tool_calls?.[0];
    if (call) return { tool: call.function.name, args: JSON.parse(call.function.arguments) as Record<string, unknown> };
    return { speech: deltas.map((d) => d.content ?? "").join("") };
  }

  return { fetch: fetchImpl, requests, authorizations, turnFor, get authorizeCount() { return authorizeCount; } };
}

export type FakeServer = ReturnType<typeof fakeServer>;

export type SocketScript = {
  /** Speak for every user message regardless of the custom LLM (simulates pre_tool_speech or a bypass). */
  speakOnAnyMessage?: boolean;
  /** Never answer the authorised turn. */
  silent?: boolean;
  /** Close the socket from the server side right after metadata. */
  closeAfterMetadata?: boolean;
  /** Never send conversation_initiation_metadata. */
  noMetadata?: boolean;
  /** Emit an event type the client does not expect. */
  extraEvent?: string;
  /** Echo user_message text as user_transcript. */
  echoTranscript?: boolean;
  /** Deliver a client tool call twice (as if ElevenLabs re-invoked the LLM with the same turn). */
  repeatClientToolCall?: boolean;
};

export type FakeSocketRecord = {
  url: string;
  sent: Record<string, unknown>[];
  closedByClient: { code: number | undefined; reason: string | undefined } | null;
};

/**
 * A scripted ElevenLabs Agent WebSocket. Turns are decided by the fake server's custom LLM using the sessionId sent in
 * `custom_llm_extra_body`, exactly as ElevenLabs forwards it.
 */
export function fakeAgentSockets(server: FakeServer, script: SocketScript = {}) {
  const sockets: FakeSocketRecord[] = [];
  let eventId = 0;
  const factory: WebSocketFactory = (url: string, handlers: WebSocketHandlers) => {
    const record: FakeSocketRecord = { url, sent: [], closedByClient: null };
    sockets.push(record);
    let sessionId: string | undefined;
    let open = true;
    const emit = (type: string, body: Record<string, unknown>, delay = 1): void => {
      setTimeout(() => {
        if (open) handlers.message(JSON.stringify({ type, ...body }));
      }, delay);
    };
    const speak = (text: string): void => {
      emit("audio", { audio_event: { audio_base_64: "AAAA", event_id: ++eventId } }, 2);
      emit("audio", { audio_event: { audio_base_64: "BBBB", event_id: ++eventId } }, 3);
      emit("agent_response", { agent_response_event: { agent_response: text, event_id: ++eventId, response_id: "r1" } }, 4);
    };
    setTimeout(() => handlers.open(), 1);
    return {
      send(data: string) {
        if (!open) throw new Error("socket closed");
        const message = JSON.parse(data) as Record<string, unknown>;
        record.sent.push(message);
        if (message.type === "conversation_initiation_client_data") {
          const extra = message.custom_llm_extra_body as { sessionId?: string } | undefined;
          sessionId = extra?.sessionId;
          if (script.noMetadata) return;
          emit("conversation_initiation_metadata", {
            conversation_initiation_metadata_event: {
              conversation_id: `conv_${sockets.length}`,
              agent_output_audio_format: "pcm_16000",
              user_input_audio_format: "pcm_16000",
            },
          });
          emit("ping", { ping_event: { event_id: ++eventId, ping_ms: 30 } }, 2);
          if (script.closeAfterMetadata) {
            setTimeout(() => {
              open = false;
              handlers.close(1011, "internal error");
            }, 3);
          }
          if (script.extraEvent) emit(script.extraEvent, {}, 2);
        } else if (message.type === "user_message") {
          const text = String(message.text);
          if (script.echoTranscript) emit("user_transcript", { user_transcription_event: { user_transcript: text, event_id: ++eventId } });
          if (script.speakOnAnyMessage) {
            speak("Hmm, let me think about that.");
            return;
          }
          const turn = server.turnFor(text, sessionId);
          if ("speech" in turn) {
            if (!script.silent) speak(turn.speech);
          } else if (turn.tool === "skip_turn") {
            emit("agent_tool_response", {
              agent_tool_response: { tool_name: "skip_turn", tool_call_id: "c1", tool_type: "system", is_error: false, event_id: ++eventId, is_called: true, status: "success" },
            });
          } else {
            const calls = script.repeatClientToolCall ? 2 : 1;
            for (let i = 0; i < calls; i += 1) {
              emit("client_tool_call", { client_tool_call: { tool_name: turn.tool, tool_call_id: `ct${i}`, parameters: turn.args, event_id: ++eventId } }, 2 + i);
            }
          }
        }
      },
      close(code?: number, reason?: string) {
        record.closedByClient = { code, reason };
        if (!open) return;
        open = false;
        setTimeout(() => handlers.close(code ?? 1005, reason ?? ""), 1);
      },
    };
  };
  return { factory, sockets };
}

export function fakeElevenLabs(overrides: Partial<PreflightElevenLabs> = {}): PreflightElevenLabs & { signedUrls: string[] } {
  const signedUrls: string[] = [];
  return {
    signedUrls,
    async getAgent(agentId) {
      return { agent_id: agentId };
    },
    async getConversationToken(agentId) {
      return { token: `tok_${agentId}_${randomBytes(16).toString("hex")}`, conversationId: `conv_${agentId}` };
    },
    async getSignedUrl(agentId) {
      const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}&conversation_signature=sig_${randomBytes(16).toString("hex")}`;
      signedUrls.push(url);
      return url;
    },
    async listSecrets() {
      return [];
    },
    async getTool(toolId) {
      throw new Error(`ElevenLabs GET /v1/convai/tools/${toolId} failed (HTTP 404)`);
    },
    ...overrides,
  };
}

export function makeContext(overrides: Partial<PreflightContext> & { cliTarget?: string } = {}): PreflightContext {
  const { cliTarget, ...rest } = overrides;
  const env = rest.env ?? GOOD_ENV;
  // One clock the whole fake deployment shares: `sleep` advances it, so waiting costs no real time.
  let clockNow = Date.now();
  const clock = () => clockNow;
  const server = fakeServer({}, clock);
  return {
    env,
    envFileLoaded: false,
    target: resolveTarget({ cliTarget, publicBaseUrl: env.PUBLIC_BASE_URL }),
    options: { ...DEFAULT_OPTIONS, quietWindowMs: 40, speechTimeoutMs: 200, connectTimeoutMs: 200, httpTimeoutMs: 2_000 },
    fetch: server.fetch,
    WebSocket: fakeAgentSockets(server).factory,
    createClaude: () => fakeClaude(),
    createElevenLabs: () => fakeElevenLabs(),
    loadAgentSpec: (role: AgentRole) => loadAgentSpec(new URL(`../../../agents/${role}.json`, import.meta.url)),
    secrets: createSecretRegistry([env.ANTHROPIC_API_KEY, env.ELEVENLABS_API_KEY, env.CUSTOM_LLM_SECRET]),
    now: () => performance.now(),
    wallClock: clock,
    sleep: async (ms) => {
      clockNow += ms;
    },
    ...rest,
  };
}
