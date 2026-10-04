import { z } from "zod";
import { UsernameSchema } from "../schemas/account";

const ENV_KEYS = [
  "NODE_ENV",
  "PORT",
  "PUBLIC_BASE_URL",
  "DATA_DIR",
  "ANTHROPIC_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_INTERVIEWER_AGENT_ID",
  "ELEVENLABS_TUTOR_AGENT_ID",
  "CUSTOM_LLM_SECRET",
  "MCP_BEARER_TOKEN",
  "LLM_CALLS",
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_ENDPOINT",
  "R2_MAX_BYTES",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];

const R2_REQUIRED = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;
const PRODUCTION_REQUIRED = ["ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "CUSTOM_LLM_SECRET"] as const;

/** Fixed hints for error messages; never derived from the offending value. */
const HINTS: Record<EnvKey, string> = {
  NODE_ENV: "development, test or production",
  PORT: "integer 1-65535",
  PUBLIC_BASE_URL: "http(s) URL without query or fragment; https in production",
  DATA_DIR: "directory for the database and media",
  ANTHROPIC_API_KEY: "required in production",
  ELEVENLABS_API_KEY: "required in production",
  ELEVENLABS_INTERVIEWER_AGENT_ID: "written by the agent-sync script",
  ELEVENLABS_TUTOR_AGENT_ID: "written by the agent-sync script",
  CUSTOM_LLM_SECRET: "at least 32 characters; required in production",
  MCP_BEARER_TOKEN: "at least 32 characters; /mcp refuses every request in production while unset",
  LLM_CALLS: "on or off",
  ADMIN_USERNAME: "a username (lowercase letters, digits and hyphens); set together with ADMIN_PASSWORD",
  ADMIN_PASSWORD: "at least 12 characters; set together with ADMIN_USERNAME",
  R2_ACCOUNT_ID: "Cloudflare account id; set together with the other R2_ variables",
  R2_ACCESS_KEY_ID: "R2 API token access key id; set together with the other R2_ variables",
  R2_SECRET_ACCESS_KEY: "R2 API token secret; set together with the other R2_ variables",
  R2_BUCKET: "R2 bucket name; set together with the other R2_ variables",
  R2_ENDPOINT: "https URL overriding https://<account>.r2.cloudflarestorage.com (tests only)",
  R2_MAX_BYTES: "integer byte cap for stored frames (default 2000000000); at the cap the oldest half is deleted",
};

const optional = z.string().optional();

/** Origin plus path, without a trailing slash. */
const BaseUrlSchema = z
  .url({ protocol: /^https?$/, normalize: true })
  .transform((value) => new URL(value))
  .refine((url) => url.search === "" && url.hash === "" && url.username === "" && url.password === "")
  .transform((url) => `${url.origin}${url.pathname.replace(/\/+$/, "")}`);

const ServerEnvSchema = z.strictObject({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.int().min(1).max(65535))
    .default(3000),
  PUBLIC_BASE_URL: BaseUrlSchema,
  DATA_DIR: z.string(),
  ANTHROPIC_API_KEY: optional,
  ELEVENLABS_API_KEY: optional,
  ELEVENLABS_INTERVIEWER_AGENT_ID: optional,
  ELEVENLABS_TUTOR_AGENT_ID: optional,
  /** Bearer secret ElevenLabs sends to our custom-LLM endpoint. */
  CUSTOM_LLM_SECRET: z.string().min(32).optional(),
  /** Bearer token MCP clients send to `/mcp` (plan §7.9). Unset: open in development, refused in production. */
  MCP_BEARER_TOKEN: z.string().min(32).optional(),
  /**
   * Hermetic switch: `off` makes `runtime.claude` null for every consumer (interview, debrief, perception), so
   * the process makes no model call even with ANTHROPIC_API_KEY set (e2e). Preflight fails a target that reports it off.
   */
  LLM_CALLS: z.enum(["on", "off"]).default("on"),
  /**
   * The first admin (accounts): created at boot when no account has this username, never overwritten
   * afterwards. Everyone else signs up as a trainee; this admin grants the expert role.
   */
  ADMIN_USERNAME: UsernameSchema.optional(),
  ADMIN_PASSWORD: z.string().min(12).max(200).optional(),
  /**
   * Cloudflare R2 for redacted screen frames (they would otherwise fill the volume). All four set: frames go to the
   * bucket; none set: frames stay on the volume under DATA_DIR/media. Never log these.
   */
  R2_ACCOUNT_ID: z.string().regex(/^[0-9a-f]{32}$/i).optional(),
  R2_ACCESS_KEY_ID: z.string().min(8).max(128).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(16).max(256).optional(),
  R2_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/).optional(),
  R2_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  /** Frames in the bucket never exceed this many bytes for long: at the cap the oldest half is deleted. 2 GB by default. */
  R2_MAX_BYTES: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(1_000_000)).default(2_000_000_000),
});
export type ServerEnv = z.infer<typeof ServerEnvSchema>;

/** Variables that may be absent at load time; features that need them call `requireEnv`. */
export type OptionalEnvKey = {
  [K in keyof ServerEnv]-?: undefined extends ServerEnv[K] ? K : never;
}[keyof ServerEnv];

export class EnvError extends Error {
  override readonly name: string = "EnvError";
  /** Names of the offending variables. */
  readonly variables: readonly string[];

  constructor(message: string, variables: readonly string[]) {
    super(message);
    this.variables = variables;
  }
}

/** Picks the known variables, trimming values and treating empty strings as unset. */
function normalise(source: Readonly<Record<string, string | undefined>>): Partial<Record<EnvKey, string>> {
  const out: Partial<Record<EnvKey, string>> = {};
  for (const key of ENV_KEYS) {
    const value = source[key]?.trim();
    if (value) out[key] = value;
  }
  return out;
}

/** Validates the server environment. Error messages name variables but never echo their values. */
export function loadServerEnv(source: Readonly<Record<string, string | undefined>> = process.env): ServerEnv {
  const input = normalise(source);
  const result = ServerEnvSchema.safeParse(input);
  const invalid = new Set<EnvKey>();
  for (const issue of result.error?.issues ?? []) {
    const key = ENV_KEYS.find((k) => k === issue.path[0]);
    if (key) invalid.add(key);
  }
  // Checked here rather than in a refinement so they are reported alongside every other issue.
  if (input.NODE_ENV === "production") {
    for (const key of PRODUCTION_REQUIRED) if (input[key] === undefined) invalid.add(key);
    if (input.PUBLIC_BASE_URL !== undefined && !/^https:\/\//i.test(input.PUBLIC_BASE_URL)) invalid.add("PUBLIC_BASE_URL");
  }
  // One without the other would silently create no admin.
  if ((input.ADMIN_USERNAME === undefined) !== (input.ADMIN_PASSWORD === undefined)) {
    invalid.add(input.ADMIN_USERNAME === undefined ? "ADMIN_USERNAME" : "ADMIN_PASSWORD");
  }
  // A partial R2 configuration would silently keep frames on the volume.
  const r2 = R2_REQUIRED.filter((key) => input[key] !== undefined);
  if (r2.length > 0 && r2.length < R2_REQUIRED.length) for (const key of R2_REQUIRED) if (input[key] === undefined) invalid.add(key);
  if (result.success && invalid.size === 0) return result.data;

  const names = ENV_KEYS.filter((key) => invalid.has(key));
  const lines = names.map((name) => `  ${name}: ${input[name] === undefined ? "missing" : "invalid"} (${HINTS[name]})`);
  throw new EnvError(`Invalid server environment:\n${lines.join("\n")}`, names);
}

/** Returns an optional variable, or throws naming it when a feature that needs it runs without it. */
export function requireEnv<K extends OptionalEnvKey>(env: ServerEnv, name: K): NonNullable<ServerEnv[K]> {
  const value = env[name];
  if (value === undefined) throw new EnvError(`${name} is not set but is required for this feature (${HINTS[name]})`, [name]);
  return value;
}
