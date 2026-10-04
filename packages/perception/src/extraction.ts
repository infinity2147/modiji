/**
 * Frame → ScreenEvent extraction with Claude Haiku 4.5 structured output (plan §5, §7.1; api-notes
 * §8–10). Server-only (it imports the Claude wrapper's model routing and the Node PNG codec).
 *
 * Stateful reading — the model reads STATE, code derives EVENTS:
 *
 * - The server keeps the last applied reading of the session (`CaseSnapshot`: which case is open, the
 *   values of the fields the reviewer can edit, the final action the screen showed as committed, and a
 *   64×36 thumbnail of the frame it was read from).
 * - Code compares each new frame with that thumbnail (`planRead`). If the change is confined to a small
 *   region of a screen showing a case, the case cannot have changed (its header is outside the region),
 *   so only a crop of that region is sent and only the editable fields (and a commit the crop itself
 *   shows) are read ("local" read). A large or diffuse change sends the whole screen and reads the open
 *   case id, the editable fields and the committed action ("refresh" read; "full" when it also asks
 *   for concepts). A whole-screen read at least every `LOCAL_READ.maxAgeMs` bounds staleness. The
 *   output is a handful of values, never an event list.
 * - `interpretReading` turns two consecutive readings into events: a different case id is `open_case`
 *   (or `navigate` when no case is open) and only resets the baseline — a case switch is never an edit;
 *   a field_change is emitted only for a field the app declares editable (`ScreenProfile`), only within
 *   the same open case, and only when both readings are legible and differ; an `action` only when the
 *   committed action of the same case goes from a known "none" (or another action) to a final action.
 * - Values are validated against the domain's feature types; invalid ones are dropped and counted,
 *   never coerced. `critical` comes from `domain.criticalFields`; ids are deterministic.
 * - Undefined concepts (plan §6.6) are asked for once per opened case, on its first whole-screen read
 *   that cannot be a case switch, at most `MAX_CONCEPTS_PER_CASE_OPEN`, never a catalogue feature.
 * - Case identity is decided by code: the case can change only on a large screen change that shows
 *   another title; a different id read otherwise is a misreading (votes; the most-read id wins).
 * - The model is never shown previous values (it copies them); every value is read from the image.
 *
 * The prompt is built from the PUBLIC domain config only (`DomainConfigSchema` is strict, so an object
 * carrying anything else is refused), and every request still passes the oracle guard in
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
  type ActionId,
  type DomainConfig,
  type Feature,
  type FeatureId,
  type FeatureValue,
  type ScreenEvent,
  type Unknown,
} from "@vashistha/core";
import { CLAUDE_MODELS, type Claude, type ClaudeContentBlock, type StructuredRequest } from "@vashistha/core/server";
import { compareThumbnails, DEFAULT_CHANGE_CONFIG, thumbnail, type Thumbnail } from "./change-detector";
import { clampRect, contentRect, cropRgba, MAX_UPLOAD_LONG_EDGE, padRect, type Rect, type RgbaImage } from "./image";
import { encodePng } from "./png";

export type EncodedImage = { base64Png: string; width: number; height: number };

/**
 * Properties of the application on screen, declared by the app layer (never inferred by the model):
 *
 * - `editableFields`: which case fields the reviewer can change in this UI. Every other field is
 *   rendered read-only, so a different value there means a different case, never an edit.
 * - `chrome`: the app's own labels — headings, section titles, column headers, buttons, navigation and
 *   judge overlays — that are on screen whatever the case. A proposed concept grounded in them describes
 *   the screen, not the case, and is dropped (`screen_chrome`).
 */
export type ScreenProfile = { editableFields: readonly FeatureId[]; chrome: readonly string[] };

/** Validates a screen profile against the domain: editable fields must be distinct on-screen (`source: "case"`) features; chrome labels non-blank. */
export function screenProfile(domain: DomainConfig, editableFields: readonly string[], chrome: readonly string[] = []): ScreenProfile {
  if (editableFields.length === 0) throw new Error("a screen profile needs at least one editable field");
  const fields = editableFields.map((id) => {
    const feature = domain.features.find((f) => f.id === id);
    if (feature === undefined || feature.source !== "case") throw new Error(`editable field "${id}" is not an on-screen feature of ${domain.id}`);
    return feature.id;
  });
  if (new Set(fields).size !== fields.length) throw new Error("editable fields must be distinct");
  if (chrome.some((label) => words(label).length === 0)) throw new Error("a chrome label needs at least one word");
  return { editableFields: fields, chrome: [...chrome] };
}

/** The last applied reading of the session; what the next frame is compared against. */
export type CaseSnapshot = {
  /** Case open at that reading; null when no case was open. */
  caseId: string | null;
  /** Editable fields of that case as last read (`Unknown` until legible). */
  fields: Record<FeatureId, FeatureValue>;
  /** Final action the screen showed as committed for that case: null = none shown; `Unknown` = never legibly read. */
  committed: ActionId | null | Unknown;
  /** Thumbnail of the frame the reading came from (code compares the next frame with it). */
  thumbnail: Thumbnail;
  /** Capture time of the last whole-screen read (case id and committed action re-read). */
  fullReadAt: number;
  /** Whether this case's screen was already read for undefined concepts (once per opened case). */
  conceptsRead: boolean;
  /** Case-id readings during this visit of the case: the id is the most read one (ids in small fonts get misread). */
  caseVotes: Record<string, number>;
  /** The open case's title as first read (large type, rarely misread): the same title is the same case. */
  caseTitle: string | null;
};

/** Local reads: what counts as "changed" (grey levels per 64×36 cell), how small a change must be, and the crop margin. */
export const LOCAL_READ = {
  /**
   * Lower than the detector's 6 on purpose: a dropdown's text changing between two words of similar
   * ink ("Unrated" → "Medium") moves its cells by only 2–5 grey levels, and the crop must contain it.
   */
  cellThreshold: 2,
  /** Changed region (before the margin) at most this share of the frame. */
  maxAreaShare: 0.25,
  /** Context around the changed region, px of the uploaded frame (labels next to a changed value). */
  margin: 64,
  /**
   * Local reads skip the case id (and see a committed action only inside the crop), and a sub-threshold
   * change elsewhere would go unseen; a whole-screen read at least this often (when the screen changes)
   * bounds how stale either can get.
   */
  maxAgeMs: 8000,
} as const;

/**
 * - `full`: the whole screen, plus undefined concepts — once per case, on its first whole-screen read
 *   that cannot be a case switch (concepts cost output tokens: never on a case-switch frame);
 * - `refresh`: the whole screen (case id, editable fields, committed action);
 * - `local`: a crop of the changed region; the case is unchanged (editable fields, and a committed
 *   action only if the crop itself shows one).
 */
export type ReadMode = "full" | "refresh" | "local";
/** `switchPossible`: the change since the last reading is large enough to be another case (code decides, not the model). */
export type ReadPlan = { scope: "screen"; switchPossible: boolean } | { scope: "local"; rect: Rect };

/**
 * Code decides how much the model must look at: the whole screen when there is no case to compare
 * with, nothing measurable changed (re-read rather than guess), the frame size changed, the change is
 * diffuse or large, or the last whole-screen read is older than `LOCAL_READ.maxAgeMs`; otherwise a
 * local read of the changed region plus margin.
 */
export function planRead(previous: CaseSnapshot | null, current: Thumbnail, captureTime: number): ReadPlan {
  if (previous === null || previous.caseId === null) return { scope: "screen", switchPossible: true };
  const diff = compareThumbnails(previous.thumbnail, current, { ...DEFAULT_CHANGE_CONFIG, cellThreshold: LOCAL_READ.cellThreshold, padding: 0 });
  if (diff.reason === "none") return { scope: "screen", switchPossible: false };
  if (diff.reason !== "cells" || diff.bbox === null) return { scope: "screen", switchPossible: true };
  if (diff.bbox.width * diff.bbox.height > LOCAL_READ.maxAreaShare * current.width * current.height) return { scope: "screen", switchPossible: true };
  if (captureTime - previous.fullReadAt > LOCAL_READ.maxAgeMs) return { scope: "screen", switchPossible: false };
  const rect = clampRect(padRect(diff.bbox, LOCAL_READ.margin), current.width, current.height);
  return rect === null ? { scope: "screen", switchPossible: false } : { scope: "local", rect };
}

/** Words that, appended to a catalogue feature's name, still name that feature. */
const GENERIC_SUFFIXES = ["status", "flag", "indicator", "value", "result", "check", "state", "verification"] as const;

/**
 * Words that name a part of a user interface, not information about a case: a concept described with
 * them ("Tabs showing …", "Review sections: …") reports the screen's structure.
 */
const UI_STRUCTURE_WORDS: ReadonlySet<string> = new Set(["tab", "tabs", "section", "sections", "heading", "headings", "button", "buttons", "panel", "panels", "menu", "menus", "sidebar", "toolbar", "navigation", "breadcrumb", "breadcrumbs", "dialog", "ticker", "banner", "layout", "ui"]);
/** Observed "values" that only say something is on screen: case content shows a value, not that it is shown. */
const UI_STATE_VALUES: ReadonlySet<string> = new Set(["visible", "displayed", "shown", "on screen", "hidden", "expanded", "collapsed", "highlighted"]);
/** Joining words a label sequence may contain ("source of funds and documents"). */
const JOINING_WORDS: ReadonlySet<string> = new Set(["a", "an", "and", "at", "by", "for", "in", "of", "on", "or", "per", "the", "to", "with"]);

/** "screeningSourceOfFunds", "Source of funds (verified)" → ["screening", "source", "of", "funds"] / ["source", "of", "funds"]; parentheticals are dropped. */
function words(text: string): string[] {
  return text
    .replace(/\([^)]*\)/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
}

type Cover = { chrome: boolean; feature: boolean };

/**
 * Whether `text` is nothing but labels: every word belongs to a chrome label or a catalogue feature's
 * label or id, matched as whole word sequences, with joining words between them. Undefined when some
 * word is neither (the text says something of its own); otherwise which kinds of label it used.
 */
function labelCover(text: string, chrome: readonly string[][], features: readonly string[][]): Cover | undefined {
  const ws = words(text);
  if (ws.length === 0) return undefined;
  const phrases = [...chrome.map((p) => ({ p, kind: "chrome" as const })), ...features.map((p) => ({ p, kind: "feature" as const }))];
  // covers[i]: the label kinds of every way to cover ws[i..] (at most four combinations).
  const covers: Cover[][] = Array.from({ length: ws.length + 1 }, () => []);
  covers[ws.length] = [{ chrome: false, feature: false }];
  const add = (at: number, c: Cover): void => {
    const list = covers[at] ?? [];
    if (!list.some((k) => k.chrome === c.chrome && k.feature === c.feature)) list.push(c);
    covers[at] = list;
  };
  for (let i = ws.length - 1; i >= 0; i--) {
    if (JOINING_WORDS.has(ws[i] ?? "")) for (const c of covers[i + 1] ?? []) add(i, c);
    for (const { p, kind } of phrases)
      if (p.length > 0 && p.every((w, k) => ws[i + k] === w))
        for (const c of covers[i + p.length] ?? []) add(i, { chrome: c.chrome || kind === "chrome", feature: c.feature || kind === "feature" });
  }
  const labelled = (covers[0] ?? []).filter((c) => c.chrome || c.feature);
  if (labelled.length === 0) return undefined;
  return { chrome: labelled.some((c) => c.chrome), feature: labelled.some((c) => c.feature) };
}

/**
 * Why a proposed concept is not about the case (deterministic grounding), or undefined when it may be:
 * - `screen_chrome`: its description names a part of the interface (`UI_STRUCTURE_WORDS`), its observed
 *   value only says something is on screen (`UI_STATE_VALUES`), or its name or description is nothing but
 *   labels (`labelCover`) among which at least one is the app's chrome (`ScreenProfile.chrome`);
 * - `known_concept`: its name is nothing but catalogue feature labels (several features under one name).
 */
function ungrounded(concept: { name: string; description: string; observedValue: string | null }, domain: DomainConfig, profile: ScreenProfile): DropReason | undefined {
  const chrome = profile.chrome.map(words);
  const features = domain.features.flatMap((f) => [words(f.id), words(f.label)]);
  if (words(concept.description).some((w) => UI_STRUCTURE_WORDS.has(w))) return "screen_chrome";
  if (concept.observedValue !== null && UI_STATE_VALUES.has(words(concept.observedValue).join(" "))) return "screen_chrome";
  const name = labelCover(concept.name, chrome, features);
  if (name?.chrome === true || labelCover(concept.description, chrome, features)?.chrome === true) return "screen_chrome";
  return name === undefined ? undefined : "known_concept";
}

/** At most this many undefined concepts are accepted per opened case. */
export const MAX_CONCEPTS_PER_CASE_OPEN = 2;

/**
 * Vision events carry this fixed confidence: the model is not asked for a self-reported probability
 * (uncalibrated, and it cost output tokens on every event). An event is derived by code from two
 * legible readings; how far vision can be trusted is the precision the P2 evaluation measures.
 */
export const VISION_EVENT_CONFIDENCE = 0.9;

/** Upper bound on a reading's structured output (a case id, a few values, ≤2 short concepts). */
export const EXTRACTION_MAX_TOKENS = 512;

const nullable = <T extends z.ZodType>(schema: T, whenNull: string) => z.union([schema, z.null().describe(whenNull)]);

function editableFeatures(domain: DomainConfig, profile: ScreenProfile): Feature[] {
  return profile.editableFields.map((id) => {
    const feature = domain.features.find((f) => f.id === id);
    if (feature === undefined) throw new Error(`editable field "${id}" is not in ${domain.id}`);
    return feature;
  });
}

const finalActions = (domain: DomainConfig) => domain.actions.filter((a) => a.terminal);

/** Descriptions stay terse: the structured-output schema is sent as input tokens on every request. */
function valueSchema(f: Feature) {
  switch (f.type) {
    case "enum":
      return z.string().describe(`one of: ${f.values.join(", ")}`);
    case "boolean":
      return z.boolean().describe("true/false");
    case "number":
      return z.number().describe("digits only");
    case "string":
      return z.string().describe("as displayed");
  }
}

/**
 * The editable fields as a fixed-key object (keys cost no ambiguity and fewer tokens than a list of
 * {field, value} pairs). Shaped for Anthropic constrained decoding as `zodOutputFormat` converts it
 * (api-notes §8; @anthropic-ai/sdk 0.131 checked): strict objects, every property required, no
 * numeric/length limits, nullable members as `anyOf` with a description on each member. Enum ids
 * are listed in descriptions — the SDK moves `enum` there anyway — and checked in code.
 */
function fieldsSchema(domain: DomainConfig, profile: ScreenProfile) {
  return z.strictObject(
    Object.fromEntries(editableFeatures(domain, profile).map((f) => [f.id, nullable(valueSchema(f), "not shown or not legible")])),
  );
}

function caseShape(domain: DomainConfig, profile: ScreenProfile) {
  return {
    caseId: nullable(z.string().describe("open case id, as displayed"), "no case open"),
    caseTitle: nullable(z.string().describe("open case title, as displayed"), "no case open"),
    fields: fieldsSchema(domain, profile),
    committed: nullable(z.string().describe(`one of: ${finalActions(domain).map((a) => a.id).join(", ")}`), "none shown"),
  };
}

/** Full read: the whole screen, which may show a newly opened case. */
export function fullReadSchema(domain: DomainConfig, profile: ScreenProfile) {
  return z.strictObject({
    ...caseShape(domain, profile),
    concepts: z.array(
      z.strictObject({
        name: z.string().describe("camelCase"),
        description: z.string().describe("≤ 12 words"),
        observedValue: nullable(z.string().describe("as shown"), "none"),
      }),
    ),
  });
}

/** Refresh read: the whole screen after a small change; no concepts. */
export function refreshReadSchema(domain: DomainConfig, profile: ScreenProfile) {
  return z.strictObject(caseShape(domain, profile));
}

/** Local read: a crop of the only changed region, same case. */
export function localReadSchema(domain: DomainConfig, profile: ScreenProfile) {
  const { fields, committed } = caseShape(domain, profile);
  return z.strictObject({ fields, committed });
}

export type FullReadSchema = ReturnType<typeof fullReadSchema>;
export type RefreshReadSchema = ReturnType<typeof refreshReadSchema>;
export type LocalReadSchema = ReturnType<typeof localReadSchema>;
export type FullRead = z.infer<FullReadSchema>;
export type RefreshRead = z.infer<RefreshReadSchema>;
export type LocalRead = z.infer<LocalReadSchema>;
export type FrameReading = { mode: "full"; output: FullRead } | { mode: "refresh"; output: RefreshRead } | { mode: "local"; output: LocalRead };

function describeValues(f: Feature): string {
  switch (f.type) {
    case "enum":
      return `one of ${f.values.map((v) => `\`${v}\``).join(", ")}`;
    case "boolean":
      return "true or false";
    case "number":
      return `${f.integer ? "an integer" : "a number"} from ${f.min} to ${f.max}${f.unit === undefined ? "" : ` (${f.unit})`}, digits only`;
    case "string":
      return "text exactly as displayed";
  }
}

/** Static instructions for a domain and screen: identical for every frame. */
export function buildSystemPrompt(domainInput: DomainConfig, profile: ScreenProfile): string {
  const domain = DomainConfigSchema.parse(domainInput);
  const editable = editableFeatures(domain, profile);
  const editableIds = new Set<string>(profile.editableFields);
  const readOnly = domain.features.filter((f) => f.source === "case" && !editableIds.has(f.id));
  return [
    `You read screenshots of a back-office case review application ("${domain.title}") and report what the screen shows as structured data.`,
    "You only read. You never judge, decide or recommend. Never guess: null is always better than a guess.",
    "",
    "## Fields the reviewer edits (report these)",
    ...editable.map((f) => `- \`${f.id}\` — "${f.label}": ${describeValues(f)}.${f.description === undefined ? "" : ` ${f.description}`}`),
    "Write the id spelling (`medium`, not \"Medium\"). Read the value the field's control shows; an open option list does not change it. Once the case's decision is committed, read the committed summary.",
    "",
    "## Final actions (committing one closes the case)",
    ...finalActions(domain).map((a) => `- \`${a.id}\` — "${a.label}"`),
    "",
    "## Other case fields (already known: never report them as concepts)",
    readOnly.map((f) => `\`${f.id}\` ("${f.label}")`).join(", "),
    "",
    "## Requests",
    "Each request gives the previous reading (text) and one image.",
    "FULL or REFRESH (the whole screen):",
    "- `caseId`: id of the case whose file is open, exactly as displayed in its header; null when no case file is open (a list, an empty, loading or unrelated screen).",
    "- `caseTitle`: that case's title (for example the customer's name in its header), exactly as displayed; null when no case file is open.",
    "- `fields`: each field the reviewer edits, as shown for the open case; null when not shown or not legible.",
    "- `committed`: the final action the screen shows as committed (saved) for the open case; null when none is shown. A selected but unsaved option is not committed.",
    `- \`concepts\` (FULL only): at most ${MAX_CONCEPTS_PER_CASE_OPEN} items of information on screen that look relevant to the reviewer's decision but are none of the fields above (e.g. a document's status); [] when there are none.`,
    "LOCAL (a crop of the only region that changed since the previous reading; the same case is open): `fields` as shown in the crop, null when the crop does not show the field; `committed` only when the crop itself shows the decision as committed (a saved summary or a decided status), otherwise null — a selected option, a highlighted list item or a button label is never a committed action.",
  ].join("\n");
}

/**
 * What the model is told about the previous reading. Never its values: shown a previous case id the
 * model copies it (measured: told "NS-2626-0303", it read the next case as "NS-2626-0304" in 2 of 2
 * calls, against "NS-2026-0304" without it), so every value is read from the image; code compares.
 */
function previousText(previous: CaseSnapshot | null): string {
  if (previous === null) return "Previous reading: none (first frame of the session).";
  return previous.caseId === null ? "Previous reading: no case file was open." : "Previous reading: a case file was open. Read every value from the image.";
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
  profile: ScreenProfile;
  previous: CaseSnapshot | null;
  frameSeq: number;
  captureTime: number;
  sessionEpoch: number;
};

export type ExtractionInput = ExtractionContext & {
  /** The uploaded full frame (≤1568 px long edge, see `prepareUpload`), decoded; `base64Png` when it is already encoded. */
  frame: { image: RgbaImage; base64Png?: string; sourceWidth: number; sourceHeight: number };
  /** The client's native-resolution crop of its change bbox; `rect` is in source-frame pixels. */
  crop?: EncodedImage & { rect: Rect };
};

/** What `interpretReading` needs besides the output: the request's context, its mode and the frame's thumbnail. */
export type ReadContext = ExtractionContext & { mode: ReadMode; thumbnail: Thumbnail; switchPossible: boolean };

export type PreparedRead =
  | { mode: "full"; request: StructuredRequest<FullReadSchema>; context: ReadContext }
  | { mode: "refresh"; request: StructuredRequest<RefreshReadSchema>; context: ReadContext }
  | { mode: "local"; request: StructuredRequest<LocalReadSchema>; context: ReadContext; rect: Rect };

/** Whole-screen reads send the frame without uniform margins when that removes at least 10% of it. */
const TRIM_MIN_SAVING = 0.9;

const toEncoded = (image: RgbaImage): EncodedImage => ({ base64Png: encodePng(image).toString("base64"), width: image.width, height: image.height });

/**
 * Plans and builds the `createClaude().structured` request for one frame. The full frame goes to the
 * model only on a full or refresh read; the client's hi-res crop is added only when it adds resolution (the
 * upload was downscaled from a larger source). A local read sends a crop of the uploaded frame.
 *
 * Caching: the system prompt is marked `cacheSystem`, but Haiku 4.5 caches only prefixes of ≥4,096
 * tokens (api-notes §9) and this prompt is far shorter; it is not padded to reach the minimum.
 */
export function prepareRead(input: ExtractionInput): PreparedRead {
  const { frame, crop, ...context } = input;
  if (Math.max(frame.image.width, frame.image.height) > MAX_UPLOAD_LONG_EDGE)
    throw new RangeError(`frame: long edge ${Math.max(frame.image.width, frame.image.height)} px exceeds ${MAX_UPLOAD_LONG_EDGE}; use prepareUpload()`);
  if (crop !== undefined) assertUploadSize(crop, "crop");
  const thumb = thumbnail(frame.image);
  const plan = planRead(context.previous, thumb, context.captureTime);
  const previous = context.previous;
  const base = {
    model: CLAUDE_MODELS.frameEvents,
    system: buildSystemPrompt(context.domain, context.profile),
    maxTokens: EXTRACTION_MAX_TOKENS,
    cacheSystem: true,
  } as const;
  const previousBlock: ClaudeContentBlock = { type: "text", text: previousText(previous) };
  const screen = `${frame.image.width}×${frame.image.height}`;

  if (plan.scope === "local") {
    const r = plan.rect;
    const content: ClaudeContentBlock[] = [
      previousBlock,
      { type: "text", text: `LOCAL read. Image: the changed region, x=${r.x}, y=${r.y}, ${r.width}×${r.height} px of the ${screen} screen.` },
      pngBlock(toEncoded(cropRgba(frame.image, r))),
    ];
    return {
      mode: "local",
      rect: r,
      request: { ...base, messages: [{ role: "user", content }], schema: localReadSchema(context.domain, context.profile) },
      context: { ...context, mode: "local", thumbnail: thumb, switchPossible: false },
    };
  }

  // Uniform margins carry nothing to read; trimming them saves image tokens (input tokens add latency).
  const visible = contentRect(frame.image);
  const trimmed = visible.width * visible.height <= TRIM_MIN_SAVING * frame.image.width * frame.image.height;
  const full: EncodedImage = trimmed
    ? toEncoded(cropRgba(frame.image, visible))
    : frame.base64Png === undefined
      ? toEncoded(frame.image)
      : { base64Png: frame.base64Png, width: frame.image.width, height: frame.image.height };
  assertUploadSize(full, "frame");
  const downscaled = frame.sourceWidth > frame.image.width || frame.sourceHeight > frame.image.height;
  // Concepts cost output tokens: asked once per case, on a whole-screen read that cannot be a case switch.
  const { switchPossible } = plan;
  const mode = previous !== null && previous.caseId !== null && !previous.conceptsRead && !switchPossible ? "full" : "refresh";
  const label = mode === "full" ? "FULL" : "REFRESH";
  const shown = trimmed
    ? `the full screen (${frame.sourceWidth}×${frame.sourceHeight} px, shown at ${screen}) without its blank margins: x=${visible.x}, y=${visible.y}, ${visible.width}×${visible.height}`
    : `the full screen (${frame.sourceWidth}×${frame.sourceHeight} px, shown at ${screen})`;
  const content: ClaudeContentBlock[] = [previousBlock, { type: "text", text: `${label} read. Image 1: ${shown}.` }, pngBlock(full)];
  if (crop !== undefined && downscaled) {
    const r = crop.rect;
    content.push(
      { type: "text", text: `Image 2: the region that changed last, at native resolution: x=${r.x}, y=${r.y}, ${r.width}×${r.height} px of the full screen.` },
      pngBlock(crop),
    );
  }
  const messages = [{ role: "user" as const, content }];
  return mode === "full"
    ? { mode: "full", request: { ...base, messages, schema: fullReadSchema(context.domain, context.profile) }, context: { ...context, mode: "full", thumbnail: thumb, switchPossible } }
    : {
        mode: "refresh",
        request: { ...base, messages, schema: refreshReadSchema(context.domain, context.profile) },
        context: { ...context, mode: "refresh", thumbnail: thumb, switchPossible },
      };
}

/** Runs a prepared read through the Claude wrapper (oracle guard, stop-reason checks, zod validation). */
export async function executeRead(
  read: PreparedRead,
  claude: Pick<Claude, "structured">,
): Promise<{ reading: FrameReading; usage: Awaited<ReturnType<Claude["structured"]>>["usage"]; latencyMs: number }> {
  if (read.mode === "full") {
    const { output, usage, latencyMs } = await claude.structured(read.request);
    return { reading: { mode: "full", output }, usage, latencyMs };
  }
  if (read.mode === "refresh") {
    const { output, usage, latencyMs } = await claude.structured(read.request);
    return { reading: { mode: "refresh", output }, usage, latencyMs };
  }
  const { output, usage, latencyMs } = await claude.structured(read.request);
  return { reading: { mode: "local", output }, usage, latencyMs };
}

export type DropReason =
  | "invalid_case"
  | "invalid_value"
  | "invalid_action"
  | "invalid_name"
  | "known_concept"
  | "screen_chrome"
  | "unexpected_concept"
  | "concept_cap"
  | "duplicate";

export type Dropped = { where: "reading" | "field" | "committed" | "concept"; key: string; reason: DropReason };

export type ProposedConcept = { name: string; description: string; observedValue: string | null; frameSeq: number; captureTime: number };

export type ExtractionResult = {
  events: ScreenEvent[];
  /** The snapshot to apply with these events (and to compare the next frame with). */
  snapshot: CaseSnapshot;
  /** Candidate new features for the "undefined concepts" list (plan §6.6); never applied automatically. */
  concepts: ProposedConcept[];
  dropped: Dropped[];
};

const known = (value: FeatureValue | undefined): value is Exclude<FeatureValue, Unknown> => value !== undefined && !isUnknown(value);

/** Validates a reading against the domain and derives schema-valid vision ScreenEvents from it and the previous snapshot. */
export function interpretReading(reading: FrameReading, context: ReadContext): ExtractionResult {
  const { domain, profile, previous, frameSeq, captureTime, sessionEpoch } = context;
  const dropped: Dropped[] = [];
  const events: ScreenEvent[] = [];
  const emit = (event: Pick<ScreenEvent, "kind"> & Partial<ScreenEvent>): void => {
    const full: ScreenEvent = {
      id: `vision-${sessionEpoch}-${frameSeq}-${events.length}`,
      frameSeq,
      captureTime,
      sessionEpoch,
      confidence: VISION_EVENT_CONFIDENCE,
      source: "vision",
      critical: false,
      ...event,
    };
    // Constructed to the schema; the parse is a guard against drift in either.
    events.push(ScreenEventSchema.parse(full));
  };

  // An extractor bug, not a reading: refuse the whole frame (the caller counts it as failed).
  if (reading.mode !== context.mode) throw new Error(`extractor answered a ${reading.mode} read for a ${context.mode} request`);

  // Which case is open. Code decides whether it can have changed: only on a large change (`switchPossible`)
  // that shows another title. Otherwise a different (or missing) id is a misreading of the same case: it only
  // votes, and the case keeps the id read most often during this visit. A local read never reads the id.
  let read: string | null | undefined;
  if (reading.mode !== "local") {
    const raw = reading.output.caseId;
    read = raw === null ? null : raw.trim() === "" ? null : raw.trim();
    if (raw !== null && read === null) dropped.push({ where: "reading", key: "caseId", reason: "invalid_case" });
  }
  const titleRead = reading.mode === "local" ? null : (reading.output.caseTitle?.trim() || null);
  const sameTitle = titleRead !== null && previous?.caseTitle != null && titleKey(titleRead) === titleKey(previous.caseTitle);
  const sameVisit =
    previous !== null && previous.caseId !== null && (read === undefined || read === previous.caseId || sameTitle || !context.switchPossible);
  const caseVotes: Record<string, number> = sameVisit ? { ...previous.caseVotes } : {};
  if (typeof read === "string") caseVotes[read] = (caseVotes[read] ?? 0) + 1;
  let caseId: string | null = sameVisit ? previous.caseId : (read ?? null);
  // Ties keep the id already in use.
  for (const [id, votes] of Object.entries(caseVotes)) if (caseId !== null && votes > (caseVotes[caseId] ?? 0)) caseId = id;
  const opened = !sameVisit && (previous === null || previous.caseId !== caseId);
  if (opened) {
    if (caseId === null) emit({ kind: "navigate" });
    else emit({ kind: "open_case", caseId });
  }

  // Editable fields: a new case starts from what this frame shows; the same case keeps unreadable fields.
  const fields: Record<string, FeatureValue> = opened ? unknownFields(profile) : { ...(previous?.fields ?? unknownFields(profile)) };
  if (caseId !== null) {
    for (const id of profile.editableFields) {
      const raw = reading.output.fields[id];
      if (raw === null || raw === undefined) continue;
      const checked = validateFeatureValue(domain, id, raw);
      if (!checked.ok) {
        dropped.push({ where: "field", key: id, reason: "invalid_value" });
        continue;
      }
      const before = fields[id];
      if (!opened && known(before) && before !== checked.value)
        emit({ kind: "field_change", caseId, field: id, from: before, to: checked.value, critical: domain.criticalFields.includes(id) });
      fields[id] = checked.value;
    }
  }

  // Committed final action: an event only for the same case, from a known state, to a different action.
  // (Not `??`: a known "none" is null and must survive.)
  let committed: CaseSnapshot["committed"] = opened || previous === null ? unknown("not_extracted") : previous.committed;
  if (caseId !== null) {
    const raw = reading.output.committed;
    const action = raw === null ? null : finalActions(domain).find((a) => a.id === raw.trim());
    if (action === undefined) dropped.push({ where: "committed", key: String(raw), reason: "invalid_action" });
    else if (action === null) {
      // "None shown" never un-commits a decision already read for this case.
      if (committed === null || isUnknown(committed)) committed = null;
    } else {
      if (!opened && (committed === null || (!isUnknown(committed) && committed !== action.id)))
        emit({ kind: "action", caseId, action: action.id });
      committed = action.id;
    }
  }

  // Undefined concepts: only from the frame that opens a case, capped, never a catalogue feature, never the screen's own chrome.
  const concepts: ProposedConcept[] = [];
  if (reading.mode === "full") {
    // A catalogue feature under another name is not a new concept: its id or label, a prefix of either
    // ("countryRisk" for "Country risk (Northstar list)"), or either plus a generic suffix ("sourceOfFundsStatus").
    const key = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");
    const catalogue = domain.features.flatMap((f) => [key(f.id), key(f.label)]);
    const isCatalogued = (name: string): boolean => {
      const n = key(name);
      return catalogue.some((k) => k.startsWith(n) || GENERIC_SUFFIXES.some((suffix) => n === k + suffix));
    };
    for (const c of reading.output.concepts) {
      const name = c.name.trim();
      const reason: DropReason | undefined =
        opened || caseId === null || previous === null || previous.conceptsRead
          ? "unexpected_concept"
          : !SymbolIdSchema.safeParse(name).success
            ? "invalid_name"
            : isCatalogued(name)
              ? "known_concept"
              : (ungrounded(c, domain, profile) ??
                (concepts.some((k) => k.name.toLowerCase() === name.toLowerCase())
                  ? "duplicate"
                  : concepts.length >= MAX_CONCEPTS_PER_CASE_OPEN
                    ? "concept_cap"
                    : undefined));
      if (reason !== undefined) dropped.push({ where: "concept", key: name, reason });
      else concepts.push({ name, description: c.description.trim(), observedValue: c.observedValue, frameSeq, captureTime });
    }
  }

  return {
    events,
    snapshot: {
      caseId,
      fields: fields as Record<FeatureId, FeatureValue>,
      committed,
      thumbnail: context.thumbnail,
      fullReadAt: reading.mode === "local" ? (previous?.fullReadAt ?? captureTime) : captureTime,
      conceptsRead: !opened && (reading.mode === "full" || (previous?.conceptsRead ?? false)),
      caseVotes,
      caseTitle: caseId === null ? null : sameVisit ? (previous.caseTitle ?? titleRead) : titleRead,
    },
    concepts,
    dropped,
  };
}

/** Titles compare by their letters and digits only (spacing, punctuation and case vary between renderings). */
const titleKey = (title: string): string => title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function unknownFields(profile: ScreenProfile): Record<FeatureId, FeatureValue> {
  return Object.fromEntries(profile.editableFields.map((id) => [id, unknown("not_visible")])) as Record<FeatureId, FeatureValue>;
}

/**
 * Compiles the three output grammars ahead of the first frame: the first request with a new
 * structured-output schema pays a one-off compile (≈5 s measured, api-notes §15; grammars are then
 * cached for 24 h). One tiny text-only request per read mode; the answers are discarded.
 */
export async function warmUpExtraction(claude: Pick<Claude, "structured">, domain: DomainConfig, profile: ScreenProfile): Promise<void> {
  const base = { model: CLAUDE_MODELS.frameEvents, system: buildSystemPrompt(domain, profile), maxTokens: EXTRACTION_MAX_TOKENS, cacheSystem: true } as const;
  const messages = [{ role: "user" as const, content: "Warm-up request with no image: report null for every value and no concepts." }];
  await Promise.all([
    claude.structured({ ...base, messages, schema: fullReadSchema(domain, profile) }),
    claude.structured({ ...base, messages, schema: refreshReadSchema(domain, profile) }),
    claude.structured({ ...base, messages, schema: localReadSchema(domain, profile) }),
  ]);
}
