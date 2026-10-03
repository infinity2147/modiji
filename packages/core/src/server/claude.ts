/**
 * Anthropic wrapper (plan §5 model routing; api-notes §8–10). The model only extracts, proposes,
 * parses and phrases; callers validate everything it returns. Every request is screened by the
 * oracle prompt guard before it leaves the process. Prompts, outputs and keys are never logged.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { OracleMarkerSchema, assertNoOracleMarkers } from "../oracle-guard";

/** Model routing, plan §5. IDs verified against the SDK `Model` union (api-notes §10). */
export const CLAUDE_MODELS = {
  /** Per-frame screen-event extraction. Earliest retirement 15 Oct 2026 (api-notes §10). */
  frameEvents: "claude-haiku-4-5-20251001",
  /** Hypothesis proposals, answer parsing, question phrasing. */
  reasoning: "claude-sonnet-5-5",
  /** Teach-back prose, step titles, summaries (non-authoritative). Thinking is always on: budget `maxTokens` for it. */
  prose: "claude-opus-5-5",
} as const satisfies Record<string, Anthropic.Model>;
export type ClaudeModel = (typeof CLAUDE_MODELS)[keyof typeof CLAUDE_MODELS];

/** Inline image (vision). Its base64 payload is the only request content the oracle guard does not scan. */
export type ClaudeImageBlock = Omit<Anthropic.ImageBlockParam, "source"> & { source: Anthropic.Base64ImageSource };
export type ClaudeContentBlock = Anthropic.TextBlockParam | ClaudeImageBlock;
export type ClaudeMessage = { role: "user" | "assistant"; content: string | ClaudeContentBlock[] };

export type ClaudeRequest = {
  model: ClaudeModel;
  system: string;
  messages: ClaudeMessage[];
  maxTokens: number;
  /**
   * Marks the system prompt as a cache breakpoint (`cache_control: ephemeral`, 5 min TTL).
   * Prefixes below the model minimum are silently not cached: 512 tokens for Opus/Sonnet 5.5,
   * 4,096 for Haiku 4.5 (api-notes §9). A different structured-output schema also misses the
   * cache. Check `usage.cache_read_input_tokens` to confirm hits.
   */
  cacheSystem?: boolean;
};
export type StructuredRequest<S extends z.ZodType> = ClaudeRequest & { schema: S };

/** Stop reasons after which the output is complete; every other one throws `ClaudeError`. */
export type CompleteStopReason = Extract<Anthropic.StopReason, "end_turn" | "stop_sequence">;

export type StructuredResult<T> = { output: T; usage: Anthropic.Usage; latencyMs: number; stopReason: CompleteStopReason };
export type TextResult = { text: string; usage: Anthropic.Usage; latencyMs: number };

export type ClaudeErrorCode = "refusal" | "max_tokens" | "unexpected_stop" | "invalid_output";

/** The model answered but the answer is unusable. Messages never include prompt or output text. */
export class ClaudeError extends Error {
  override readonly name: string = "ClaudeError";
  readonly code: ClaudeErrorCode;
  readonly model: ClaudeModel;

  constructor(code: ClaudeErrorCode, model: ClaudeModel, message: string, options?: ErrorOptions) {
    super(`${model}: ${message}`, options);
    this.code = code;
    this.model = model;
  }
}

/** The subset of the SDK client the wrapper uses; an `Anthropic` instance satisfies it, tests inject a fake. */
export type ClaudeClient = {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): PromiseLike<Anthropic.Message> };
};

export type CreateClaudeOptions = ({ apiKey: string; client?: never } | { client: ClaudeClient; apiKey?: never }) & {
  /** `ORACLE_MARKER` of every hidden-policy module loaded in this process; any request containing one is refused. */
  forbiddenMarkers: readonly string[];
  /** Monotonic clock in ms (tests). */
  now?: () => number;
};

export type Claude = {
  structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>>;
  text(req: ClaudeRequest): Promise<TextResult>;
};

function isBase64ImageSource(value: object): boolean {
  return "type" in value && value.type === "base64" && "media_type" in value && String(value.media_type).startsWith("image/");
}

/** Every string the request sends — system, message text, schema descriptions, anything else — except base64 image payloads. */
function requestStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) requestStrings(item, out);
  else if (typeof value === "object" && value !== null) {
    const skipData = isBase64ImageSource(value);
    for (const [key, item] of Object.entries(value)) if (!(skipData && key === "data")) requestStrings(item, out);
  }
  return out;
}

export function createClaude(options: CreateClaudeOptions): Claude {
  const parsedMarkers = z.array(OracleMarkerSchema).safeParse(options.forbiddenMarkers);
  if (!parsedMarkers.success) throw new TypeError("forbiddenMarkers must contain only oracle markers (oracle:<domainId>:<hex>)");
  const markers = parsedMarkers.data;
  const now = options.now ?? (() => performance.now());

  let client: ClaudeClient;
  if (options.client) client = options.client;
  else if (options.apiKey.trim() !== "") {
    // Pinned so ANTHROPIC_LOG=debug cannot make the SDK log request bodies.
    client = new Anthropic({ apiKey: options.apiKey, logLevel: "warn" });
  } else throw new TypeError("apiKey is empty");

  async function send(
    req: ClaudeRequest,
    outputConfig?: Anthropic.OutputConfig,
  ): Promise<{ message: Anthropic.Message; latencyMs: number; text: string; stopReason: CompleteStopReason }> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.cacheSystem ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }] : req.system,
      messages: req.messages,
      ...(outputConfig && { output_config: outputConfig }),
    };
    // Scans the exact object that is sent, so nothing added above escapes the guard.
    assertNoOracleMarkers(requestStrings(params), markers);

    const started = now();
    const message = await client.messages.create(params);
    const latencyMs = now() - started;

    const stopReason = message.stop_reason;
    if (stopReason === "refusal") throw new ClaudeError("refusal", req.model, "the model refused the request");
    if (stopReason === "max_tokens") throw new ClaudeError("max_tokens", req.model, `output truncated at maxTokens=${req.maxTokens}`);
    if (stopReason !== "end_turn" && stopReason !== "stop_sequence") {
      throw new ClaudeError("unexpected_stop", req.model, `unexpected stop_reason ${String(stopReason)}`);
    }
    // Thinking blocks (always on for Opus 5.5) are not output.
    const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    if (text === "") throw new ClaudeError("invalid_output", req.model, "the response has no text content");
    return { message, latencyMs, text, stopReason };
  }

  return {
    async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>> {
      // `zodOutputFormat` converts the schema to the constrained-decoding JSON Schema (moving unsupported
      // constraints such as min/max into descriptions). We call `messages.create`, not `messages.parse`:
      // `parse` validates inside the SDK before returning, so a refusal or a max_tokens truncation would
      // surface as an opaque parse error instead of its stop_reason (api-notes §8: check stop_reason first).
      const { schema, ...rest } = req;
      const { message, latencyMs, text, stopReason } = await send(rest, { format: zodOutputFormat(schema) });
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        // No cause: a SyntaxError quotes the output.
        throw new ClaudeError("invalid_output", req.model, "structured output is not valid JSON");
      }
      // The full zod schema is enforced here, including the constraints the decoder could not.
      const result = schema.safeParse(json);
      if (!result.success) {
        throw new ClaudeError("invalid_output", req.model, `structured output failed validation:\n${z.prettifyError(result.error)}`, {
          cause: result.error,
        });
      }
      return { output: result.data, usage: message.usage, latencyMs, stopReason };
    },

    async text(req: ClaudeRequest): Promise<TextResult> {
      const { message, latencyMs, text } = await send(req);
      return { text, usage: message.usage, latencyMs };
    },
  };
}
