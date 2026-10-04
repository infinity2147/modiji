/**
 * HTTP plumbing shared by the CaseDesk handlers: bounded JSON body parsing with zod, and one place
 * that turns failures into `ApiErrorSchema` bodies. Ledger errors are recognised structurally — a
 * value import of `LedgerError` would pull `@vashistha/core/server` (SQLite, Drizzle) into the route
 * bundle (see runtime.ts). Responses never carry stack traces or messages of unexpected errors.
 */
import { z } from "zod";
import type { LedgerErrorCode } from "@vashistha/core/server";
import type { ApiErrorSchema } from "../../contracts/casedesk";

/** Generous for 50 screen events; anything larger is not a CaseDesk request. */
const MAX_BODY_BYTES = 64 * 1024;

export const NO_STORE = { "Cache-Control": "no-store" } as const;

type ApiError = z.infer<typeof ApiErrorSchema>;

/** An expected refusal: becomes `{ error, detail }` with `status`. */
export class ApiFailure extends Error {
  override readonly name: string = "ApiFailure";
  readonly status: number;
  readonly error: string;
  readonly detail: string | undefined;

  constructor(status: number, error: string, detail?: string) {
    super(detail === undefined ? error : `${error}: ${detail}`);
    this.status = status;
    this.error = error;
    this.detail = detail;
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function errorResponse(status: number, error: string, detail?: string): Response {
  const body: ApiError = detail === undefined ? { error } : { error, detail };
  return json(body, status);
}

const LEDGER_ERROR_NAMES = new Set(["LedgerError", "StaleEpochError", "OffRecordError", "SessionArchivedError"]);

/** HTTP status per ledger error code; codes absent here indicate a server bug and become 500. */
const LEDGER_STATUS: Partial<Record<LedgerErrorCode, number>> = {
  session_not_found: 404,
  stale_epoch: 409,
  off_record: 409,
  session_archived: 409,
  invalid_entry: 400,
};

function ledgerErrorCode(error: unknown): LedgerErrorCode | undefined {
  if (!(error instanceof Error) || !LEDGER_ERROR_NAMES.has(error.name) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? (error.code as LedgerErrorCode) : undefined;
}

/** Maps a thrown value to a response: `ApiFailure` as given, ledger errors by code, anything else 500. */
export function toErrorResponse(error: unknown, log: Pick<Console, "error">): Response {
  if (error instanceof ApiFailure) return errorResponse(error.status, error.error, error.detail);
  const code = ledgerErrorCode(error);
  const status = code === undefined ? undefined : LEDGER_STATUS[code];
  if (code !== undefined && status !== undefined && error instanceof Error) return errorResponse(status, code, error.message);
  log.error(`[casedesk] unexpected ${error instanceof Error ? `${error.name}: ${error.message}` : "non-Error thrown"}`);
  return errorResponse(500, "internal_error");
}

/** Runs a handler body, mapping any failure to an error response. */
export async function respond(log: Pick<Console, "error">, run: () => Response | Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    return toErrorResponse(error, log);
  }
}

/** Reads a JSON body of at most MAX_BODY_BYTES and validates it: 413, then 400 `invalid_json` / `invalid_request`. */
export async function readJson<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new ApiFailure(413, "payload_too_large", `body exceeds ${MAX_BODY_BYTES} bytes`);
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES)
    throw new ApiFailure(413, "payload_too_large", `body exceeds ${MAX_BODY_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiFailure(400, "invalid_json", "request body is not valid JSON");
  }
  return parseOr400(schema, raw, "invalid_request");
}

/** Validates `input`, throwing a 400 with `error` and zod's readable issue list. */
export function parseOr400<S extends z.ZodType>(schema: S, input: unknown, error: string): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiFailure(400, error, z.prettifyError(parsed.error));
  return parsed.data;
}
