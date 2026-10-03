import { z } from "zod";

/**
 * Typed raw-REST client for the ElevenLabs endpoints we use. Not `@elevenlabs/elevenlabs-js`: its enums lag the API
 * and it silently strips unknown keys (docs/api-notes.md §3).
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Body of `POST /v1/convai/agents/create` and `PATCH /v1/convai/agents/{id}` (snake_case wire format). */
export type AgentRequestBody = { name: string; conversation_config: JsonObject; platform_settings: JsonObject };

/** `GET /v1/convai/agents/{id}`: only `agent_id` is checked here; the rest is checked by `checkAgentInvariants`. */
export type ElevenLabsAgent = { agent_id: string; [key: string]: unknown };

export type WorkspaceSecret = { secretId: string; name: string };
export type ElevenLabsVoice = { voiceId: string; name: string | null; category: string | null };

export type ElevenLabsErrorKind = "http" | "network" | "timeout" | "invalid_response";

/** Every failure of the client. The message and `detail` never contain the API key or values passed for redaction. */
export class ElevenLabsApiError extends Error {
  override readonly name: string = "ElevenLabsApiError";
  readonly kind: ElevenLabsErrorKind;
  /** HTTP status, or null when no response was received. */
  readonly status: number | null;
  readonly method: string;
  /** Path plus query string (agent ids are not secrets). */
  readonly path: string;
  /** Redacted response body (http) or cause (other kinds), at most ~500 characters. */
  readonly detail: string;

  constructor(init: { kind: ElevenLabsErrorKind; status: number | null; method: string; path: string; detail: string }) {
    const what = init.kind === "http" ? `HTTP ${init.status}` : init.kind.replace("_", " ");
    super(`ElevenLabs ${init.method} ${init.path} failed (${what}): ${init.detail}`);
    this.kind = init.kind;
    this.status = init.status;
    this.method = init.method;
    this.path = init.path;
    this.detail = init.detail;
  }
}

export type ElevenLabsClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Per request, covering the response body. */
  timeoutMs?: number;
};

export type ElevenLabsClient = {
  /** WebRTC conversation token for a (private) agent; the conversation id is known before the client connects. */
  getConversationToken(agentId: string): Promise<{ token: string; conversationId: string }>;
  /** Signed WebSocket URL (`wss://…`), valid for 15 minutes. */
  getSignedUrl(agentId: string): Promise<string>;
  getAgent(agentId: string): Promise<ElevenLabsAgent>;
  createAgent(body: AgentRequestBody): Promise<{ agentId: string }>;
  updateAgent(agentId: string, body: AgentRequestBody & { version_description?: string }): Promise<void>;
  /** Workspace secrets, following pagination. `search` filters by name prefix server-side. */
  listSecrets(options?: { search?: string }): Promise<WorkspaceSecret[]>;
  createSecret(name: string, value: string): Promise<{ secretId: string }>;
  /** Throws `ElevenLabsApiError` (HTTP 4xx) when the voice does not exist or is not available to the account. */
  getVoice(voiceId: string): Promise<ElevenLabsVoice>;
};

const DETAIL_LIMIT = 500;

const TokenResponseSchema = z.object({ token: z.string().min(1), conversation_id: z.string().min(1) });
const SignedUrlResponseSchema = z.object({ signed_url: z.url({ protocol: /^wss$/ }) });
const AgentResponseSchema = z.looseObject({ agent_id: z.string().min(1) });
const CreateAgentResponseSchema = z.object({ agent_id: z.string().min(1) });
const SecretSchema = z.object({ secret_id: z.string().min(1), name: z.string() });
const ListSecretsResponseSchema = z.object({ secrets: z.array(SecretSchema), next_cursor: z.string().min(1).nullish() });
const VoiceResponseSchema = z.object({
  voice_id: z.string().min(1),
  name: z.string().nullish(),
  category: z.string().nullish(),
});

/** Replaces every occurrence of each secret (raw and JSON-escaped) and truncates. */
function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === "") continue;
    out = out.replaceAll(secret, "[redacted]").replaceAll(JSON.stringify(secret).slice(1, -1), "[redacted]");
  }
  return out.length > DETAIL_LIMIT ? `${out.slice(0, DETAIL_LIMIT)}…` : out;
}

function causeMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
  return `${err.message}${cause}`;
}

export function createElevenLabsClient(options: ElevenLabsClientOptions): ElevenLabsClient {
  const { apiKey, baseUrl = "https://api.elevenlabs.io", fetch: fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = options;
  if (apiKey.trim() === "") throw new Error("ElevenLabs API key is empty");

  async function request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    schema: z.ZodType<T>,
    extra: { query?: Readonly<Record<string, string>>; body?: unknown; redact?: readonly string[] } = {},
  ): Promise<T> {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(extra.query ?? {})) url.searchParams.set(key, value);
    const shownPath = `${url.pathname}${url.search}`;
    const secrets = [apiKey, ...(extra.redact ?? [])];
    const fail = (kind: ElevenLabsErrorKind, status: number | null, detail: string): ElevenLabsApiError =>
      new ElevenLabsApiError({ kind, status, method, path: shownPath, detail: redact(detail, secrets) });

    const signal = AbortSignal.timeout(timeoutMs);
    const headers: Record<string, string> = { "xi-api-key": apiKey, accept: "application/json" };
    const init: RequestInit = { method, headers, signal };
    if (extra.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(extra.body);
    }

    let status: number | null = null;
    let text: string;
    let ok: boolean;
    try {
      const response = await fetchImpl(url, init);
      status = response.status;
      ok = response.ok;
      text = await response.text();
    } catch (err) {
      if (signal.aborted) throw fail("timeout", status, `no complete response within ${timeoutMs} ms`);
      throw fail("network", status, causeMessage(err));
    }
    if (!ok) throw fail("http", status, text);

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw fail("invalid_response", status, "response body is not JSON");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // Issue paths and messages only: response bodies (tokens, signed URLs) are never echoed.
      const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      throw fail("invalid_response", status, issues.join("; "));
    }
    return parsed.data;
  }

  const agentPath = (agentId: string) => `/v1/convai/agents/${encodeURIComponent(agentId)}`;

  return {
    async getConversationToken(agentId) {
      const r = await request("GET", "/v1/convai/conversation/token", TokenResponseSchema, { query: { agent_id: agentId } });
      return { token: r.token, conversationId: r.conversation_id };
    },

    async getSignedUrl(agentId) {
      const r = await request("GET", "/v1/convai/conversation/get-signed-url", SignedUrlResponseSchema, {
        query: { agent_id: agentId },
      });
      return r.signed_url;
    },

    getAgent: (agentId) => request("GET", agentPath(agentId), AgentResponseSchema),

    async createAgent(body) {
      const r = await request("POST", "/v1/convai/agents/create", CreateAgentResponseSchema, { body });
      return { agentId: r.agent_id };
    },

    async updateAgent(agentId, body) {
      await request("PATCH", agentPath(agentId), AgentResponseSchema, { body });
    },

    async listSecrets({ search } = {}) {
      const secrets: WorkspaceSecret[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const query: Record<string, string> = {};
        if (search !== undefined) query.search = search;
        if (cursor !== undefined) query.cursor = cursor;
        const page = await request("GET", "/v1/convai/secrets", ListSecretsResponseSchema, { query });
        for (const s of page.secrets) secrets.push({ secretId: s.secret_id, name: s.name });
        cursor = page.next_cursor ?? undefined;
        if (cursor !== undefined) {
          if (seen.has(cursor)) {
            throw new ElevenLabsApiError({
              kind: "invalid_response",
              status: 200,
              method: "GET",
              path: "/v1/convai/secrets",
              detail: "pagination cursor repeated",
            });
          }
          seen.add(cursor);
        }
      } while (cursor !== undefined);
      return secrets;
    },

    async createSecret(name, value) {
      // A 422 validation error may echo the request body, so the value is redacted from errors too.
      const r = await request("POST", "/v1/convai/secrets", SecretSchema, {
        body: { type: "new", name, value },
        redact: [value],
      });
      return { secretId: r.secret_id };
    },

    async getVoice(voiceId) {
      const r = await request("GET", `/v1/voices/${encodeURIComponent(voiceId)}`, VoiceResponseSchema);
      return { voiceId: r.voice_id, name: r.name ?? null, category: r.category ?? null };
    },
  };
}
