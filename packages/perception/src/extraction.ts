/**
 * Frame → ScreenEvent extraction with Claude Haiku 4.5 structured output (plan §5, §7.1; api-notes
 * §8–10). Server-only (it imports the Claude wrapper's model routing). The model only READS the
 * screen; code validates everything it returns:
 *
 * - field ids and action ids are constrained by the output schema AND re-checked here;
 * - values are validated against the domain's feature types; invalid ones are dropped and counted,
 *   never coerced; numeric limits (confidence 0–1, feature ranges) are enforced here because
 *   constrained decoding does not support minimum/maximum;
 * - `critical` comes from `domain.criticalFields`, ids are deterministic, and a field_change that
 *   does not change the last applied snapshot is dropped.
 *
 * The prompt is built from the PUBLIC domain config only (`DomainConfigSchema` is strict, so an
 * object carrying anything else is refused), and every request still passes the oracle guard in
 * `createClaude`.
 */
import { z } from "zod";
import {
  DomainConfigSchema,
  ScreenEventSchema,
  SymbolIdSchema,
  isUnknown,
  unknown,
  validateFeatureValue,
  type DomainConfig,
  type Feature,
  type FeatureId,
  type FeatureValue,
  type ScreenEvent,
  type Value,
} from "@vashistha/core";
import { CLAUDE_MODELS, type ClaudeContentBlock, type StructuredRequest } from "@vashistha/core/server";
import { MAX_UPLOAD_LONG_EDGE, type Rect } from "./image";

/** The last applied reading of the case on screen; what the next frame is compared against. */
export type CaseSnapshot = { caseId: string | null; values: Record<FeatureId, FeatureValue> };

export type EncodedImage = { base64Png: string; width: number; height: number };

export const SCREEN_EVENT_KINDS = ["open_case", "field_change", "action", "navigate"] as const;

/** Upper bound on the structured output; a frame yields a dozen readings and a few events. */
export const EXTRACTION_MAX_TOKENS = 2048;

function nonEmpty<T>(items: readonly T[], what: string): [T, ...T[]] {
  const [first, ...rest] = items;
  if (first === undefined) throw new Error(`domain has no ${what}`);
  return [first, ...rest];
}

/** Features a reviewer can see on screen (derived features are computed by code, never read). */
function screenFeatures(domain: DomainConfig): Feature[] {
  return domain.features.filter((f) => f.source === "case");
}

/**
 * Structured-output schema for one frame, shaped for Anthropic constrained decoding (api-notes §8)
 * as the SDK's `zodOutputFormat` actually converts it (@anthropic-ai/sdk 0.131, checked):
 *
 * - every object is strict (`additionalProperties: false`), every property required, no recursion;
 * - nullable members and the value union carry a description on each member, which makes zod emit
 *   `anyOf` (documented as supported) instead of a `type: [...]` array (not documented);
 * - kind, field and action ids are plain strings listing the allowed values in their description:
 *   the SDK moves `enum` into the description anyway, and an enum here would make the post-decode
 *   zod check reject the WHOLE frame for one bad id — `toScreenEvents` drops just that event;
 * - no numeric or length limits: confidence and feature ranges are enforced in code.
 */
export function frameOutputSchema(domain: DomainConfig) {
  const fieldIds = nonEmpty(screenFeatures(domain).map((f) => f.id as string), "on-screen features").join(", ");
  const actionIds = nonEmpty(domain.actions.map((a) => a.id as string), "actions").join(", ");
  const value = (what: string) =>
    z.union([
      z.string().describe(`${what}: enum value or text`),
      z.number().describe(`${what}: number`),
      z.boolean().describe(`${what}: true/false`),
    ]);
  const nullableValue = (what: string) => z.union([...value(what).options, z.null().describe(`no ${what.toLowerCase()}`)]);
  return z.strictObject({
    screen: z.strictObject({
      caseId: z.string().describe("Id of the case currently open, exactly as displayed; null when no case is open").nullable(),
      values: z.array(z.strictObject({ field: z.string().describe(`One of: ${fieldIds}`), value: value("Value") })),
    }),
    events: z.array(
      z.strictObject({
        kind: z.string().describe(`One of: ${SCREEN_EVENT_KINDS.join(", ")}`),
        caseId: z.string().describe("Case id as displayed").nullable(),
        field: z.string().describe(`field_change only. One of: ${fieldIds}`).nullable(),
        from: nullableValue("Previous value"),
        to: nullableValue("New value"),
        action: z.string().describe(`action only. One of: ${actionIds}`).nullable(),
        confidence: z.number().describe("Probability that this event really happened, from 0 to 1."),
      }),
    ),
    proposedConcepts: z.array(
      z.strictObject({
        name: z.string().describe("camelCase identifier for the concept."),
        description: z.string(),
        observedValue: z.string().describe("What the screen shows for it").nullable(),
      }),
    ),
  });
}
export type FrameOutputSchema = ReturnType<typeof frameOutputSchema>;
export type FrameOutput = z.infer<FrameOutputSchema>;

function describeFeature(f: Feature): string {
  const head = `- \`${f.id}\` — "${f.label}"`;
  const note = f.description === undefined ? "" : ` ${f.description}`;
  switch (f.type) {
    case "enum":
      return `${head}: one of ${f.values.map((v) => `\`${v}\``).join(", ")}.${note}`;
    case "boolean":
      return `${head}: true or false (yes/no, match/clear, found/none, verified/unverified on screen).${note}`;
    case "number":
      return `${head}: ${f.integer ? "integer" : "number"} from ${f.min} to ${f.max}${f.unit === undefined ? "" : ` (${f.unit})`}; write digits only, no unit, currency sign or thousands separator.${note}`;
    case "string":
      return `${head}: text exactly as displayed.${note}`;
  }
}

/** Static instructions for a domain: identical for every frame, so it is the cacheable prefix. */
export function buildSystemPrompt(domainInput: DomainConfig): string {
  const domain = DomainConfigSchema.parse(domainInput);
  const features = screenFeatures(domain);
  return [
    `You read screenshots of a back-office case review application ("${domain.title}") and report what is on screen as structured data.`,
    "You only report what is visible. You never judge, decide or recommend anything.",
    "",
    "## Field catalogue",
    "Each field a reviewer can see for a case, with its id and the spelling to use for its value:",
    ...features.map(describeFeature),
    "",
    "## Actions",
    "Actions a reviewer can take (final actions close the case):",
    ...domain.actions.map((a) => `- \`${a.id}\` — "${a.label}"${a.terminal ? " (final)" : ""}`),
    "",
    "## Input",
    "Each request has the previous snapshot (the last state accepted for this session, as text), the current full screen, and — when the change was local — a high-resolution crop of the changed region with its position on the full screen.",
    "",
    "## What to return",
    "- `screen.caseId`: the id of the case open now, exactly as shown; null if no case is open.",
    "- `screen.values`: every catalogue field you can read for that case, using the catalogue spelling. Leave out fields you cannot read; never guess.",
    "- `events`: what happened between the previous snapshot and this screen, in order:",
    "  - `navigate`: the reviewer moved to another view (e.g. a list) with no case open; caseId null unless one is shown.",
    "  - `open_case`: a different case is open than in the previous snapshot (or the first case of the session). Do not emit field_change for the values of a newly opened case; report them in `screen.values`.",
    "  - `field_change`: a catalogue field of the SAME case now shows a different value than in the previous snapshot (an edit by the reviewer). Set `field`, `from` (the previous value) and `to` (the new value).",
    "  - `action`: the reviewer visibly committed an action (a saved decision, a confirmation, a status that now records it). Selecting an option that is not yet saved is not an action.",
    "  - Every event except navigate carries `caseId`. Unused members are null. `confidence` is your probability from 0 to 1 that the event really happened.",
    "  - If nothing changed, `events` is empty.",
    "- `proposedConcepts`: information on screen that looks relevant to the reviewer's decision but has no catalogue field (for example a document's status). `name` is a camelCase identifier; `observedValue` is what the screen shows. Empty if none.",
  ].join("\n");
}

function formatValue(value: FeatureValue): string {
  return isUnknown(value) ? `unknown (${value.reason})` : JSON.stringify(value);
}

function snapshotText(previous: CaseSnapshot | null): string {
  if (previous === null) return "Previous snapshot: none (first frame of the session).";
  const lines = Object.entries(previous.values).map(([id, value]) => `- ${id}: ${formatValue(value)}`);
  return [`Previous snapshot — case open: ${previous.caseId ?? "none"}`, ...lines].join("\n");
}

function assertUploadSize(image: EncodedImage, what: string): void {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1)
    throw new RangeError(`${what}: invalid size ${image.width}×${image.height}`);
  if (Math.max(image.width, image.height) > MAX_UPLOAD_LONG_EDGE)
    throw new RangeError(`${what}: long edge ${Math.max(image.width, image.height)} px exceeds ${MAX_UPLOAD_LONG_EDGE}; use prepareUpload()`);
}

const pngBlock = (image: EncodedImage): ClaudeContentBlock => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data: image.base64Png },
});

export type ExtractionContext = {
  domain: DomainConfig;
  previous: CaseSnapshot | null;
  frameSeq: number;
  captureTime: number;
  sessionEpoch: number;
};

export type ExtractionInput = ExtractionContext & {
  /** Full frame, already downscaled to ≤1568 px long edge (see `prepareUpload`). */
  frame: EncodedImage & { sourceWidth: number; sourceHeight: number };
  /** Native-resolution crop of the changed region; `rect` is in source-frame pixels. */
  crop?: EncodedImage & { rect: Rect };
};

/**
 * The `createClaude().structured` request for one frame, plus the context `toScreenEvents` needs.
 * Images must be pre-sized (≤1568 px long edge, enforced): resize and PNG-encode where the pixels
 * are (canvas in the browser, `prepareUpload` + an encoder in Node).
 *
 * Caching: the system prompt is marked `cacheSystem`, but Haiku 4.5 caches only prefixes of ≥4,096
 * tokens (api-notes §9); a catalogue the size of the KYC domain is well below that, so expect no
 * cache hits. The prompt is not padded to reach the minimum.
 */
export function buildExtractionRequest(input: ExtractionInput): {
  request: StructuredRequest<FrameOutputSchema>;
  context: ExtractionContext;
} {
  const { frame, crop, ...context } = input;
  assertUploadSize(frame, "frame");
  if (crop !== undefined) assertUploadSize(crop, "crop");
  const content: ClaudeContentBlock[] = [
    { type: "text", text: snapshotText(context.previous) },
    {
      type: "text",
      text: `Image 1: the full screen (${frame.sourceWidth}×${frame.sourceHeight} px, shown at ${frame.width}×${frame.height}).`,
    },
    pngBlock(frame),
  ];
  if (crop !== undefined) {
    const r = crop.rect;
    content.push(
      { type: "text", text: `Image 2: the changed region at native resolution: x=${r.x}, y=${r.y}, ${r.width}×${r.height} px of the full screen.` },
      pngBlock(crop),
    );
  }
  return {
    request: {
      model: CLAUDE_MODELS.frameEvents,
      system: buildSystemPrompt(context.domain),
      messages: [{ role: "user", content }],
      maxTokens: EXTRACTION_MAX_TOKENS,
      cacheSystem: true,
      schema: frameOutputSchema(context.domain),
    },
    context,
  };
}

export type DropReason =
  | "invalid_kind"
  | "invalid_confidence"
  | "missing_case"
  | "invalid_field"
  | "invalid_value"
  | "invalid_action"
  | "no_change"
  | "duplicate"
  | "invalid_name"
  | "known_concept";

export type Dropped = { where: "event" | "value" | "concept"; index: number; reason: DropReason };

export type ProposedConcept = { name: string; description: string; observedValue: string | null; frameSeq: number; captureTime: number };

export type ExtractionResult = {
  events: ScreenEvent[];
  /** The snapshot to apply with these events (and to send with the next frame). */
  snapshot: CaseSnapshot;
  /** Candidate new features for the "undefined concepts" list (plan §6.6); never applied automatically. */
  concepts: ProposedConcept[];
  dropped: Dropped[];
};

function sameValue(a: FeatureValue | undefined, b: Value): boolean {
  return a !== undefined && !isUnknown(a) && a === b;
}

/** Validates a structured output against the domain and turns it into schema-valid vision ScreenEvents. */
export function toScreenEvents(output: FrameOutput, context: ExtractionContext): ExtractionResult {
  const { domain, previous, frameSeq, captureTime, sessionEpoch } = context;
  const critical = new Set<string>(domain.criticalFields);
  const visible = screenFeatures(domain);
  const dropped: Dropped[] = [];

  const events: ScreenEvent[] = [];
  const seen = new Set<string>();
  output.events.forEach((raw, index) => {
    const drop = (reason: DropReason): void => void dropped.push({ where: "event", index, reason });
    const kind = SCREEN_EVENT_KINDS.find((k) => k === raw.kind);
    if (kind === undefined) return drop("invalid_kind");
    if (!Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) return drop("invalid_confidence");
    const eventCaseId = raw.caseId?.trim() || undefined;
    if (kind !== "navigate" && eventCaseId === undefined) return drop("missing_case");

    const event: ScreenEvent = {
      id: `vision-${sessionEpoch}-${frameSeq}-${events.length}`,
      frameSeq,
      captureTime,
      sessionEpoch,
      kind,
      ...(eventCaseId !== undefined && { caseId: eventCaseId }),
      confidence: raw.confidence,
      source: "vision",
      critical: false,
    };
    if (kind === "field_change") {
      if (raw.field === null || !visible.some((f) => f.id === raw.field)) return drop("invalid_field");
      if (raw.to === null) return drop("invalid_value");
      const to = validateFeatureValue(domain, raw.field, raw.to);
      if (!to.ok) return drop("invalid_value");
      if (raw.from !== null) {
        const from = validateFeatureValue(domain, raw.field, raw.from);
        if (!from.ok) return drop("invalid_value");
        event.from = from.value;
      }
      if (previous !== null && previous.caseId === eventCaseId && sameValue(previous.values[to.featureId], to.value))
        return drop("no_change");
      event.field = to.featureId;
      event.to = to.value;
      event.critical = critical.has(to.featureId);
    }
    if (kind === "action") {
      const action = domain.actions.find((a) => a.id === raw.action);
      if (action === undefined) return drop("invalid_action");
      event.action = action.id;
    }
    const key = JSON.stringify([event.kind, event.caseId, event.field, event.to, event.action]);
    if (seen.has(key)) return drop("duplicate");
    // Constructed to the schema above; the parse is a guard against drift in either.
    if (!ScreenEventSchema.safeParse(event).success) return drop("invalid_value");
    seen.add(key);
    events.push(event);
  });

  // Snapshot: same case → previous readings carry over (a scrolled-away field keeps its value); new case → start
  // unknown. Accepted field changes of the open case apply next; explicit readings of this frame win.
  const caseId = output.screen.caseId?.trim() || null;
  const sameCase = previous !== null && caseId !== null && previous.caseId === caseId;
  const values: Record<string, FeatureValue> = {};
  for (const f of visible) values[f.id] = (sameCase ? previous.values[f.id] : undefined) ?? unknown("not_visible");
  for (const e of events) if (e.kind === "field_change" && e.caseId === caseId && e.field !== undefined && e.to !== undefined) values[e.field] = e.to;
  output.screen.values.forEach((reading, index) => {
    if (!visible.some((f) => f.id === reading.field)) return void dropped.push({ where: "value", index, reason: "invalid_field" });
    const checked = validateFeatureValue(domain, reading.field, reading.value);
    if (checked.ok) values[checked.featureId] = checked.value;
    else dropped.push({ where: "value", index, reason: "invalid_value" });
  });
  const snapshot: CaseSnapshot = { caseId, values: values as Record<FeatureId, FeatureValue> };

  const known = new Set(domain.features.flatMap((f) => [f.id.toLowerCase(), f.label.toLowerCase()]));
  const concepts: ProposedConcept[] = [];
  output.proposedConcepts.forEach((c, index) => {
    const name = c.name.trim();
    if (!SymbolIdSchema.safeParse(name).success) return void dropped.push({ where: "concept", index, reason: "invalid_name" });
    if (known.has(name.toLowerCase())) return void dropped.push({ where: "concept", index, reason: "known_concept" });
    concepts.push({ name, description: c.description, observedValue: c.observedValue, frameSeq, captureTime });
  });

  return { events, snapshot, concepts, dropped };
}
