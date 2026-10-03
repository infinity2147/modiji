/**
 * Typed client for the CaseDesk HTTP contract (`lib/contracts/casedesk.ts`). Every response body is
 * validated with the contract's zod schemas before the UI sees it; anything else becomes an
 * `ApiError` the UI can show and recover from.
 */
import type { z } from "zod";
import {
  ApiErrorSchema,
  CommitDecisionResponseSchema,
  CreateSessionResponseSchema,
  InterlockCheckResponseSchema,
  ListCasesResponseSchema,
  PostEventsResponseSchema,
  type CommitDecisionRequestSchema,
  type CreateSessionRequestSchema,
  type InterlockCheckRequestSchema,
  type PostEventsRequestSchema,
} from "../contracts/casedesk";
import { LedgerPageResponseSchema } from "../contracts/ledger";
import type { CaseSet } from "@vashistha/core/domains/kyc";

export type CommitDecisionResponse = z.infer<typeof CommitDecisionResponseSchema>;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Why a request failed: the server refused it (`http`), it never got an answer (`network`), or the answer broke the contract (`invalid_response`). */
export type ApiErrorKind = "http" | "network" | "invalid_response";

export class ApiError extends Error {
  override readonly name: string = "ApiError";
  readonly kind: ApiErrorKind;
  /** HTTP status; 0 when no response arrived. */
  readonly status: number;
  /** Machine-readable error code from the server's `ApiErrorSchema` body, or a client-side code. */
  readonly code: string;
  readonly detail: string | undefined;

  constructor(kind: ApiErrorKind, status: number, code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** A short, human-readable account of a failure for alerts. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === "network") return "The server could not be reached. Check the connection and try again.";
    if (error.kind === "invalid_response") return `The server sent an unexpected response (${error.code}).`;
    const detail = error.detail === undefined ? "" : ` — ${error.detail}`;
    return `Request refused (${error.status} ${error.code})${detail}`;
  }
  return error instanceof Error ? error.message : "Unexpected error";
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError("invalid_response", response.status, "invalid_json", "response body is not JSON");
  }
}

export type RawResponse = { status: number; ok: boolean; body: unknown };

/** Sends a request; a transport failure becomes a `network` ApiError. Bodies are parsed but not validated. */
export async function send(fetchFn: FetchFn, url: string, init: RequestInit): Promise<RawResponse> {
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, headers: { Accept: "application/json", ...init.headers }, cache: "no-store" });
  } catch (error) {
    throw new ApiError("network", 0, "network_error", error instanceof Error ? error.message : undefined);
  }
  return { status: response.status, ok: response.ok, body: await readBody(response) };
}

export function refusal({ status, body }: RawResponse): ApiError {
  const parsed = ApiErrorSchema.safeParse(body);
  if (parsed.success) return new ApiError("http", status, parsed.data.error, parsed.data.detail);
  return new ApiError("http", status, `http_${status}`);
}

export function validated<S extends z.ZodType>(schema: S, raw: RawResponse): z.infer<S> {
  const parsed = schema.safeParse(raw.body);
  if (!parsed.success) throw new ApiError("invalid_response", raw.status, "schema_mismatch", parsed.error.issues[0]?.message);
  return parsed.data;
}

/** Sends a request and validates the success body with `schema`; non-2xx bodies are read as `ApiErrorSchema`. */
export async function requestJson<S extends z.ZodType>(
  fetchFn: FetchFn,
  url: string,
  schema: S,
  init: RequestInit = {},
): Promise<z.infer<S>> {
  const raw = await send(fetchFn, url, init);
  if (!raw.ok) throw refusal(raw);
  return validated(schema, raw);
}

export function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function createSession(fetchFn: FetchFn, body: z.input<typeof CreateSessionRequestSchema>) {
  return requestJson(fetchFn, "/api/sessions", CreateSessionResponseSchema, postJson(body));
}

/** The set's cases; with `sessionId`, followed by the cases generated for that session (tutor practice, judge-entered). */
export function listCases(fetchFn: FetchFn, set: CaseSet, sessionId?: string) {
  const query = new URLSearchParams({ set });
  if (sessionId !== undefined) query.set("session", sessionId);
  return requestJson(fetchFn, `/api/cases?${query.toString()}`, ListCasesResponseSchema);
}

export function postEvents(fetchFn: FetchFn, sessionId: string, body: z.input<typeof PostEventsRequestSchema>) {
  return requestJson(fetchFn, `/api/sessions/${encodeURIComponent(sessionId)}/events`, PostEventsResponseSchema, postJson(body));
}

export function checkInterlock(fetchFn: FetchFn, body: z.input<typeof InterlockCheckRequestSchema>) {
  return requestJson(fetchFn, "/api/interlock/check", InterlockCheckResponseSchema, postJson(body));
}

/**
 * Commits a review outcome. The server re-runs the interlock; when it refuses (rulebook changed since
 * the check) it answers 409 with a `{ status: "blocked" }` body, which is returned, not thrown.
 */
export async function commitDecision(
  fetchFn: FetchFn,
  sessionId: string,
  body: z.input<typeof CommitDecisionRequestSchema>,
): Promise<CommitDecisionResponse> {
  const raw = await send(fetchFn, `/api/sessions/${encodeURIComponent(sessionId)}/decisions`, postJson(body));
  if (raw.ok) return validated(CommitDecisionResponseSchema, raw);
  const blocked = CommitDecisionResponseSchema.safeParse(raw.body);
  if (raw.status === 409 && blocked.success && blocked.data.status === "blocked") return blocked.data;
  throw refusal(raw);
}

export function fetchLedgerPage(fetchFn: FetchFn, sessionId: string, after: number | undefined, limit: number) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (after !== undefined) query.set("after", String(after));
  return requestJson(fetchFn, `/api/sessions/${encodeURIComponent(sessionId)}/ledger?${query.toString()}`, LedgerPageResponseSchema);
}
