/**
 * Concept backfill by vision re-read (plan §6.6): after the expert confirms a new concept, the value of
 * that ONE concept for a past case is read from the case's stored redacted frames with Claude Haiku 4.5
 * structured output. Server-only (it imports the Claude wrapper's model routing).
 *
 * The model only reads; code decides. The prompt asks for the single concept, as the expert defined it,
 * and requires "not visible" over a guess; the value it returns is validated against the feature's
 * type and bounds here (constrained decoding does not enforce ranges) and anything else becomes a
 * failure the caller records as `Unknown{backfill_failed}`. Built from the PUBLIC feature model only
 * (`DomainConfigSchema` is strict), and every request still passes the oracle guard in `createClaude`.
 */
import { z } from "zod";
import { DomainConfigSchema, validateFeatureValue, type DomainConfig, type Feature, type Value } from "@vashistha/core";
import { CLAUDE_MODELS, type ClaudeContentBlock, type StructuredRequest } from "@vashistha/core/server";
import { MAX_UPLOAD_LONG_EDGE } from "./image";

/** Frames per re-read: the last ones before the decision show the case fully opened. */
export const BACKFILL_MAX_FRAMES = 3;
export const BACKFILL_MAX_TOKENS = 512;

export const BACKFILL_SYSTEM = `You read screenshots of a back-office case review application and report the value of ONE concept for ONE case.
You only report what is visible. You never judge, decide, recommend, or infer the value from other fields.
If the screenshots do not show the concept for that case, answer "visible": false and value null. Never guess.`;

function describeType(f: Feature): string {
  switch (f.type) {
    case "boolean":
      return "true or false";
    case "enum":
      return `exactly one of: ${f.values.map((v) => `"${v}"`).join(", ")}`;
    case "number":
      return `${f.integer ? "an integer" : "a number"} from ${f.min} to ${f.max}${f.unit === undefined ? "" : ` (${f.unit})`}; digits only`;
    case "string":
      return "text exactly as displayed";
  }
}

/** Output schema for one concept, shaped for constrained decoding like the frame schema (see extraction.ts). */
export function backfillOutputSchema(feature: Feature) {
  const value =
    feature.type === "boolean"
      ? z.boolean().describe("the concept's value: true/false")
      : feature.type === "number"
        ? z.number().describe(`the concept's value: ${describeType(feature)}`)
        : z.string().describe(`the concept's value: ${describeType(feature)}`);
  return z.strictObject({
    visible: z.boolean().describe("true only if the screenshots show this concept for this case"),
    value: z.union([value, z.null().describe("not visible")]),
    evidence: z.string().describe("Where on screen the value is shown, in a few words; empty when not visible"),
  });
}
export type BackfillOutputSchema = ReturnType<typeof backfillOutputSchema>;
export type BackfillOutput = z.infer<BackfillOutputSchema>;

/** One stored redacted frame, PNG-encoded, already within the upload size (stored frames are). */
export type BackfillFrame = { frameId: string; base64Png: string; width: number; height: number };

export type BackfillInput = {
  /** The session's feature model (base + confirmed concepts). */
  domain: DomainConfig;
  feature: string;
  caseId: string;
  frames: readonly BackfillFrame[];
};

function featureOf(domain: DomainConfig, id: string): Feature {
  const feature = domain.features.find((f) => f.id === id);
  if (feature === undefined) throw new RangeError(`unknown feature "${id}" in domain "${domain.id}"`);
  return feature;
}

/** The `createClaude().structured` request that re-reads one concept for one case from its stored frames. */
export function buildBackfillRequest(input: BackfillInput): StructuredRequest<BackfillOutputSchema> {
  const domain = DomainConfigSchema.parse(input.domain);
  const feature = featureOf(domain, input.feature);
  if (input.frames.length === 0) throw new RangeError("a backfill re-read needs at least one frame");
  if (input.frames.length > BACKFILL_MAX_FRAMES) throw new RangeError(`at most ${BACKFILL_MAX_FRAMES} frames per re-read`);
  const content: ClaudeContentBlock[] = [
    {
      type: "text",
      text: [
        `Application: "${domain.title}". Case: ${input.caseId}.`,
        `Concept: \`${feature.id}\` — "${feature.label}"${feature.description === undefined ? "" : `: ${feature.description}`}.`,
        `Value: ${describeType(feature)}.`,
        `The ${input.frames.length} screenshot(s) below were taken while the reviewer had this case open, oldest first.`,
      ].join("\n"),
    },
  ];
  input.frames.forEach((f, i) => {
    if (!Number.isInteger(f.width) || !Number.isInteger(f.height) || f.width < 1 || f.height < 1 || Math.max(f.width, f.height) > MAX_UPLOAD_LONG_EDGE)
      throw new RangeError(`frame ${f.frameId}: size ${f.width}×${f.height} is not uploadable (≤ ${MAX_UPLOAD_LONG_EDGE} px long edge)`);
    content.push({ type: "text", text: `Screenshot ${i + 1}:` }, { type: "image", source: { type: "base64", media_type: "image/png", data: f.base64Png } });
  });
  return {
    model: CLAUDE_MODELS.frameEvents,
    system: BACKFILL_SYSTEM,
    messages: [{ role: "user", content }],
    maxTokens: BACKFILL_MAX_TOKENS,
    schema: backfillOutputSchema(feature),
  };
}

export type BackfillReading = { ok: true; value: Value; evidence: string } | { ok: false; failure: "not_visible" | "invalid_value"; evidence: string };

/** Validates the model's reading against the feature (type, enum values, bounds, integrality). */
export function toBackfillReading(output: BackfillOutput, domain: DomainConfig, feature: string): BackfillReading {
  const evidence = output.evidence.trim().slice(0, 400);
  if (!output.visible || output.value === null) return { ok: false, failure: "not_visible", evidence };
  const checked = validateFeatureValue(domain, feature, output.value);
  return checked.ok ? { ok: true, value: checked.value, evidence } : { ok: false, failure: "invalid_value", evidence };
}
