/**
 * `POST /api/sessions/:sessionId/events`: the CaseDesk DOM channel (plan §7.1). Events are
 * normalised server-side — `critical` from the domain's critical fields, `confidence` 1 (the DOM is
 * read, not inferred) — and appended all-or-nothing as `dom` / `screen.event` entries under the
 * session root. Capture rules: on the record, current privacy epoch, strictly newer frames only.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validateFeatureValue, type NewLedgerEntry, type ScreenEvent, type Value } from "@vashistha/core";
import { KYC_DOMAIN, findKycCase } from "@vashistha/core/domains/kyc";
import { PostEventsRequestSchema, type PostEventsResponseSchema } from "../../contracts/casedesk";
import { ApiFailure, json, readJson, respond } from "./http";
import {
  CASEDESK_SCHEMA_VERSION,
  EDITABLE_FIELDS,
  loadSession,
  requireOnRecord,
  type CaseDeskDeps,
  type CaseDeskSessionInfo,
  type LoadedSession,
} from "./session";

const ACTION_IDS: ReadonlySet<string> = new Set(KYC_DOMAIN.actions.map((a) => a.id));
const CRITICAL_FIELDS: ReadonlySet<string> = new Set(KYC_DOMAIN.criticalFields);

/** Which optional ScreenEvent members each kind carries; any other member is refused, not dropped. */
const ALLOWED_MEMBERS: Record<ScreenEvent["kind"], ReadonlySet<string>> = {
  open_case: new Set(["caseId"]),
  navigate: new Set(["caseId"]),
  field_change: new Set(["caseId", "field", "from", "to"]),
  action: new Set(["caseId", "action"]),
};
const OPTIONAL_MEMBERS = ["caseId", "field", "from", "to", "action"] as const;

const FrameSeqPayloadSchema = z.object({ frameSeq: z.int().nonnegative() });

function invalidEvent(index: number, detail: string): ApiFailure {
  return new ApiFailure(400, "invalid_event", `events[${index}]: ${detail}`);
}

function checkedValue(index: number, field: string, value: Value, member: "from" | "to"): Value {
  const result = validateFeatureValue(KYC_DOMAIN, field, value);
  if (!result.ok) throw invalidEvent(index, `${member}: ${result.message}`);
  return result.value;
}

/** Validates one DOM event against the session and domain and returns it as the server records it. */
function normaliseEvent(event: ScreenEvent, index: number, { info, session }: LoadedSession): ScreenEvent {
  if (event.source !== "dom") throw invalidEvent(index, `source must be "dom" on this channel, got "${event.source}"`);
  if (event.sessionEpoch !== session.privacyEpoch)
    throw new ApiFailure(
      409,
      "stale_epoch",
      `events[${index}]: privacy epoch ${event.sessionEpoch} is stale (current ${session.privacyEpoch})`,
    );
  const allowed = ALLOWED_MEMBERS[event.kind];
  const stray = OPTIONAL_MEMBERS.filter((m) => event[m] !== undefined && !allowed.has(m));
  if (stray.length > 0) throw invalidEvent(index, `${event.kind} must not carry ${stray.join(", ")}`);
  if (event.kind !== "navigate" && event.caseId === undefined) throw invalidEvent(index, `${event.kind} requires caseId`);
  if (event.caseId !== undefined) requireCaseInSet(index, event.caseId, info);

  const normalised: ScreenEvent = {
    id: event.id,
    frameSeq: event.frameSeq,
    captureTime: event.captureTime,
    sessionEpoch: event.sessionEpoch,
    kind: event.kind,
    ...(event.caseId !== undefined && { caseId: event.caseId }),
    confidence: 1,
    source: "dom",
    critical: false,
  };
  if (event.kind === "field_change") {
    const { field, to, from } = event;
    // The ScreenEvent schema guarantees both for field_change.
    if (field === undefined || to === undefined) throw invalidEvent(index, "field_change requires field and to");
    if (!EDITABLE_FIELDS.has(field)) throw invalidEvent(index, `field ${field} is not reviewer-editable`);
    normalised.field = field;
    normalised.to = checkedValue(index, field, to, "to");
    if (from !== undefined) normalised.from = checkedValue(index, field, from, "from");
    normalised.critical = CRITICAL_FIELDS.has(field);
  }
  if (event.kind === "action") {
    if (event.action === undefined || !ACTION_IDS.has(event.action))
      throw invalidEvent(index, `action ${String(event.action)} is not a ${KYC_DOMAIN.id} action`);
    normalised.action = event.action;
  }
  return normalised;
}

function requireCaseInSet(index: number, caseId: string, info: CaseDeskSessionInfo): void {
  if (findKycCase(caseId)?.set !== info.caseSet)
    throw invalidEvent(index, `case ${caseId} is not in this session's ${info.caseSet} set`);
}

/** Highest frameSeq already appended for the session; recovered from the ledger once per process. */
function lastFrameSeq(deps: CaseDeskDeps, sessionId: string): number {
  const known = deps.store.lastFrameSeq.get(sessionId);
  if (known !== undefined) return known;
  const last = deps.ledger.list(sessionId, { sources: ["dom"], kinds: ["screen.event"] }).at(-1);
  const recovered = last === undefined ? -1 : FrameSeqPayloadSchema.parse(last.payload).frameSeq;
  deps.store.lastFrameSeq.set(sessionId, recovered);
  return recovered;
}

/**
 * Frame order: one frame's events arrive together, so within a batch frameSeq never decreases, and
 * every frame in the batch is newer than the last one appended (an older or replayed batch is 409).
 */
function checkFrameOrder(events: readonly ScreenEvent[], last: number): void {
  const ids = new Set<string>();
  events.forEach((event, index) => {
    if (ids.has(event.id)) throw invalidEvent(index, `duplicate event id ${event.id}`);
    ids.add(event.id);
    const previous = events[index - 1];
    if (previous && event.frameSeq < previous.frameSeq) throw invalidEvent(index, "frameSeq decreases within the batch");
  });
  const first = events[0];
  if (first && first.frameSeq <= last)
    throw new ApiFailure(409, "stale_frame", `frameSeq ${first.frameSeq} is not newer than the last applied (${last})`);
}

export function handlePostEvents(request: Request, sessionId: string, deps: CaseDeskDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const { events } = await readJson(request, PostEventsRequestSchema);
    const loaded = loadSession(deps, sessionId);
    const { session, info } = loaded;
    requireOnRecord(session);
    const normalised = events.map((event, index) => normaliseEvent(event, index, loaded));
    checkFrameOrder(normalised, lastFrameSeq(deps, session.id));

    const traceId = randomUUID();
    const entries = normalised.map(
      (event): NewLedgerEntry => ({
        sessionId: session.id,
        source: "dom",
        kind: "screen.event",
        occurredAt: event.captureTime,
        traceId,
        parentIds: [info.startedEntryId],
        schemaVersion: CASEDESK_SCHEMA_VERSION,
        privacyEpoch: event.sessionEpoch,
        payload: event,
      }),
    );
    // The ledger re-checks epoch and off-record atomically, so a concurrent transition still wins (409).
    const appended = deps.ledger.appendMany(entries);
    const lastEvent = normalised.at(-1);
    if (lastEvent) deps.store.lastFrameSeq.set(session.id, lastEvent.frameSeq);
    const body: z.infer<typeof PostEventsResponseSchema> = { ledgerIds: appended.map((entry) => entry.id) };
    return json(body);
  });
}
