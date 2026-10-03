import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FeatureIdSchema, ScreenEventSchema, unknown, type DomainConfig, type FeatureId } from "@vashistha/core";
import { CLAUDE_MODELS, createClaude, type ClaudeClient } from "@vashistha/core/server";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { ORACLE_MARKER, KYC_HIDDEN_POLICY } from "@vashistha/core/domains/kyc/oracle";
import {
  buildExtractionRequest,
  buildSystemPrompt,
  frameOutputSchema,
  toScreenEvents,
  type CaseSnapshot,
  type ExtractionContext,
  type FrameOutput,
} from "../src/extraction";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Every schema node, depth first, with its JSON path. */
function* nodes(node: unknown, path = "#"): Generator<[string, Record<string, unknown>]> {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* nodes(item, `${path}/${i}`);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  yield [path, record];
  for (const [key, value] of Object.entries(record)) if (typeof value === "object") yield* nodes(value, `${path}/${key}`);
}

const UNSUPPORTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "pattern"];

/** Asserts the Anthropic structured-output constraints (api-notes §8) on a JSON Schema. */
function expectAnthropicCompatible(schema: unknown): void {
  let objects = 0;
  for (const [path, node] of nodes(schema)) {
    if (path.includes("/properties/") && path.endsWith("/properties")) continue; // a properties map, not a schema
    expect(node.$ref, `${path}: $ref (recursion/indirection) is not allowed here`).toBeUndefined();
    expect(Array.isArray(node.type), `${path}: type arrays are not documented as supported; use anyOf`).toBe(false);
    for (const key of UNSUPPORTED) expect(node[key], `${path}: ${key} is unsupported`).toBeUndefined();
    if (node.minItems !== undefined) expect([0, 1]).toContain(node.minItems);
    if (node.type === "object") {
      objects += 1;
      expect(node.additionalProperties, `${path}: additionalProperties`).toBe(false);
      expect([...((node.required as string[] | undefined) ?? [])].sort(), `${path}: every property required`).toEqual(
        Object.keys((node.properties as object | undefined) ?? {}).sort(),
      );
    }
  }
  expect(objects).toBe(5); // root, screen, value reading, event, concept
}

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const fid = (id: string): FeatureId => FeatureIdSchema.parse(id);

function context(overrides: Partial<ExtractionContext> = {}): ExtractionContext {
  return { domain: KYC_DOMAIN, previous: null, frameSeq: 7, captureTime: 1_790_000_001_000, sessionEpoch: 2, ...overrides };
}

const output = (o: Partial<FrameOutput>): FrameOutput => ({
  screen: { caseId: "NS-2026-0101", values: [] },
  events: [],
  proposedConcepts: [],
  ...o,
});
type RawEvent = FrameOutput["events"][number];
const ev = (e: Partial<RawEvent>): RawEvent => ({
  kind: "field_change",
  caseId: "NS-2026-0101",
  field: null,
  from: null,
  to: null,
  action: null,
  confidence: 0.9,
  ...e,
});

describe("frame output schema", () => {
  it("meets Anthropic structured-output constraints as zod emits it", () => {
    expectAnthropicCompatible(z.toJSONSchema(frameOutputSchema(KYC_DOMAIN), { reused: "ref" }));
  });

  it("meets them as the SDK actually sends it (output_config.format.schema)", async () => {
    const create = vi.fn<ClaudeClient["messages"]["create"]>(() =>
      Promise.resolve({
        id: "msg",
        container: null,
        content: [{ type: "text", text: JSON.stringify(output({})), citations: null }],
        diagnostics: null,
        model: CLAUDE_MODELS.frameEvents,
        role: "assistant",
        stop_details: null,
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message",
        usage: {
          cache_creation: null,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          inference_geo: null,
          input_tokens: 1,
          output_tokens: 1,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: "standard",
        },
      }),
    );
    // The real oracle marker is forbidden: the guard scans system, messages and the schema.
    const claude = createClaude({ client: { messages: { create } }, forbiddenMarkers: [ORACLE_MARKER] });
    const { request } = buildExtractionRequest({ ...context(), frame: { base64Png: PNG_1PX, width: 1, height: 1, sourceWidth: 1, sourceHeight: 1 } });
    const result = await claude.structured(request);
    expect(result.output).toEqual(output({}));
    const params = create.mock.calls[0]?.[0];
    expect(params?.model).toBe("claude-haiku-4-5-20251001");
    expect(params?.system).toEqual([expect.objectContaining({ cache_control: { type: "ephemeral" } })]);
    const sent = params?.output_config?.format;
    expect(sent?.type).toBe("json_schema");
    expectAnthropicCompatible((sent as { schema?: Json } | undefined)?.schema);
  });
});

describe("buildExtractionRequest", () => {
  const frame = { base64Png: PNG_1PX, width: 1568, height: 980, sourceWidth: 2880, sourceHeight: 1800 };

  it("builds a cached Haiku request with the domain catalogue, the previous snapshot and both images", () => {
    const previous: CaseSnapshot = {
      caseId: "NS-2026-0101",
      values: { [fid("riskRating")]: "unrated", [fid("pep")]: unknown("not_visible") } as Record<FeatureId, never>,
    };
    const { request, context: ctx } = buildExtractionRequest({
      ...context({ previous }),
      frame,
      crop: { base64Png: PNG_1PX, width: 300, height: 80, rect: { x: 1200, y: 640, width: 300, height: 80 } },
    });
    expect(request).toMatchObject({ model: CLAUDE_MODELS.frameEvents, cacheSystem: true, maxTokens: 2048 });
    expect(ctx.previous).toBe(previous);
    for (const f of KYC_DOMAIN.features) {
      expect(request.system).toContain(`\`${f.id}\``);
      expect(request.system).toContain(f.label);
      if (f.type === "enum") for (const v of f.values) expect(request.system).toContain(`\`${v}\``);
    }
    for (const a of KYC_DOMAIN.actions) expect(request.system).toContain(`\`${a.id}\``);
    const content = request.messages[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected content blocks");
    expect(content.map((b) => b.type)).toEqual(["text", "text", "image", "text", "image"]);
    const text = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    expect(text).toContain("case open: NS-2026-0101");
    expect(text).toContain('- riskRating: "unrated"');
    expect(text).toContain("- pep: unknown (not_visible)");
    expect(text).toContain("x=1200, y=640, 300×80");
  });

  it("says when there is no previous snapshot and omits the crop when none is given", () => {
    const { request } = buildExtractionRequest({ ...context(), frame });
    const content = request.messages[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected content blocks");
    expect(content.filter((b) => b.type === "image")).toHaveLength(1);
    expect(JSON.stringify(content)).toContain("first frame of the session");
  });

  it("refuses images over the 1568 px long edge", () => {
    expect(() => buildExtractionRequest({ ...context(), frame: { ...frame, width: 1569 } })).toThrow(RangeError);
    expect(() =>
      buildExtractionRequest({ ...context(), frame, crop: { base64Png: PNG_1PX, width: 10, height: 2000, rect: { x: 0, y: 0, width: 10, height: 2000 } } }),
    ).toThrow(RangeError);
  });

  it("contains only public domain data: no oracle marker, and a domain object carrying anything else is refused", () => {
    const { request } = buildExtractionRequest({ ...context(), frame });
    const serialised = JSON.stringify({ ...request, schema: z.toJSONSchema(request.schema) });
    expect(serialised).not.toContain("oracle:");
    expect(serialised).not.toContain(ORACLE_MARKER);
    expect(JSON.stringify(KYC_HIDDEN_POLICY)).toContain(ORACLE_MARKER); // the canary is real, so the check above means something
    const smuggled = { ...KYC_DOMAIN, hiddenPolicy: KYC_HIDDEN_POLICY } as DomainConfig;
    expect(() => buildSystemPrompt(smuggled)).toThrow();
  });
});

describe("toScreenEvents", () => {
  it("returns schema-valid vision events with deterministic ids and critical from criticalFields", () => {
    const domain: DomainConfig = { ...KYC_DOMAIN, criticalFields: [fid("riskRating")] };
    const result = toScreenEvents(
      output({
        events: [
          ev({ kind: "open_case" }),
          ev({ field: "riskRating", from: "unrated", to: "high" }),
          ev({ field: "uboOwnershipPct", to: 35 }),
          ev({ kind: "action", action: "enhancedReview" }),
          ev({ kind: "navigate", caseId: null }),
        ],
      }),
      context({ domain }),
    );
    expect(result.dropped).toEqual([]);
    expect(result.events.map((e) => [e.id, e.kind, e.critical])).toEqual([
      ["vision-2-7-0", "open_case", false],
      ["vision-2-7-1", "field_change", true],
      ["vision-2-7-2", "field_change", false],
      ["vision-2-7-3", "action", false],
      ["vision-2-7-4", "navigate", false],
    ]);
    for (const e of result.events) {
      expect(ScreenEventSchema.parse(e)).toEqual(e);
      expect(e).toMatchObject({ source: "vision", frameSeq: 7, captureTime: 1_790_000_001_000, sessionEpoch: 2 });
    }
    expect(result.events[1]).toMatchObject({ field: "riskRating", from: "unrated", to: "high" });
    expect(result.events[3]).toMatchObject({ action: "enhancedReview" });
    expect(result.events[3]).not.toHaveProperty("field");
    expect(result.events[4]).not.toHaveProperty("caseId");
  });

  it("drops invalid values and counts them, never coercing", () => {
    const result = toScreenEvents(
      output({
        events: [
          ev({ field: "riskRating", to: "extreme" }), // not an enum value
          ev({ field: "uboOwnershipPct", to: "35" }), // a string for a number
          ev({ field: "accountAgeMonths", to: 1.5 }), // not an integer
          ev({ field: "accountAgeMonths", to: 9999 }), // out of range
          ev({ field: "pep", to: "yes" }), // not a boolean
          ev({ field: "riskRating", from: "severe", to: "high" }), // invalid from
          ev({ field: "riskRating", to: null }),
          ev({ field: "country", to: "Estoria" }), // not a catalogue field
          ev({ field: null, to: "high" }),
          ev({ kind: "action", action: "launchRocket" }),
          ev({ kind: "approve" }), // not a kind
          ev({ kind: "open_case", caseId: "  " }),
          ev({ kind: "open_case", confidence: 1.2 }),
          ev({ kind: "open_case", confidence: Number.NaN }),
        ],
      }),
      context(),
    );
    expect(result.events).toEqual([]);
    expect(result.dropped.map((d) => d.reason)).toEqual([
      "invalid_value",
      "invalid_value",
      "invalid_value",
      "invalid_value",
      "invalid_value",
      "invalid_value",
      "invalid_value",
      "invalid_field",
      "invalid_field",
      "invalid_action",
      "invalid_kind",
      "missing_case",
      "invalid_confidence",
      "invalid_confidence",
    ]);
    expect(result.dropped.every((d) => d.where === "event")).toBe(true);
  });

  it("drops a field change that does not change the last applied snapshot, and duplicates", () => {
    const previous: CaseSnapshot = { caseId: "NS-2026-0101", values: { [fid("riskRating")]: "high" } as Record<FeatureId, "high"> };
    const result = toScreenEvents(
      output({
        events: [
          ev({ field: "riskRating", from: "unrated", to: "high" }),
          ev({ kind: "action", action: "approve" }),
          ev({ kind: "action", action: "approve", confidence: 0.5 }),
        ],
      }),
      context({ previous }),
    );
    expect(result.events.map((e) => e.kind)).toEqual(["action"]);
    expect(result.dropped.map((d) => [d.index, d.reason])).toEqual([
      [0, "no_change"],
      [2, "duplicate"],
    ]);
  });

  it("builds the next snapshot: carry-over for the same case, unknown for a new one, readings validated", () => {
    const previous: CaseSnapshot = {
      caseId: "NS-2026-0101",
      values: { [fid("riskRating")]: "unrated", [fid("pep")]: false } as Record<FeatureId, string | boolean>,
    };
    const same = toScreenEvents(
      output({
        screen: {
          caseId: "NS-2026-0101",
          values: [
            { field: "uboOwnershipPct", value: 35 },
            { field: "entityType", value: "llc" },
            { field: "country", value: "Estoria" },
          ],
        },
        events: [ev({ field: "riskRating", from: "unrated", to: "high" })],
      }),
      context({ previous }),
    );
    expect(same.snapshot.values).toMatchObject({ riskRating: "high", pep: false, uboOwnershipPct: 35, entityType: unknown("not_visible") });
    expect(same.dropped).toEqual([
      { where: "value", index: 1, reason: "invalid_value" },
      { where: "value", index: 2, reason: "invalid_field" },
    ]);

    const other = toScreenEvents(output({ screen: { caseId: "NS-2026-0102", values: [{ field: "pep", value: true }] } }), context({ previous }));
    expect(other.snapshot.caseId).toBe("NS-2026-0102");
    expect(other.snapshot.values).toMatchObject({ pep: true, riskRating: unknown("not_visible") });
    expect(Object.keys(other.snapshot.values)).toHaveLength(KYC_DOMAIN.features.length);
  });

  it("keeps new concepts for the undefined-concepts list and drops known or malformed ones", () => {
    const result = toScreenEvents(
      output({
        proposedConcepts: [
          { name: "passportStatus", description: "Passport document marked Missing", observedValue: "Missing" },
          { name: "riskRating", description: "already a feature", observedValue: null },
          { name: "Adverse media", description: "a label, not an identifier", observedValue: null },
          { name: "adverse media", description: "matches a feature label", observedValue: null },
        ],
      }),
      context(),
    );
    expect(result.concepts).toEqual([
      { name: "passportStatus", description: "Passport document marked Missing", observedValue: "Missing", frameSeq: 7, captureTime: 1_790_000_001_000 },
    ]);
    expect(result.dropped.map((d) => d.reason)).toEqual(["known_concept", "invalid_name", "invalid_name"]);
  });
});
