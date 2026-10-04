import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ScreenEventSchema, unknown, type ActionId, type DomainConfig, type FeatureId, type FeatureValue } from "@vashistha/core";
import { CLAUDE_MODELS, createClaude, type ClaudeClient } from "@vashistha/core/server";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { ORACLE_MARKER, KYC_HIDDEN_POLICY } from "@vashistha/core/domains/kyc/oracle";
import { thumbnail } from "../src/change-detector";
import {
  LOCAL_READ,
  MAX_CONCEPTS_PER_CASE_OPEN,
  buildSystemPrompt,
  executeRead,
  fullReadSchema,
  interpretReading,
  localReadSchema,
  planRead,
  refreshReadSchema,
  warmUpExtraction,
  prepareRead,
  screenProfile,
  type CaseSnapshot,
  type FrameReading,
  type FullRead,
  type ReadContext,
} from "../src/extraction";
import { createRgba, type RgbaImage } from "../src/image";
import { decodePng } from "../src/png";

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

/** Asserts the Anthropic structured-output constraints (api-notes §8) on a JSON Schema; returns the number of objects. */
function expectAnthropicCompatible(schema: unknown): number {
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
  return objects;
}

const PROFILE = screenProfile(KYC_DOMAIN, ["riskRating"]);
const CASE = "NS-2026-0101";
const TITLE = "Halvorsen Marine Logistics Ltd";
const W = 1440;
const H = 900;

function screen(): RgbaImage {
  const img = createRgba(W, H);
  img.data.fill(240);
  return img;
}
function paint(img: RgbaImage, x: number, y: number, w: number, h: number, shade: number): RgbaImage {
  for (let yy = y; yy < y + h; yy += 1) for (let xx = x; xx < x + w; xx += 1) img.data.set([shade, shade, shade, 255], (yy * img.width + xx) * 4);
  return img;
}

const BLANK = thumbnail(screen());
const T = 1_790_000_001_000;

function snapshot(over: Partial<CaseSnapshot> = {}): CaseSnapshot {
  return {
    caseId: CASE,
    fields: { riskRating: "unrated" } as Record<FeatureId, FeatureValue>,
    committed: null,
    thumbnail: BLANK,
    fullReadAt: T - 500,
    conceptsRead: true,
    caseVotes: { [CASE]: 1 },
    caseTitle: TITLE,
    ...over,
  };
}

function context(over: Partial<ReadContext> = {}): ReadContext {
  return { domain: KYC_DOMAIN, profile: PROFILE, previous: null, frameSeq: 7, captureTime: T, sessionEpoch: 2, mode: "full", thumbnail: BLANK, switchPossible: true, ...over };
}

const full = (o: Partial<FullRead> = {}): FrameReading => ({
  mode: "full",
  output: { caseId: CASE, caseTitle: TITLE, fields: { riskRating: "unrated" }, committed: null, concepts: [], ...o },
});
const local = (riskRating: string | null, committed: string | null = null): FrameReading => ({ mode: "local", output: { fields: { riskRating }, committed } });
const local_ = (): Partial<ReadContext> => ({ mode: "local" });

describe("screen profile (declared by the app, validated against the domain)", () => {
  it("accepts on-screen features and refuses unknown, derived-free, empty or repeated lists", () => {
    expect(PROFILE.editableFields).toEqual(["riskRating"]);
    expect(() => screenProfile(KYC_DOMAIN, [])).toThrow();
    expect(() => screenProfile(KYC_DOMAIN, ["country"])).toThrow();
    expect(() => screenProfile(KYC_DOMAIN, ["riskRating", "riskRating"])).toThrow();
  });
});

describe("compact output schemas", () => {
  it("meet Anthropic structured-output constraints as zod emits them, with fixed keys for the editable fields only", () => {
    const fullJson = z.toJSONSchema(fullReadSchema(KYC_DOMAIN, PROFILE), { reused: "ref" }) as { properties: Record<string, { properties?: object }> };
    expect(expectAnthropicCompatible(fullJson)).toBe(3); // root, fields, concept
    expect(Object.keys(fullJson.properties)).toEqual(["caseId", "caseTitle", "fields", "committed", "concepts"]);
    const refreshJson = z.toJSONSchema(refreshReadSchema(KYC_DOMAIN, PROFILE), { reused: "ref" }) as { properties: object };
    expect(expectAnthropicCompatible(refreshJson)).toBe(2);
    expect(Object.keys(refreshJson.properties)).toEqual(["caseId", "caseTitle", "fields", "committed"]);
    expect(Object.keys(fullJson.properties.fields?.properties ?? {})).toEqual(["riskRating"]);
    const localJson = z.toJSONSchema(localReadSchema(KYC_DOMAIN, PROFILE), { reused: "ref" }) as { properties: object };
    expect(expectAnthropicCompatible(localJson)).toBe(2);
    expect(Object.keys(localJson.properties)).toEqual(["fields", "committed"]);
  });

  it("are strict: extra keys or a list instead of the field object fail validation", () => {
    const schema = fullReadSchema(KYC_DOMAIN, PROFILE);
    const ok = { caseId: CASE, caseTitle: TITLE, fields: { riskRating: "low" }, committed: null, concepts: [] };
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse({ ...ok, events: [] }).success).toBe(false);
    expect(schema.safeParse({ ...ok, fields: { riskRating: "low", pep: true } }).success).toBe(false);
    expect(schema.safeParse({ ...ok, fields: [{ field: "riskRating", value: "low" }] }).success).toBe(false);
    expect(localReadSchema(KYC_DOMAIN, PROFILE).safeParse({ fields: { riskRating: null }, committed: null, caseId: CASE }).success).toBe(false);
  });

  it("is sent as the SDK converts it, through the wrapper's oracle guard", async () => {
    const create = vi.fn<ClaudeClient["messages"]["create"]>(() =>
      Promise.resolve({
        id: "msg",
        container: null,
        content: [{ type: "text", text: JSON.stringify(full().output), citations: null }],
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
    const claude = createClaude({ client: { messages: { create } }, forbiddenMarkers: [ORACLE_MARKER] });
    const read = prepareRead({ ...context(), previous: snapshot({ conceptsRead: false }), frame: { image: screen(), sourceWidth: W, sourceHeight: H } });
    expect(read.mode).toBe("full");
    const { reading } = await executeRead(read, claude);
    expect(reading).toEqual(full());
    const params = create.mock.calls[0]?.[0];
    expect(params?.model).toBe("claude-haiku-4-5-20251001");
    expect(params?.max_tokens).toBe(512);
    expect(params?.system).toEqual([expect.objectContaining({ cache_control: { type: "ephemeral" } })]);
    expect(expectAnthropicCompatible((params?.output_config?.format as { schema?: Json } | undefined)?.schema)).toBe(3);
  });
});

describe("warm-up", () => {
  it("compiles all three output grammars with one text-only request each", async () => {
    const structured = vi.fn(() => Promise.resolve({ output: {}, usage: {}, latencyMs: 1, stopReason: "end_turn" }));
    await warmUpExtraction({ structured } as unknown as Parameters<typeof warmUpExtraction>[0], KYC_DOMAIN, PROFILE);
    const schemas = structured.mock.calls.map((call: unknown[]) => Object.keys(z.toJSONSchema((call[0] as { schema: z.ZodType }).schema).properties ?? {}));
    expect(schemas).toEqual([["caseId", "caseTitle", "fields", "committed", "concepts"], ["caseId", "caseTitle", "fields", "committed"], ["fields", "committed"]]);
    expect(JSON.stringify(structured.mock.calls)).not.toContain('"image"');
  });
});

describe("planRead (code decides how much the model sees)", () => {
  const changed = (x: number, y: number, w: number, h: number) => thumbnail(paint(screen(), x, y, w, h, 40));

  it("reads the whole screen without a case to compare with, for a large change, when stale, or when nothing changed", () => {
    const small = changed(1150, 450, 200, 40);
    const maySwitch = { scope: "screen", switchPossible: true };
    const sameCase = { scope: "screen", switchPossible: false };
    expect(planRead(null, small, T)).toEqual(maySwitch);
    expect(planRead(snapshot({ caseId: null }), small, T)).toEqual(maySwitch);
    expect(planRead(snapshot(), changed(300, 60, 820, 600), T)).toEqual(maySwitch);
    expect(planRead(snapshot({ fullReadAt: T - LOCAL_READ.maxAgeMs - 1 }), small, T)).toEqual(sameCase);
    expect(planRead(snapshot(), BLANK, T)).toEqual(sameCase); // nothing measurable changed: re-read rather than guess
  });

  it("reads a small change locally, with the margin, and counts sub-detector changes (2 grey levels) as changed", () => {
    const plan = planRead(snapshot(), changed(1150, 450, 200, 40), T);
    expect(plan.scope).toBe("local");
    if (plan.scope !== "local") return;
    expect(plan.rect.x).toBeLessThanOrEqual(1150 - LOCAL_READ.margin);
    expect(plan.rect.y).toBeLessThanOrEqual(450 - LOCAL_READ.margin);
    expect(plan.rect.x + plan.rect.width).toBeGreaterThanOrEqual(1350 + LOCAL_READ.margin);
    // A word swapped for one of similar ink: ~3 grey levels per cell, under the detector's 6, still inside the crop.
    const faint = thumbnail(paint(screen(), 1150, 450, 200, 25, 210));
    expect(planRead(snapshot(), faint, T).scope).toBe("local");
  });

  it("prepares a local request with only the crop, and whole-screen ones with the frame — never previous values", () => {
    const image = paint(screen(), 1150, 450, 200, 40, 40);
    const read = prepareRead({ ...context(), previous: snapshot(), frame: { image, sourceWidth: W, sourceHeight: H } });
    expect(read.mode).toBe("local");
    const content = read.request.messages[0]?.content;
    if (!Array.isArray(content) || read.mode !== "local") throw new Error("expected a local read");
    expect(content.map((b) => b.type)).toEqual(["text", "text", "image"]);
    const text = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    expect(text).toContain("a case file was open");
    expect(text).not.toContain(CASE); // shown a previous id, the model copies it
    expect(text).not.toContain("unrated");
    expect(text).toContain("LOCAL read");
    const img = content[2];
    if (img?.type !== "image") throw new Error("expected an image");
    const crop = decodePng(Buffer.from(img.source.data, "base64"));
    expect([crop.width, crop.height]).toEqual([read.rect.width, read.rect.height]);

    const first = prepareRead({ ...context(), frame: { image, sourceWidth: W, sourceHeight: H } });
    const firstContent = first.request.messages[0]?.content;
    if (!Array.isArray(firstContent)) throw new Error("expected content blocks");
    expect(first.mode).toBe("refresh"); // the read that may open a case never asks for concepts
    expect(JSON.stringify(firstContent)).toContain("first frame of the session");
    const second = prepareRead({ ...context(), previous: snapshot({ conceptsRead: false }), frame: { image: screen(), sourceWidth: W, sourceHeight: H } });
    expect(second.mode).toBe("full"); // the next whole-screen read of the opened case that cannot be a switch does, once
    const big = paint(screen(), 300, 60, 820, 600, 40);
    expect(prepareRead({ ...context(), previous: snapshot({ conceptsRead: false }), frame: { image: big, sourceWidth: W, sourceHeight: H } }).mode).toBe("refresh");
    expect(prepareRead({ ...context(), previous: snapshot(), frame: { image: screen(), sourceWidth: W, sourceHeight: H } }).mode).toBe("refresh");
    expect(firstContent.filter((b) => b.type === "image")).toHaveLength(1);
  });

  it("sends whole-screen reads without blank margins, saying which region the image shows", () => {
    // A dark header, content touching both side edges, and a blank band under row 600.
    const image = paint(paint(paint(screen(), 0, 0, W, 60, 30), 0, 300, 50, 300, 120), W - 50, 100, 50, 20, 120);
    const read = prepareRead({ ...context(), frame: { image, sourceWidth: W, sourceHeight: H } });
    const content = read.request.messages[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected content blocks");
    const img = content.find((b) => b.type === "image");
    if (img?.type !== "image") throw new Error("expected an image");
    const sent = decodePng(Buffer.from(img.source.data, "base64"));
    expect([sent.width, sent.height]).toEqual([W, 540]); // a uniform header band is a margin too
    expect(JSON.stringify(content)).toContain("without its blank margins: x=0, y=60, 1440×540");
    expect(sent.width * sent.height).toBeLessThan(0.9 * W * H);
  });

  it("adds the client's hi-res crop to a full read only when the upload was downscaled, and refuses oversized images", () => {
    const crop = { base64Png: "AAAA", width: 300, height: 80, rect: { x: 2300, y: 1280, width: 300, height: 80 } };
    const native = prepareRead({ ...context(), frame: { image: screen(), base64Png: "BBBB", sourceWidth: W, sourceHeight: H }, crop });
    const scaled = prepareRead({ ...context(), frame: { image: screen(), base64Png: "BBBB", sourceWidth: 2880, sourceHeight: 1800 }, crop });
    const images = (r: typeof native) => {
      const c = r.request.messages[0]?.content;
      return Array.isArray(c) ? c.filter((b) => b.type === "image").length : 0;
    };
    expect(images(native)).toBe(1);
    expect(images(scaled)).toBe(2);
    expect(() => prepareRead({ ...context(), frame: { image: createRgba(1569, 10), sourceWidth: 1569, sourceHeight: 10 } })).toThrow(RangeError);
    expect(() => prepareRead({ ...context(), frame: { image: screen(), sourceWidth: W, sourceHeight: H }, crop: { ...crop, height: 2000 } })).toThrow(RangeError);
  });

  it("contains only public domain data: no oracle marker, and a domain object carrying anything else is refused", () => {
    const read = prepareRead({ ...context(), frame: { image: screen(), base64Png: "BBBB", sourceWidth: W, sourceHeight: H } });
    const serialised = JSON.stringify({ ...read.request, schema: z.toJSONSchema(read.request.schema) });
    expect(serialised).not.toContain("oracle:");
    expect(serialised).not.toContain(ORACLE_MARKER);
    expect(JSON.stringify(KYC_HIDDEN_POLICY)).toContain(ORACLE_MARKER); // the canary is real, so the check above means something
    const smuggled = { ...KYC_DOMAIN, hiddenPolicy: KYC_HIDDEN_POLICY } as DomainConfig;
    expect(() => buildSystemPrompt(smuggled, PROFILE)).toThrow();
    const prompt = buildSystemPrompt(KYC_DOMAIN, PROFILE);
    for (const a of KYC_DOMAIN.actions.filter((x) => x.terminal)) expect(prompt).toContain(`\`${a.id}\``);
    for (const v of ["unrated", "low", "medium", "high"]) expect(prompt).toContain(`\`${v}\``);
  });
});

describe("interpretReading (code derives events from two readings)", () => {
  it("emits schema-valid vision events with deterministic ids, critical from criticalFields", () => {
    const result = interpretReading(full({ fields: { riskRating: "high" } }), context({ previous: snapshot() }));
    expect(result.dropped).toEqual([]);
    expect(result.events).toEqual([
      {
        id: "vision-2-7-0",
        frameSeq: 7,
        captureTime: T,
        sessionEpoch: 2,
        kind: "field_change",
        caseId: CASE,
        field: "riskRating",
        from: "unrated",
        to: "high",
        confidence: 0.9,
        source: "vision",
        critical: true,
      },
    ]);
    for (const e of result.events) expect(ScreenEventSchema.parse(e)).toEqual(e);
    const notCritical = interpretReading(full({ fields: { riskRating: "high" } }), context({ previous: snapshot(), domain: { ...KYC_DOMAIN, criticalFields: [] } }));
    expect(notCritical.events[0]?.critical).toBe(false);
  });

  it("treats a case switch as open_case only: never field changes, a fresh baseline", () => {
    const result = interpretReading(
      full({ caseId: "NS-2026-0102", caseTitle: "Quillfeather Agritrade Holdings", fields: { riskRating: "high" }, committed: "approve" }),
      context({ previous: snapshot({ fields: { riskRating: "low" } as Record<FeatureId, FeatureValue> }) }),
    );
    expect(result.events.map((e) => [e.kind, e.caseId])).toEqual([["open_case", "NS-2026-0102"]]);
    expect(result.snapshot).toMatchObject({ caseId: "NS-2026-0102", fields: { riskRating: "high" }, committed: "approve", fullReadAt: T });
  });

  it("lets the case change only when the screen changed enough; otherwise a different id is a misreading that votes", () => {
    const misread = "NS-2626-0101";
    const small = context({ mode: "full", switchPossible: false, previous: snapshot() });
    const first = interpretReading(full({ caseId: misread, fields: { riskRating: "low" } }), small);
    expect(first.events.map((e) => [e.kind, e.caseId])).toEqual([["field_change", CASE]]); // same case: the edit counts
    expect(first.snapshot).toMatchObject({ caseId: CASE, caseVotes: { [CASE]: 1, [misread]: 1 } }); // tie: keep the id in use
    const unreadable = interpretReading(full({ caseId: null }), context({ mode: "full", switchPossible: false, previous: snapshot() }));
    expect(unreadable.events).toEqual([]);
    expect(unreadable.snapshot.caseId).toBe(CASE);
    // Even on a large change, the same title is the same case: a different id is a misreading.
    const scrolled = interpretReading(full({ caseId: misread, committed: "approve" }), context({ previous: snapshot() }));
    expect(scrolled.events.map((e) => [e.kind, e.caseId, e.action])).toEqual([["action", CASE, "approve"]]);
    // A case opened under a misread id takes the id read most often during the visit.
    const opened = interpretReading(full({ caseId: misread }), context({ previous: snapshot({ caseId: "NS-2026-0100", caseTitle: "Another Customer" }) }));
    expect(opened.events.map((e) => [e.kind, e.caseId])).toEqual([["open_case", misread]]);
    const once = interpretReading(full({ caseId: CASE }), context({ mode: "full", switchPossible: false, previous: opened.snapshot }));
    const twice = interpretReading(full({ caseId: CASE, fields: { riskRating: "high" } }), context({ mode: "full", switchPossible: false, previous: once.snapshot }));
    expect(twice.snapshot.caseId).toBe(CASE);
    expect(twice.events.map((e) => [e.kind, e.caseId, e.to])).toEqual([["field_change", CASE, "high"]]);
  });

  it("emits navigate when no case is open, once", () => {
    const first = interpretReading(full({ caseId: null, caseTitle: null, fields: { riskRating: null } }), context());
    expect(first.events.map((e) => e.kind)).toEqual(["navigate"]);
    expect(first.events[0]).not.toHaveProperty("caseId");
    const again = interpretReading(full({ caseId: null, caseTitle: null, fields: { riskRating: null } }), context({ previous: first.snapshot }));
    expect(again.events).toEqual([]);
    const fromCase = interpretReading(full({ caseId: null, caseTitle: null, fields: { riskRating: null } }), context({ previous: snapshot() }));
    expect(fromCase.events.map((e) => e.kind)).toEqual(["navigate"]);
  });

  it("reports a field change only between two legible readings of the same case", () => {
    const unread = snapshot({ fields: { riskRating: unknown("not_visible") } as Record<FeatureId, FeatureValue> });
    const baseline = interpretReading(full({ fields: { riskRating: "low" } }), context({ previous: unread }));
    expect(baseline.events).toEqual([]);
    expect(baseline.snapshot.fields).toEqual({ riskRating: "low" });
    const unreadable = interpretReading(full({ fields: { riskRating: null } }), context({ previous: snapshot() }));
    expect(unreadable.events).toEqual([]);
    expect(unreadable.snapshot.fields).toEqual({ riskRating: "unrated" }); // carried over, not forgotten
    const same = interpretReading(full({ fields: { riskRating: "unrated" } }), context({ previous: snapshot() }));
    expect(same.events).toEqual([]);
  });

  it("refresh reads re-read case and committed state like full reads, but never take concepts", () => {
    const refresh: FrameReading = { mode: "refresh", output: { caseId: CASE, caseTitle: TITLE, fields: { riskRating: "low" }, committed: "approve" } };
    const result = interpretReading(refresh, context({ mode: "refresh", previous: snapshot() }));
    expect(result.events.map((e) => [e.kind, e.to ?? e.action])).toEqual([
      ["field_change", "low"],
      ["action", "approve"],
    ]);
    expect(result.snapshot.fullReadAt).toBe(T);
    expect(result.concepts).toEqual([]);
  });

  it("local reads keep the case (code knows it is unchanged): editable fields, and a commit only the crop shows", () => {
    const result = interpretReading(local("medium"), context({ ...local_(), previous: snapshot({ committed: "approve" as ActionId }) }));
    expect(result.events.map((e) => [e.kind, e.caseId, e.from, e.to])).toEqual([["field_change", CASE, "unrated", "medium"]]);
    expect(result.snapshot).toMatchObject({ caseId: CASE, committed: "approve", fullReadAt: T - 500 });
    const commit = interpretReading(local(null, "reject"), context({ ...local_(), previous: snapshot() }));
    expect(commit.events.map((e) => [e.kind, e.caseId, e.action])).toEqual([["action", CASE, "reject"]]);
  });

  it("drops invalid values and counts them, never coercing (other fields are not even in the schema)", () => {
    for (const bad of ["Medium", "extreme", " high"]) {
      const result = interpretReading(full({ fields: { riskRating: bad } }), context({ previous: snapshot() }));
      expect(result.events).toEqual([]);
      expect(result.dropped).toEqual([{ where: "field", key: "riskRating", reason: "invalid_value" }]);
      expect(result.snapshot.fields).toEqual({ riskRating: "unrated" });
    }
    const blankCase = interpretReading(full({ caseId: "  " }), context({ previous: snapshot() }));
    expect(blankCase.dropped).toContainEqual({ where: "reading", key: "caseId", reason: "invalid_case" });
  });

  it("emits an action only when the same case goes from a known 'none' to a final action, never twice", () => {
    const committed = interpretReading(full({ committed: "enhancedReview" }), context({ previous: snapshot() }));
    expect(committed.events.map((e) => [e.kind, e.action, e.critical])).toEqual([["action", "enhancedReview", false]]);
    const again = interpretReading(full({ committed: "enhancedReview" }), context({ previous: committed.snapshot }));
    expect(again.events).toEqual([]);
    const hidden = interpretReading(full({ committed: null }), context({ previous: committed.snapshot }));
    expect(hidden.snapshot.committed).toBe("enhancedReview"); // "none shown" never un-commits
    const fromUnknown = interpretReading(full({ committed: "approve" }), context({ previous: snapshot({ committed: unknown("not_extracted") }) }));
    expect(fromUnknown.events).toEqual([]);
    const nonFinal = interpretReading(full({ committed: "rateHigh" }), context({ previous: snapshot() }));
    expect(nonFinal.events).toEqual([]);
    expect(nonFinal.dropped).toEqual([{ where: "committed", key: "rateHigh", reason: "invalid_action" }]);
  });

  it("accepts concepts once per opened case (its second whole-screen read), capped, deduped, never a catalogue feature", () => {
    const concepts = [
      { name: "passportStatus", description: "Passport document marked Missing", observedValue: "Missing" },
      { name: "riskRating", description: "already a feature", observedValue: null },
      { name: "Adverse media", description: "a label, not an identifier", observedValue: null },
      { name: "passportstatus", description: "same name again", observedValue: null },
      { name: "documentExpiry", description: "Expired document", observedValue: "2025-01-01" },
      { name: "sourceOfFundsStatus", description: "extends a feature id", observedValue: "Unverified" },
      { name: "countryRisk", description: "abbreviates a feature label", observedValue: "Medium" },
      { name: "pepRelative", description: "a new concept that only starts like a feature", observedValue: "yes" },
    ];
    const pending = snapshot({ conceptsRead: false });
    const read = interpretReading(full({ concepts }), context({ previous: pending }));
    expect(read.concepts.map((c) => c.name)).toEqual(["passportStatus", "documentExpiry"]);
    expect(read.concepts).toHaveLength(MAX_CONCEPTS_PER_CASE_OPEN);
    expect(read.concepts[0]).toEqual({ name: "passportStatus", description: "Passport document marked Missing", observedValue: "Missing", frameSeq: 7, captureTime: T });
    expect(read.dropped.map((d) => d.reason)).toEqual(["known_concept", "invalid_name", "duplicate", "known_concept", "known_concept", "concept_cap"]);
    expect(read.snapshot.conceptsRead).toBe(true);
    // Already read for this case, or a frame that shows another case: never.
    const again = interpretReading(full({ concepts }), context({ previous: snapshot() }));
    expect(again.concepts).toEqual([]);
    expect(again.dropped.every((d) => d.reason === "unexpected_concept")).toBe(true);
    const switched = interpretReading(full({ caseId: "NS-2026-0102", caseTitle: "Quillfeather Agritrade Holdings", concepts }), context({ previous: pending }));
    expect(switched.concepts).toEqual([]);
    expect(switched.snapshot.conceptsRead).toBe(false);
  });

  it("drops concepts grounded in the screen's chrome or that only combine feature labels, deterministically", () => {
    const chromeProfile = screenProfile(KYC_DOMAIN, ["riskRating"], ["Case queue", "Screening", "Source of funds", "Documents", "Customer", "Beneficial owners", "Save decision"]);
    const read = (concepts: FullRead["concepts"]) =>
      interpretReading(full({ concepts }), context({ profile: chromeProfile, previous: snapshot({ conceptsRead: false }) }));
    const reasons = (concepts: FullRead["concepts"]) => read(concepts).dropped.map((d) => [d.key, d.reason]);
    expect(
      reasons([
        // A name made of section headings; a description naming UI parts; a value that only says "shown".
        { name: "screeningDocuments", description: "Documents status shown", observedValue: "Missing" },
        { name: "caseLayout", description: "Tabs for the case file", observedValue: null },
      ]),
    ).toEqual([
      ["screeningDocuments", "screen_chrome"],
      ["caseLayout", "screen_chrome"],
    ]);
    expect(reasons([{ name: "registryExtract", description: "Registry extract present", observedValue: "displayed" }])).toEqual([["registryExtract", "screen_chrome"]]);
    expect(reasons([{ name: "ownerList", description: "Customer and beneficial owners", observedValue: null }])).toEqual([["ownerList", "screen_chrome"]]);
    // Two catalogue features under one name: not a new concept.
    expect(reasons([{ name: "pepAndAdverseMedia", description: "Owner is a PEP with adverse media", observedValue: "yes" }])).toEqual([["pepAndAdverseMedia", "known_concept"]]);
    // Case content that merely uses a chrome word is kept.
    const kept = read([
      { name: "documentExpiry", description: "Registry extract expired 14 months ago", observedValue: "2025-01-01" },
      { name: "complianceSignOff", description: "Compliance officer sign-off recorded", observedValue: "pending" },
    ]);
    expect(kept.concepts.map((c) => c.name)).toEqual(["documentExpiry", "complianceSignOff"]);
    expect(kept.dropped).toEqual([]);
    expect(() => screenProfile(KYC_DOMAIN, ["riskRating"], ["  "])).toThrow(/chrome label/);
  });

  it("refuses a reading of the wrong mode (an extractor bug) instead of guessing", () => {
    expect(() => interpretReading(local("low"), context({ previous: snapshot() }))).toThrow(/local read for a full request/);
  });
});
