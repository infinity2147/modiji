import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AGENT_ROLES, CUSTOM_LLM_PATH, agentModelId, type AgentRole } from "../agents";
import type { AgentRequestBody, JsonObject, JsonValue } from "./elevenlabs";

/**
 * Desired ElevenLabs agent configuration (versioned JSON in `/agents`), rendering, and the read-back checks run by
 * `scripts/agents.ts` after every sync and by preflight.
 */

export { AGENT_ID_ENV, AGENT_ROLES, CUSTOM_LLM_PATH, agentModelId, parseAgentModelId, type AgentRole } from "../agents";

const PLACEHOLDER_RE = /\{\{[^{}]*\}\}/;

const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), z.json());

const MODEL_ID_PATH = ["conversation_config", "agent", "prompt", "custom_llm", "model_id"] as const;

export const AgentSpecSchema = z
  .strictObject({
    /** Bumped on every change; part of the model id, so the endpoint can tell config versions apart. */
    version: z.int().positive(),
    name: z.string(),
    role: z.enum(AGENT_ROLES),
    body: z.strictObject({ conversation_config: JsonObjectSchema, platform_settings: JsonObjectSchema }),
  })
  .superRefine((spec, ctx) => {
    if (spec.name !== `vashistha-${spec.role}`) {
      ctx.addIssue({ code: "custom", path: ["name"], message: `must be "vashistha-${spec.role}" for role ${spec.role}` });
    }
    const expected = agentModelId(spec);
    if (valueAt(spec.body, MODEL_ID_PATH) !== expected) {
      ctx.addIssue({ code: "custom", path: ["body", ...MODEL_ID_PATH], message: `must be "${expected}" (name and version)` });
    }
  });
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

/** Reads and validates an agent spec file; errors name the file. */
export async function loadAgentSpec(path: string | URL): Promise<AgentSpec> {
  const text = await readFile(path, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`${String(path)}: invalid JSON (${err instanceof Error ? err.message : String(err)})`, { cause: err });
  }
  const result = AgentSpecSchema.safeParse(json);
  if (!result.success) throw new Error(`${String(path)}: invalid agent spec\n${z.prettifyError(result.error)}`);
  return result.data;
}

export type RenderAgentOptions = {
  /** Public https origin (plus optional path) of this service, without a trailing slash. */
  publicBaseUrl: string;
  /** Workspace secret id holding CUSTOM_LLM_SECRET (never the secret itself). */
  customLlmSecretId: string;
};

const HttpsBaseUrlSchema = z
  .url({ protocol: /^https$/ })
  .refine((value) => !value.endsWith("/") && !/[?#]/.test(value), "no trailing slash, query or fragment");
const SecretIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, "letters, digits, _ or -");

/** Substitutes `{{PUBLIC_BASE_URL}}` and `{{CUSTOM_LLM_SECRET_ID}}` in every string; throws if any `{{…}}` remains. */
export function renderAgentBody(spec: AgentSpec, options: RenderAgentOptions): AgentRequestBody {
  const baseUrl = HttpsBaseUrlSchema.safeParse(options.publicBaseUrl);
  if (!baseUrl.success) {
    throw new Error("publicBaseUrl must be a public https URL without a trailing slash (ElevenLabs calls it)");
  }
  if (!SecretIdSchema.safeParse(options.customLlmSecretId).success) {
    throw new Error("customLlmSecretId is not a valid secret id");
  }
  const vars: Readonly<Record<string, string>> = {
    "{{PUBLIC_BASE_URL}}": baseUrl.data,
    "{{CUSTOM_LLM_SECRET_ID}}": options.customLlmSecretId,
  };
  const substitute = (value: JsonValue): JsonValue => {
    if (typeof value === "string") return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(k, v), value);
    if (Array.isArray(value)) return value.map(substitute);
    return value !== null && typeof value === "object" ? substituteObject(value) : value;
  };
  const substituteObject = (value: JsonObject): JsonObject =>
    Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
  const body: AgentRequestBody = {
    name: spec.name,
    conversation_config: substituteObject(spec.body.conversation_config),
    platform_settings: substituteObject(spec.body.platform_settings),
  };
  const leftovers: string[] = [];
  collectPlaceholders(body, "", leftovers);
  if (leftovers.length > 0) throw new Error(`${spec.name}: unresolved placeholders at ${leftovers.join(", ")}`);
  return body;
}

function collectPlaceholders(value: JsonValue, path: string, out: string[]): void {
  if (typeof value === "string") {
    if (PLACEHOLDER_RE.test(value)) out.push(path || "(root)");
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => collectPlaceholders(item, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const child = path ? `${path}.${key}` : key;
      if (PLACEHOLDER_RE.test(key)) out.push(`${child} (key)`);
      collectPlaceholders(item, child, out);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let value = root;
  for (const key of path) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

function show(value: unknown): string {
  if (value === undefined) return "missing";
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

export type AgentInvariantOptions = { publicBaseUrl: string; role: AgentRole; expectedModelId: string };

/**
 * Safety-critical settings read back from `GET /v1/convai/agents/{id}`. Returns one human-readable problem per violated
 * setting (empty = OK). These are the settings that could make the agent speak without our authorization, route
 * around our custom LLM, or break the gate's inputs.
 */
export function checkAgentInvariants(agent: unknown, options: AgentInvariantOptions): string[] {
  const problems: string[] = [];
  const check = (path: string, ok: (value: unknown) => boolean, expectation: string): void => {
    const value = valueAt(agent, path.split("."));
    if (!ok(value)) problems.push(`${path} is ${show(value)}; expected ${expectation}`);
  };
  const equals = (path: string, expected: unknown): void => check(path, (v) => v === expected, JSON.stringify(expected));
  const notTrue = (path: string, why: string): void => check(path, (v) => v !== true, `not true (${why})`);

  const prompt = "conversation_config.agent.prompt";
  equals("name", `vashistha-${options.role}`);
  equals(`${prompt}.llm`, "custom-llm");
  equals(`${prompt}.custom_llm.url`, `${options.publicBaseUrl}${CUSTOM_LLM_PATH}`);
  equals(`${prompt}.custom_llm.model_id`, options.expectedModelId);
  check(
    `${prompt}.backup_llm_config.preference`,
    (v) => v === undefined || v === "disabled",
    `"disabled" or absent (no fallback to a hosted LLM)`,
  );
  equals("conversation_config.agent.first_message", "");
  const skipTurn = `${prompt}.built_in_tools.skip_turn`;
  equals(`${skipTurn}.params.system_tool_type`, "skip_turn");
  if (isRecord(valueAt(agent, skipTurn.split(".")))) equals(`${skipTurn}.pre_tool_speech`, "off");
  equals("conversation_config.turn.soft_timeout_config.timeout_seconds", -1);
  equals("conversation_config.turn.turn_eagerness", "patient");
  equals("conversation_config.tts.model_id", "eleven_v3_conversational");
  equals("conversation_config.asr.provider", "scribe_realtime");
  check(
    "conversation_config.conversation.client_events",
    (v) => Array.isArray(v) && v.includes("vad_score"),
    `a list including "vad_score"`,
  );
  check(
    "platform_settings.privacy.retention_days",
    (v) => typeof v === "number" && Number.isInteger(v) && v > 0,
    "a positive number of days",
  );
  equals("platform_settings.overrides.custom_llm_extra_body", true);
  const clientOverride = "platform_settings.overrides.conversation_config_override.agent";
  notTrue(`${clientOverride}.first_message`, "a client could make the agent speak");
  notTrue(`${clientOverride}.prompt.llm`, "a client could replace the custom LLM");
  equals("platform_settings.auth.enable_auth", true);
  return problems;
}

const API_KEY_SUFFIX = ".custom_llm.api_key";

/**
 * Deep-subset comparison of every value we set against what GET returns, to catch keys the API silently dropped or
 * normalised. Objects are compared key by key (extra keys in `actual` are fine); arrays of primitives as sets (order is
 * ignored, missing and extra items are reported); other arrays item by item.
 *
 * `custom_llm.api_key` is skipped when GET returns it absent or null, in case the API withholds secret references
 * (UNVERIFIED); a present but different reference is reported. A missing key there fails closed anyway: our endpoint
 * rejects unauthenticated calls, so the agent stays silent.
 */
export function diffDesiredVsActual(desired: JsonValue, actual: unknown, path = ""): string[] {
  const at = path || "(root)";
  if (path.endsWith(API_KEY_SUFFIX) && (actual === undefined || actual === null)) return [];
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual)) return [`${at}: expected ${show(desired)}, got ${show(actual)}`];
    if (desired.every((item) => item === null || typeof item !== "object")) {
      const wanted: readonly unknown[] = desired;
      const missing = wanted.filter((item) => !actual.includes(item));
      const extra = actual.filter((item) => !wanted.includes(item));
      const problems: string[] = [];
      if (missing.length > 0) problems.push(`${at}: missing ${show(missing)}`);
      if (extra.length > 0) problems.push(`${at}: unexpected ${show(extra)}`);
      return problems;
    }
    if (actual.length !== desired.length) return [`${at}: expected ${desired.length} items, got ${actual.length}`];
    return desired.flatMap((item, i) => diffDesiredVsActual(item, actual[i], `${path}[${i}]`));
  }
  if (desired !== null && typeof desired === "object") {
    if (!isRecord(actual)) return [`${at}: expected an object, got ${show(actual)}`];
    return Object.entries(desired).flatMap(([key, item]) =>
      diffDesiredVsActual(item, actual[key], path ? `${path}.${key}` : key),
    );
  }
  return Object.is(desired, actual) ? [] : [`${at}: expected ${show(desired)}, got ${show(actual)}`];
}
