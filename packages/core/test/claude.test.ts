import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OracleLeakError } from "../src";
import {
  CLAUDE_MODELS,
  ClaudeError,
  createClaude,
  type ClaudeClient,
  type ClaudeMessage,
  type ClaudeRequest,
} from "../src/server";

const MARKER = "oracle:kyc:9e3019f4d3df24eddabea38ef7bba13d";

const USAGE: Anthropic.Usage = {
  cache_creation: null,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  inference_geo: null,
  input_tokens: 120,
  output_tokens: 30,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: "standard",
};

const textBlock = (text: string): Anthropic.TextBlock => ({ type: "text", text, citations: null });
const thinkingBlock: Anthropic.ThinkingBlock = { type: "thinking", thinking: "…", signature: "sig" };

function reply(overrides: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: "msg_test",
    container: null,
    content: [],
    diagnostics: null,
    model: CLAUDE_MODELS.reasoning,
    role: "assistant",
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: USAGE,
    ...overrides,
  };
}

/** A client implementing only `messages.create`, answering every call with `message`. */
function fakeClient(message: Anthropic.Message) {
  const create = vi.fn<ClaudeClient["messages"]["create"]>(() => Promise.resolve(message));
  return { client: { messages: { create } } satisfies ClaudeClient, create };
}

/** Clock returning the given readings in order. */
function clock(...readings: number[]): () => number {
  return () => {
    const next = readings.shift();
    if (next === undefined) throw new Error("clock exhausted");
    return next;
  };
}

const Answer = z.strictObject({
  field: z.enum(["amount", "country"]),
  // min/max are not expressible in the decoder's JSON Schema subset, so only the zod re-validation enforces them.
  confidence: z.number().min(0).max(1),
});

const userMessage: ClaudeMessage = { role: "user", content: "Which field changed?" };

const baseRequest = {
  model: CLAUDE_MODELS.reasoning,
  system: "You extract field changes.",
  messages: [userMessage],
  maxTokens: 512,
} satisfies ClaudeRequest;

describe("createClaude: oracle prompt guard", () => {
  const leaks: [string, Partial<ClaudeRequest>][] = [
    ["the system prompt", { system: `Policy: ${MARKER}` }],
    ["a string user message", { messages: [{ role: "user", content: `see ${MARKER}` }] }],
    [
      "a text block after an image",
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
              { type: "text", text: `frame notes ${MARKER}` },
            ],
          },
        ],
      },
    ],
    ["an earlier assistant turn", { messages: [{ role: "assistant", content: MARKER }, userMessage] }],
  ];

  it.each(leaks)("refuses a marker in %s and never calls the client", async (_where, overrides) => {
    const { client, create } = fakeClient(reply({ content: [textBlock('{"field":"amount","confidence":1}')] }));
    const claude = createClaude({ client, forbiddenMarkers: [MARKER] });
    const error = await claude.structured({ ...baseRequest, ...overrides, schema: Answer }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OracleLeakError);
    expect((error as OracleLeakError).domainIds).toEqual(["kyc"]);
    expect((error as Error).message).not.toContain(MARKER);
    await expect(claude.text({ ...baseRequest, ...overrides })).rejects.toBeInstanceOf(OracleLeakError);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a marker in the output schema, which the model also reads", async () => {
    const { client, create } = fakeClient(reply({ content: [textBlock('{"field":"amount","confidence":1}')] }));
    const schema = Answer.describe(`Answer per ${MARKER}`);
    await expect(createClaude({ client, forbiddenMarkers: [MARKER] }).structured({ ...baseRequest, schema })).rejects.toBeInstanceOf(
      OracleLeakError,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("forwards image blocks unchanged without scanning their base64 payload", async () => {
    const { client, create } = fakeClient(reply({ content: [textBlock("ok")] }));
    const image = { type: "image", source: { type: "base64", media_type: "image/webp", data: MARKER } } as const;
    const claude = createClaude({ client, forbiddenMarkers: [MARKER] });
    await claude.text({ ...baseRequest, messages: [{ role: "user", content: [image, { type: "text", text: "Describe." }] }] });
    expect(create.mock.calls[0]?.[0].messages[0]?.content).toEqual([image, { type: "text", text: "Describe." }]);
  });

  it("rejects forbidden markers that are not oracle markers", () => {
    const { client } = fakeClient(reply({}));
    expect(() => createClaude({ client, forbiddenMarkers: [""] })).toThrow(TypeError);
    expect(() => createClaude({ client, forbiddenMarkers: ["kyc-policy"] })).toThrow(TypeError);
  });

  it("rejects an empty API key", () => {
    expect(() => createClaude({ apiKey: "  ", forbiddenMarkers: [] })).toThrow("apiKey is empty");
  });
});

describe("createClaude: structured", () => {
  it("returns the validated output with usage, latency and stop reason", async () => {
    const { client, create } = fakeClient(
      reply({ content: [thinkingBlock, textBlock('{"field":"country","confidence":0.75}')] }),
    );
    const claude = createClaude({ client, forbiddenMarkers: [MARKER], now: clock(1_000, 1_250) });
    const result = await claude.structured({ ...baseRequest, schema: Answer });

    expect(result).toEqual({ output: { field: "country", confidence: 0.75 }, usage: USAGE, latencyMs: 250, stopReason: "end_turn" });
    const output: { field: "amount" | "country"; confidence: number } = result.output;
    expect(output.field).toBe("country");

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 512,
      system: "You extract field changes.",
      messages: [userMessage],
      output_config: { format: { type: "json_schema", schema: { type: "object", additionalProperties: false } } },
    });
  });

  it.each([
    ["the model refuses", reply({ stop_reason: "refusal", content: [textBlock("I can't help with that.")] }), "refusal"],
    ["the output is truncated", reply({ stop_reason: "max_tokens", content: [textBlock('{"field":"amo')] }), "max_tokens"],
    ["the model stops for a tool", reply({ stop_reason: "tool_use", content: [] }), "unexpected_stop"],
    ["the stop reason is missing", reply({ stop_reason: null, content: [textBlock("{}")] }), "unexpected_stop"],
    ["there is no text block", reply({ content: [thinkingBlock] }), "invalid_output"],
    ["the text is not JSON", reply({ content: [textBlock("field: amount")] }), "invalid_output"],
    ["the JSON violates a zod-only constraint", reply({ content: [textBlock('{"field":"amount","confidence":1.5}')] }), "invalid_output"],
    ["the JSON has an extra key", reply({ content: [textBlock('{"field":"amount","confidence":1,"x":1}')] }), "invalid_output"],
  ] as const)("throws ClaudeError when %s", async (_case, message, code) => {
    const { client } = fakeClient(message);
    const error = await createClaude({ client, forbiddenMarkers: [] })
      .structured({ ...baseRequest, schema: Answer })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeError);
    expect(error).toMatchObject({ code, model: "claude-sonnet-5-5" });
    // Errors never quote the model's output.
    for (const block of message.content) if (block.type === "text" && block.text.length > 2) expect((error as Error).message).not.toContain(block.text);
  });
});

describe("createClaude: prompt caching", () => {
  it("sends the system prompt as one ephemeral cache breakpoint when cacheSystem is set", async () => {
    const { client, create } = fakeClient(reply({ content: [textBlock("Summary.")] }));
    const claude = createClaude({ client, forbiddenMarkers: [] });
    await claude.text({ ...baseRequest, model: CLAUDE_MODELS.prose, cacheSystem: true });
    const params = create.mock.calls[0]?.[0];
    expect(params?.system).toEqual([{ type: "text", text: "You extract field changes.", cache_control: { type: "ephemeral" } }]);
    expect(params?.messages).toEqual([userMessage]);
    expect(params).not.toHaveProperty("output_config");
  });

  it("sends the system prompt as a plain string otherwise", async () => {
    const { client, create } = fakeClient(reply({ content: [textBlock("Summary.")] }));
    await createClaude({ client, forbiddenMarkers: [] }).text({ ...baseRequest, cacheSystem: false });
    expect(create.mock.calls[0]?.[0].system).toBe("You extract field changes.");
  });
});

describe("createClaude: text", () => {
  it("joins the text blocks, skipping thinking, and reports latency", async () => {
    const { client } = fakeClient(reply({ content: [thinkingBlock, textBlock("Step 1. "), textBlock("Check the amount.")] }));
    const result = await createClaude({ client, forbiddenMarkers: [], now: clock(5, 47) }).text(baseRequest);
    expect(result).toEqual({ text: "Step 1. Check the amount.", usage: USAGE, latencyMs: 42 });
  });

  it("throws on a truncated answer", async () => {
    const { client } = fakeClient(reply({ stop_reason: "max_tokens", content: [textBlock("Step 1. Che")] }));
    await expect(createClaude({ client, forbiddenMarkers: [] }).text(baseRequest)).rejects.toMatchObject({ code: "max_tokens" });
  });
});

describe("createClaude: wire format through the real SDK", () => {
  it("sends output_config.format as JSON Schema (no client-side parse hook) with the API key header", async () => {
    let body: unknown;
    let headers: IncomingHttpHeaders = {};
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        headers = req.headers;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply({ content: [textBlock('{"field":"amount","confidence":0.5}')] })));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const { port } = server.address() as AddressInfo;
      const client = new Anthropic({ apiKey: "sk-ant-test-key", baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 });
      const claude = createClaude({ client, forbiddenMarkers: [MARKER] });
      const result = await claude.structured({ ...baseRequest, cacheSystem: true, schema: Answer });

      expect(result.output).toEqual({ field: "amount", confidence: 0.5 });
      expect(headers["x-api-key"]).toBe("sk-ant-test-key");
      expect(body).toEqual({
        model: "claude-sonnet-5-5",
        max_tokens: 512,
        system: [{ type: "text", text: "You extract field changes.", cache_control: { type: "ephemeral" } }],
        messages: [userMessage],
        output_config: {
          format: {
            type: "json_schema",
            schema: expect.objectContaining({
              type: "object",
              additionalProperties: false,
              required: ["field", "confidence"],
            }) as unknown,
          },
        },
      });
    } finally {
      server.close();
    }
  });
});
