/**
 * The public HTTP API of the server under test, as the live Hindi run uses it — the same routes the
 * browser calls (sessions, DOM events, interlock + decision, frames, question queue, gate authorize,
 * utterances, ledger) plus `/mcp` `check_action` and the tutor view. Responses are checked for only the
 * fields the run reads (`Reader`; scripts/ has no zod), so it reports precisely what a server (possibly
 * an older deployment) lacks instead of failing on unrelated fields.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

export class TargetError extends Error {
  override readonly name: string = "TargetError";
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Checks one response field and names it when it is missing or of the wrong type. */
type Reader<T> = (body: unknown) => T;

function field<T>(body: unknown, key: string, ok: (v: unknown) => v is T, what: string): T {
  const value = isRecord(body) ? body[key] : undefined;
  if (!ok(value)) throw new Error(`${key}: expected ${what}`);
  return value;
}
const isString = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isArray = (v: unknown): v is unknown[] => Array.isArray(v);
const isObject = (v: unknown): v is Json => isRecord(v);
const optional = <T>(body: unknown, key: string, ok: (v: unknown) => v is T): T | undefined => {
  const value = isRecord(body) ? body[key] : undefined;
  return ok(value) ? value : undefined;
};

export type QueuedQuestion = { id: string; kind: string; text: string; textEnglish?: string; language?: string };
export type LedgerItem = { id: string; kind: string; source: string; parentIds: string[]; payload: unknown };

export type TargetApi = ReturnType<typeof createTargetApi>;

export function createTargetApi(options: { baseUrl: string; fetch?: typeof globalThis.fetch; mcpBearer?: string; timeoutMs?: number }) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;

  async function call<T>(method: "GET" | "POST", path: string, read: Reader<T>, body?: unknown, init: { form?: FormData; headers?: Record<string, string> } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...init.headers };
    let payload: FormData | string | undefined;
    if (init.form !== undefined) payload = init.form;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl}${path}`, { method, headers, ...(payload !== undefined && { body: payload }), signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new TargetError(`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`, null, null);
    }
    const text = await response.text();
    if (!response.ok) {
      const error = safeJson(text);
      const code = optional(error, "error", isString) ?? null;
      const detail = code === null ? text.slice(0, 200) : `${code}${optional(error, "detail", isString) === undefined ? "" : `: ${String(optional(error, "detail", isString))}`}`;
      throw new TargetError(`${method} ${path} → HTTP ${response.status} ${detail}`, response.status, code);
    }
    const json = response.headers.get("content-type")?.includes("text/event-stream") ? lastSseData(text) : safeJson(text);
    try {
      return read(json);
    } catch (error) {
      throw new TargetError(`${method} ${path}: unexpected response (${error instanceof Error ? error.message : String(error)})`, response.status, null);
    }
  }

  return {
    health: () => call("GET", "/api/health", (b) => field(b, "ok", (v): v is true => v === true, "ok: true")),

    createSession: (expert: { name: string; language: "en" | "hi" } | undefined, mode: "expert" | "novice" = "expert") =>
      call(
        "POST",
        "/api/sessions",
        (b) => ({ sessionId: field(b, "sessionId", isString, "an id"), privacyEpoch: field(b, "privacyEpoch", isInt, "an epoch"), expert: optional(b, "expert", isObject) }),
        { mode, caseSet: "training", ...(expert !== undefined && { expert }) },
      ),

    /** Opens the case and sets the risk rating on the DOM channel (what the CaseDesk UI posts). */
    async openCase(sessionId: string, caseId: string, epoch: number, riskRating: string): Promise<void> {
      const event = (frameSeq: number, over: Record<string, unknown>) => ({
        id: randomUUID(),
        frameSeq,
        captureTime: Date.now(),
        sessionEpoch: epoch,
        caseId,
        confidence: 1,
        source: "dom",
        critical: false,
        ...over,
      });
      const ok: Reader<unknown[]> = (b) => field(b, "ledgerIds", isArray, "ledger ids");
      await call("POST", `/api/sessions/${sessionId}/events`, ok, { events: [event(1, { kind: "open_case" })] });
      await call("POST", `/api/sessions/${sessionId}/events`, ok, {
        events: [event(2, { kind: "field_change", field: "riskRating", from: "unrated", to: riskRating })],
      });
    },

    /** Interlock check, then commit (what the Save button does). */
    async decide(sessionId: string, caseId: string, action: string, riskRating: string) {
      const edits = { riskRating };
      const check = await call("POST", "/api/interlock/check", (b) => ({ checkId: field(b, "checkId", isString, "a check id") }), {
        sessionId,
        caseId,
        edits,
        proposedAction: action,
      });
      return call("POST", `/api/sessions/${sessionId}/decisions`, (b) => ({ status: field(b, "status", isString, "a status") }), {
        caseId,
        edits,
        action,
        checkId: check.checkId,
      });
    },

    /** Uploads a PNG as a redacted screen frame (its own size as the source; no crop). */
    async uploadFrame(sessionId: string, png: { path: string; width: number; height: number }, epoch: number, frameSeq: number) {
      const form = new FormData();
      form.set(
        "metadata",
        JSON.stringify({
          frameSeq,
          captureTime: Date.now(),
          privacyEpoch: epoch,
          changeScore: 40,
          redactedRegions: 0,
          source: { width: png.width, height: png.height },
          bbox: null,
          crop: null,
        }),
      );
      form.set("frame", new Blob([new Uint8Array(await readFile(png.path))], { type: "image/png" }), "frame.png");
      return call("POST", `/api/sessions/${sessionId}/frames`, (b) => ({ ledgerId: field(b, "ledgerId", isString, "a ledger id") }), undefined, { form });
    },

    questions: (sessionId: string) =>
      call(
        "GET",
        `/api/sessions/${sessionId}/questions`,
        (b) => ({
          queue: field(b, "queue", isArray, "a queue").map((q): QueuedQuestion => {
            const textEnglish = optional(q, "textEnglish", isString);
            const language = optional(q, "language", isString);
            return {
              id: field(q, "id", isString, "a question id"),
              kind: field(q, "kind", isString, "a kind"),
              text: field(q, "text", isString, "a text"),
              ...(textEnglish !== undefined && { textEnglish }),
              ...(language !== undefined && { language }),
            };
          }),
          contextVersion: field(b, "contextVersion", isInt, "a context version"),
        }),
      ),

    authorize: (sessionId: string, questionId: string, contextVersion: number) =>
      call("POST", `/api/sessions/${sessionId}/gate/authorize`, (b) => ({ controlMessage: field(b, "controlMessage", isString, "a control message"), text: field(b, "text", isString, "a text") }), {
        questionId,
        contextVersion,
        becameValidAt: Date.now() - 1500,
        decidedAt: Date.now() - 50,
        conditions: { userSilent: true, screenIdle: true, typingIdle: true, atBreakpoint: true, valueAboveTheta: true, budget: true },
      }),

    postUtterance: (sessionId: string, body: Record<string, unknown>) =>
      call(
        "POST",
        `/api/sessions/${sessionId}/utterances`,
        (b) => {
          const parsed = optional(b, "parsed", isObject);
          return {
            utteranceId: field(b, "utteranceId", isString, "an utterance id"),
            language: optional(b, "language", isString),
            translation: optional(b, "translation", isObject),
            statedQuotes: parsed === undefined ? undefined : field(parsed, "statedRules", isArray, "stated rules").map((r) => field(r, "exactQuote", isString, "a quote")),
          };
        },
        body,
      ),

    ledger: (sessionId: string) =>
      call(
        "GET",
        `/api/sessions/${sessionId}/ledger?limit=500`,
        (b) =>
          field(b, "entries", isArray, "entries").map(
            (e): LedgerItem => ({
              id: field(e, "id", isString, "an id"),
              kind: field(e, "kind", isString, "a kind"),
              source: field(e, "source", isString, "a source"),
              parentIds: field(e, "parentIds", isArray, "parent ids").filter(isString),
              payload: isRecord(e) ? e.payload : undefined,
            }),
          ),
      ),

    tutor: (sessionId: string) => call("GET", `/api/sessions/${sessionId}/tutor`, (b) => field(b, "rules", isArray, "rules").filter(isObject)),

    /** `/mcp` tools/call check_action (JSON-RPC over streamable HTTP). */
    checkAction: (context: Record<string, unknown>, proposedAction: string) =>
      call(
        "POST",
        "/mcp",
        (b) => {
          const content = field(field(b, "result", isObject, "a JSON-RPC result"), "structuredContent", isObject, "structured content");
          return { decision: field(content, "decision", isString, "a decision"), explanation: field(content, "explanation", isString, "an explanation"), content };
        },
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_action", arguments: { context: { case: context }, proposedAction } } },
        { headers: { accept: "application/json, text/event-stream", ...(options.mcpBearer !== undefined && { authorization: `Bearer ${options.mcpBearer}` }) } },
      ),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function lastSseData(text: string): unknown {
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
  return data.length === 0 ? undefined : safeJson(data[data.length - 1] ?? "");
}
