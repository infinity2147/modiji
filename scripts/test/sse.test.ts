import { describe, expect, it } from "vitest";
import { createSseParser, interpretChatStream, parseSseChunks, readSseResponse } from "../preflight/sse";
import { skipTurnEvents, speechEvents, sseResponse } from "./support/fakes";

const enc = (s: string) => new TextEncoder().encode(s);

describe("createSseParser", () => {
  it("parses data events and ignores comments", () => {
    const { events, errors } = parseSseChunks([": keep-alive\n", "data: {\"a\":1}\n\n", "data: [DONE]\n\n"]);
    expect(errors).toEqual([]);
    expect(events.map((e) => e.data)).toEqual(['{"a":1}', "[DONE]"]);
    expect(events[0]?.event).toBe("message");
  });

  it("joins multi-line data with LF and honours event/id fields", () => {
    const { events, errors } = parseSseChunks(["event: update\nid: 7\ndata: line one\ndata: line two\n\n"]);
    expect(errors).toEqual([]);
    expect(events).toEqual([{ event: "update", data: "line one\nline two", id: "7" }]);
  });

  it("handles every split point of a stream, including CRLF and multi-byte characters", () => {
    const text = "data: ⟦ctl:abc⟧ ✓\r\n\r\ndata: second\r\rdata: third\n\ndata: [DONE]\n\n";
    const bytes = enc(text);
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const { events, errors } = parseSseChunks([bytes.slice(0, cut), bytes.slice(cut)]);
      expect(errors, `cut at ${cut}`).toEqual([]);
      expect(events.map((e) => e.data), `cut at ${cut}`).toEqual(["⟦ctl:abc⟧ ✓", "second", "third", "[DONE]"]);
    }
  });

  it("handles a byte-at-a-time stream", () => {
    const bytes = enc(skipTurnEvents().join(""));
    const parser = createSseParser();
    const events = [];
    for (const b of bytes) events.push(...parser.push(new Uint8Array([b])));
    events.push(...parser.end());
    expect(parser.errors).toEqual([]);
    expect(events).toHaveLength(3);
  });

  it("reports malformed lines, unknown fields and a truncated final event", () => {
    const { events, errors } = parseSseChunks(["garbage line\n", "foo: bar\n", "retry: soon\n", "data: ok\n\n", "data: cut"]);
    expect(events.map((e) => e.data)).toEqual(["ok"]);
    expect(errors).toHaveLength(4);
    expect(errors.join("\n")).toMatch(/without a colon/);
    expect(errors.join("\n")).toMatch(/unknown field "foo"/);
    expect(errors.join("\n")).toMatch(/retry is not an integer/);
    expect(errors.join("\n")).toMatch(/stream ended inside a line/);
  });

  it("reports an event left without its terminating blank line", () => {
    const { events, errors } = parseSseChunks(["data: [DONE]\n"]);
    expect(events).toEqual([]);
    expect(errors).toEqual(["stream ended before the final event was terminated by a blank line"]);
  });
});

describe("interpretChatStream", () => {
  it("assembles a streamed skip_turn tool call", () => {
    const { events, errors } = parseSseChunks(skipTurnEvents());
    const s = interpretChatStream(events, errors);
    expect(s.errors).toEqual([]);
    expect(s.done).toBe(true);
    expect(s.content).toBe("");
    expect(s.toolCalls).toEqual([{ index: 0, id: "call_skip_1", name: "skip_turn", arguments: '{"reason":"not_control_message"}' }]);
    expect(s.finishReasons).toEqual(["tool_calls"]);
  });

  it("assembles tool-call name and arguments split across chunks", () => {
    const c = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const { events } = parseSseChunks([
      c({ tool_calls: [{ index: 0, id: "x", function: { name: "skip_", arguments: '{"rea' } }] }),
      c({ tool_calls: [{ index: 0, function: { name: "turn", arguments: 'son":"r"}' } }] }),
      c({}, "tool_calls"),
      "data: [DONE]\n\n",
    ]);
    const s = interpretChatStream(events);
    expect(s.toolCalls[0]).toMatchObject({ name: "skip_turn", arguments: '{"reason":"r"}' });
  });

  it("concatenates content deltas exactly", () => {
    const { events } = parseSseChunks(speechEvents("Preflight check. Can you hear me clearly?"));
    const s = interpretChatStream(events);
    expect(s.content).toBe("Preflight check. Can you hear me clearly?");
    expect(s.finishReasons).toEqual(["stop"]);
    expect(s.errors).toEqual([]);
  });

  it("flags missing [DONE], data after [DONE], non-JSON data and non-chunk objects", () => {
    const { events } = parseSseChunks(["data: nope\n\n", 'data: {"object":"x"}\n\n']);
    const s = interpretChatStream(events);
    expect(s.errors.join("\n")).toMatch(/not JSON/);
    expect(s.errors.join("\n")).toMatch(/not a chat.completion.chunk/);
    expect(s.errors.join("\n")).toMatch(/without data: \[DONE\]/);
    const after = interpretChatStream(parseSseChunks([...speechEvents("hi"), "data: {}\n\n"]).events);
    expect(after.errors).toEqual(["event 5: data after [DONE]"]);
  });
});

describe("readSseResponse", () => {
  it("reads a body delivered in 7-byte chunks and reports the first chunk", async () => {
    let first = 0;
    const { events, errors } = await readSseResponse(sseResponse(speechEvents("Can you hear me?"), 7), () => {
      first += 1;
    });
    expect(errors).toEqual([]);
    expect(first).toBe(1);
    expect(interpretChatStream(events).content).toBe("Can you hear me?");
  });
});
