/**
 * Strict Server-Sent Events parsing (WHATWG "event stream interpretation") and interpretation of an OpenAI
 * chat-completions stream, used to check the custom-LLM endpoint the way ElevenLabs consumes it.
 *
 * "Strict" means: lines may end in LF, CRLF or CR, including terminators and multi-byte UTF-8 characters split across
 * network chunks; comments are ignored; but anything a lenient client would silently tolerate (unknown fields, a
 * field line without a colon, a stream that ends mid-event, data after `[DONE]`) is reported as an error.
 */

export type SseEvent = { event: string; data: string; id: string | null };

export type SseParser = {
  /** Feeds one network chunk; returns the events completed by it. */
  push(chunk: Uint8Array | string): SseEvent[];
  /** Flushes the decoder at end of stream; returns any final event (none, if the stream was well-formed). */
  end(): SseEvent[];
  /** Protocol errors seen so far (malformed lines, truncated final event). */
  readonly errors: readonly string[];
};

const KNOWN_FIELDS = new Set(["event", "data", "id", "retry"]);
const MAX_ERROR_SAMPLE = 60;

function sample(line: string): string {
  return JSON.stringify(line.length > MAX_ERROR_SAMPLE ? `${line.slice(0, MAX_ERROR_SAMPLE)}…` : line);
}

export function createSseParser(): SseParser {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const errors: string[] = [];
  let buffer = "";
  /** A chunk ended in CR: if the next chunk starts with LF, it belongs to the same terminator. */
  let pendingCr = false;
  let lineNo = 0;
  let data: string[] = [];
  let eventType = "";
  let lastId: string | null = null;
  let hasFields = false;

  const dispatch = (out: SseEvent[]): void => {
    if (data.length > 0) out.push({ event: eventType || "message", data: data.join("\n"), id: lastId });
    data = [];
    eventType = "";
    hasFields = false;
  };

  const processLine = (line: string, out: SseEvent[]): void => {
    lineNo += 1;
    if (line === "") {
      dispatch(out);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    if (colon === -1) {
      errors.push(`line ${lineNo}: field without a colon ${sample(line)}`);
      return;
    }
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (!KNOWN_FIELDS.has(field)) {
      errors.push(`line ${lineNo}: unknown field ${sample(field)}`);
      return;
    }
    hasFields = true;
    if (field === "data") data.push(value);
    else if (field === "event") eventType = value;
    else if (field === "id") {
      if (!value.includes("\0")) lastId = value;
    } else if (!/^\d+$/.test(value)) errors.push(`line ${lineNo}: retry is not an integer ${sample(value)}`);
  };

  const drain = (text: string, final: boolean): SseEvent[] => {
    const out: SseEvent[] = [];
    if (pendingCr && text.startsWith("\n")) text = text.slice(1);
    pendingCr = false;
    buffer += text;
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (!match) break;
      // A trailing lone CR may be the first half of a CRLF split across chunks.
      if (match[0] === "\r" && match.index === buffer.length - 1 && !final) {
        processLine(buffer.slice(0, match.index), out);
        buffer = "";
        pendingCr = true;
        break;
      }
      processLine(buffer.slice(0, match.index), out);
      buffer = buffer.slice(match.index + match[0].length);
    }
    return out;
  };

  return {
    push: (chunk) => drain(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }), false),
    end() {
      const out = drain(decoder.decode(), true);
      if (buffer !== "") {
        errors.push(`stream ended inside a line ${sample(buffer)}`);
        buffer = "";
      }
      if (hasFields) errors.push("stream ended before the final event was terminated by a blank line");
      return out;
    },
    get errors() {
      return errors;
    },
  };
}

/** Parses a complete SSE body given as chunks (tests and small bodies). */
export function parseSseChunks(chunks: Iterable<Uint8Array | string>): { events: SseEvent[]; errors: string[] } {
  const parser = createSseParser();
  const events: SseEvent[] = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.end());
  return { events, errors: [...parser.errors] };
}

export type ChatToolCall = { index: number; id: string | null; name: string; arguments: string };

/** What an OpenAI chat-completions stream said, plus every way it deviated from the protocol. */
export type ChatStream = {
  /** Concatenated `delta.content`. */
  content: string;
  /** Tool calls assembled from `delta.tool_calls` fragments, by index. */
  toolCalls: ChatToolCall[];
  finishReasons: string[];
  /** `data: [DONE]` was received. */
  done: boolean;
  chunks: number;
  errors: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function interpretChatStream(events: readonly SseEvent[], parseErrors: readonly string[] = []): ChatStream {
  const result: ChatStream = { content: "", toolCalls: [], finishReasons: [], done: false, chunks: 0, errors: [...parseErrors] };
  const calls = new Map<number, ChatToolCall>();
  for (const [i, event] of events.entries()) {
    if (result.done) {
      result.errors.push(`event ${i + 1}: data after [DONE]`);
      continue;
    }
    if (event.event !== "message") result.errors.push(`event ${i + 1}: unexpected event type ${JSON.stringify(event.event)}`);
    if (event.data === "[DONE]") {
      result.done = true;
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(event.data);
    } catch {
      result.errors.push(`event ${i + 1}: data is not JSON`);
      continue;
    }
    result.chunks += 1;
    if (!isRecord(json) || json.object !== "chat.completion.chunk" || !Array.isArray(json.choices)) {
      result.errors.push(`event ${i + 1}: not a chat.completion.chunk with choices[]`);
      continue;
    }
    for (const choice of json.choices) {
      if (!isRecord(choice) || !isRecord(choice.delta)) {
        result.errors.push(`event ${i + 1}: choice without a delta object`);
        continue;
      }
      const { delta } = choice;
      if (typeof delta.content === "string") result.content += delta.content;
      else if (delta.content !== undefined && delta.content !== null) result.errors.push(`event ${i + 1}: non-string content`);
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (!isRecord(call) || typeof call.index !== "number") {
            result.errors.push(`event ${i + 1}: tool call without an index`);
            continue;
          }
          const existing = calls.get(call.index) ?? { index: call.index, id: null, name: "", arguments: "" };
          if (typeof call.id === "string") existing.id = call.id;
          const fn = isRecord(call.function) ? call.function : {};
          if (typeof fn.name === "string") existing.name += fn.name;
          if (typeof fn.arguments === "string") existing.arguments += fn.arguments;
          calls.set(call.index, existing);
        }
      }
      if (typeof choice.finish_reason === "string") result.finishReasons.push(choice.finish_reason);
    }
  }
  if (!result.done) result.errors.push("stream ended without data: [DONE]");
  result.toolCalls = [...calls.values()].sort((a, b) => a.index - b.index);
  return result;
}

/** Reads a fetch Response body as SSE, chunk by chunk, until it ends (callers bound it with an AbortSignal). */
export async function readSseResponse(
  response: Response,
  onFirstChunk?: () => void,
): Promise<{ events: SseEvent[]; errors: string[] }> {
  const parser = createSseParser();
  const events: SseEvent[] = [];
  if (response.body === null) return { events, errors: ["response has no body"] };
  const reader = response.body.getReader();
  let first = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (first) {
      first = false;
      onFirstChunk?.();
    }
    events.push(...parser.push(value));
  }
  events.push(...parser.end());
  return { events, errors: [...parser.errors] };
}
