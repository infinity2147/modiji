/** Shared setup for the custom-LLM handler tests: in-memory ledger, fake clock, captured logs, SSE parsing. */
import { expect } from "vitest";
import { z } from "zod";
import { createLedger, openDatabase, type Ledger, type OpenedDatabase } from "@vashistha/core/server";
import { createAuthorizationStore, type AuthorizationStore } from "../../lib/server/authorizations";
import { handleChatCompletion, type CustomLlmDeps } from "../../lib/server/custom-llm";

export const SECRET = "test-secret-0123456789-abcdefghijklmnop";
export const T0 = 1_760_000_000_000;

export type Harness = {
  opened: OpenedDatabase;
  ledger: Ledger;
  authorizations: AuthorizationStore;
  deps: CustomLlmDeps;
  logs: string[];
  advance: (ms: number) => void;
  now: () => number;
  call: (body: unknown, headers?: Record<string, string>, signal?: AbortSignal) => Promise<Response>;
};

export function createHarness(): Harness {
  const opened = openDatabase({ memory: true });
  const ledger = createLedger(opened.db);
  let clock = T0;
  const now = () => clock;
  const authorizations = createAuthorizationStore({ now });
  const logs: string[] = [];
  const capture = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  const deps: CustomLlmDeps = {
    secret: SECRET,
    authorizations,
    ledger,
    now,
    log: { info: capture, warn: capture, error: capture },
  };
  return {
    opened,
    ledger,
    authorizations,
    deps,
    logs,
    now,
    advance: (ms) => {
      clock += ms;
    },
    call: (body, headers = { authorization: `Bearer ${SECRET}` }, signal) =>
      handleChatCompletion(chatRequest(body, headers, signal), deps, performance.now()),
  };
}

export function chatRequest(body: unknown, headers: Record<string, string>, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/llm/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

/** A request body as ElevenLabs sends it (system prompt first, `stream: true`, system tools listed). */
export function chatBody(opts: {
  model?: string;
  messages: Array<{ role: string; content: unknown }>;
  extraBody?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    model: opts.model ?? "vashistha-interviewer-v1",
    messages: [{ role: "system", content: "You are the interviewer." }, ...opts.messages],
    temperature: 0.5,
    max_tokens: 256,
    stream: true,
    tools: [{ type: "function", function: { name: "skip_turn", parameters: { type: "object", properties: {} } } }],
    ...(opts.extraBody ? { elevenlabs_extra_body: opts.extraBody } : {}),
  };
}

const ChunkSchema = z.strictObject({
  id: z.string().regex(/^chatcmpl-[A-Za-z0-9_-]{8,}$/),
  object: z.literal("chat.completion.chunk"),
  created: z.int().positive(),
  model: z.string(),
  choices: z.tuple([
    z.strictObject({
      index: z.literal(0),
      delta: z.record(z.string(), z.unknown()),
      finish_reason: z.enum(["stop", "tool_calls"]).nullable(),
    }),
  ]),
});
export type Chunk = z.infer<typeof ChunkSchema>;

const SkipDeltaSchema = z.strictObject({
  role: z.literal("assistant"),
  content: z.null(),
  tool_calls: z.tuple([
    z.strictObject({
      index: z.literal(0),
      id: z.string().regex(/^call_skip_[A-Za-z0-9_-]+$/),
      type: z.literal("function"),
      function: z.strictObject({ name: z.literal("skip_turn"), arguments: z.string() }),
    }),
  ]),
});

export type ParsedTurn =
  | { kind: "speech"; text: string; chunks: Chunk[]; raw: string }
  | { kind: "skip"; reason: string; chunks: Chunk[]; raw: string };

/**
 * Parses an SSE body and asserts it is exactly one of the two shapes the wrapper may emit:
 * speech (role chunk, content chunks, stop) or skip (one skip_turn tool call, tool_calls), then [DONE].
 */
export async function readTurn(response: Response): Promise<ParsedTurn> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  const raw = await response.text();

  expect(raw.endsWith("\n\ndata: [DONE]\n\n")).toBe(true);
  const events = raw.slice(0, -2).split("\n\n");
  expect(events.pop()).toBe("data: [DONE]");
  const chunks = events.map((event) => {
    expect(event.startsWith("data: ")).toBe(true);
    expect(event.includes("\n")).toBe(false);
    return ChunkSchema.parse(JSON.parse(event.slice("data: ".length)));
  });
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  const [first] = chunks;
  const last = chunks.at(-1);
  if (!first || !last) throw new Error("unreachable");
  for (const chunk of chunks) {
    expect(chunk.id).toBe(first.id);
    expect(chunk.created).toBe(first.created);
    expect(chunk.model).toBe(first.model);
  }
  const deltas = chunks.map((c) => c.choices[0]);
  expect(last.choices[0].delta).toEqual({});
  for (const d of deltas.slice(0, -1)) expect(d.finish_reason).toBeNull();

  if (last.choices[0].finish_reason === "tool_calls") {
    expect(chunks).toHaveLength(2);
    const delta = SkipDeltaSchema.parse(first.choices[0].delta);
    const args = z.strictObject({ reason: z.string() }).parse(JSON.parse(delta.tool_calls[0].function.arguments));
    return { kind: "skip", reason: args.reason, chunks, raw };
  }

  expect(last.choices[0].finish_reason).toBe("stop");
  expect(first.choices[0].delta).toEqual({ role: "assistant", content: "" });
  const content = chunks.slice(1, -1).map((c) => z.strictObject({ content: z.string().min(1) }).parse(c.choices[0].delta).content);
  expect(content.length).toBeGreaterThan(0);
  return { kind: "speech", text: content.join(""), chunks, raw };
}
