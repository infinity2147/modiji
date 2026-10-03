import { z } from "zod";

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
] as const;
type EnvKey = (typeof ENV_KEYS)[number];

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
