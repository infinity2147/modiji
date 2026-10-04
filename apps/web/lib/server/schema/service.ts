/**
 * Schema versioning for one expert session (plan §6.6). Models propose concepts; the EXPERT confirms
 * (their definition, their words) or dismisses them; code versions the feature model and recomputes:
 *
 *   confirm → `concept.confirmed` (expert or voice; parents: the proposals [+ the utterance quoted])
 *           → `schema.version_bumped` (engine; parent: the confirmation)
 *           → backfill, in the background and per session in order: for every observed decision, the
 *             concept is re-read from the case's stored redacted frames (vision re-read, Haiku) →
 *             `feature.backfilled` (engine; parents: bump, decision, frames read) with the value, or
 *             `Unknown{backfill_failed}` and why. Nothing is invented: no model, no frames, "not
 *             visible" or an invalid reading all stay unknown.
 *           → `hypotheses.updated` per decided family (parents: the backfills): the engine state is
 *             rebuilt under the new model (engine-state.ts), the debrief solver reruns on the new
 *             domain (its cache is keyed by schema version).
 *   dismiss → `concept.dismissed` ("not a real concept" / "already covered by <feature>").
 *
 * Decisions committed after a confirmation get the same re-read (`timing: "new_case"`) through the
 * CaseDesk decision hook (`withSchemaBackfill`). The hidden oracle is never involved.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import {
  BASE_SCHEMA_VERSION,
  ConceptDefinitionSchema,
  containsQuote,
  featureModel,
  observedDecisions,
  parseLedgerPayload,
  pendingBackfills,
  type ExpertWords,
  type LedgerSource,
  type ObservedDecision,
  type SessionSchema,
} from "@vashistha/core";
import { KYC_DOMAIN, caseFeatures, findKycCase } from "@vashistha/core/domains/kyc";
import type { z } from "zod";
import { ReviewEditsSchema } from "../../contracts/casedesk";
import type { ConceptActionRequest, ConceptActionResponseSchema, ConceptsState, ExpertWordsInputSchema } from "../../contracts/concepts";
import { ApiFailure } from "../casedesk/http";
import { CASEDESK_SCHEMA_VERSION, loadSession, requireNotArchived, type InterviewHooks, type LoadedSession } from "../casedesk/session";
import { engineState, topCandidates } from "../interview/engine-state";
import { entry, type EntryContext } from "../interview/ledger";
import type { RereadFrame, RereadResult, SchemaDeps, SchemaStore } from "./deps";
import { sessionSchema } from "./session-schema";

type ActionResponse = z.infer<typeof ConceptActionResponseSchema>;

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 404 unless a CaseDesk session; 409 unless an expert capture session (concepts belong to the expert's model). */
function loadExpert(deps: SchemaDeps, sessionId: string): LoadedSession {
  const loaded = loadSession({ ledger: deps.ledger, store: deps.casedesk }, sessionId);
  if (loaded.info.mode !== "expert") throw new ApiFailure(409, "not_expert_session", "concepts are confirmed in an expert capture session");
  return loaded;
}

function kycFeatures(caseId: string, edits: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> | undefined {
  const found = findKycCase(caseId);
  const parsed = ReviewEditsSchema.safeParse(edits);
  if (found === undefined || !parsed.success) return undefined;
  const { riskRating } = parsed.data;
  return caseFeatures(found, riskRating === undefined ? {} : { riskRating });
}

/** The session's observed decisions with their screen moments (frames between opening the case and deciding). */
function sessionDecisions(deps: SchemaDeps, sessionId: string, schema: SessionSchema): ObservedDecision[] {
  return observedDecisions({ domain: schema.model.domain, entries: deps.ledger.evidence(sessionId), caseFeatures: kycFeatures });
}

function context(deps: SchemaDeps, loaded: LoadedSession, traceId: string): EntryContext {
  const session = deps.ledger.getSession(loaded.session.id) ?? loaded.session;
  return { sessionId: session.id, occurredAt: deps.now(), traceId, privacyEpoch: session.privacyEpoch };
}

// ── Serial background work ──

function serially(store: SchemaStore, sessionId: string, task: () => Promise<void>): Promise<void> {
  const run = (store.tails.get(sessionId) ?? Promise.resolve()).then(task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  store.tails.set(sessionId, settled);
  void settled.then(() => {
    if (store.tails.get(sessionId) === settled) store.tails.delete(sessionId);
  });
  return run;
}

/** Resolves once the session's queued backfill work has settled (tests, shutdown). */
export async function schemaIdle(store: SchemaStore, sessionId: string): Promise<void> {
  for (let tail = store.tails.get(sessionId); tail !== undefined; tail = store.tails.get(sessionId)) await tail;
}

function scheduleBackfill(deps: SchemaDeps, sessionId: string, traceId: string): void {
  serially(deps.store, sessionId, () => backfill(deps, sessionId, traceId)).catch((error: unknown) =>
    deps.log.error(`[schema] backfill for session ${sessionId} failed: ${describeError(error)}`),
  );
}

/** CaseDesk decision hook: a decision committed after a confirmation gets its concept values re-read too. */
export function withSchemaBackfill(inner: InterviewHooks, deps: SchemaDeps): InterviewHooks {
  return {
    ...inner,
    decisionCommitted(decision, loaded) {
      inner.decisionCommitted(decision, loaded);
      if (loaded.info.mode === "expert") scheduleBackfill(deps, loaded.session.id, decision.traceId);
    },
  };
}

// ── Backfill ──

function rereadFrames(deps: SchemaDeps, frameEntryIds: readonly string[]): RereadFrame[] {
  return frameEntryIds.flatMap((id) => {
    const e = deps.ledger.get(id);
    if (e?.kind !== "frame.received") return [];
    const p = parseLedgerPayload(e, "frame.received");
    return [{ entryId: e.id, frameId: p.frameId, width: p.width, height: p.height }];
  });
}

async function readOne(deps: SchemaDeps, input: Parameters<NonNullable<SchemaDeps["reread"]>>[0]): Promise<RereadResult> {
  if (deps.reread === null) return { ok: false, failure: "no_model", frameIds: [] };
  if (input.frames.length === 0) return { ok: false, failure: "no_frames", frameIds: [] };
  try {
    return await deps.reread(input);
  } catch (error) {
    deps.log.warn(`[schema] re-read of ${input.feature} for ${input.caseId} failed: ${describeError(error)}`);
    return { ok: false, failure: "model_error", frameIds: [] };
  }
}

/** Re-reads every (decision, confirmed concept) pair without a recorded value; then records the rebuilt hypotheses. */
async function backfill(deps: SchemaDeps, sessionId: string, traceId: string): Promise<void> {
  const loaded = loadSession({ ledger: deps.ledger, store: deps.casedesk }, sessionId);
  const schema = sessionSchema(deps.ledger, sessionId);
  if (schema.model.conceptFeatures.length === 0) return;
  const decisions = sessionDecisions(deps, sessionId, schema);
  const byId = new Map(decisions.map((d) => [d.entry.id, d]));
  const written: string[] = [];
  for (const { decisionEntryId, feature } of pendingBackfills(schema, [...byId.keys()])) {
    const decision = byId.get(decisionEntryId);
    const record = schema.confirmed.find((c) => c.definition.name === feature);
    if (decision === undefined || record?.bumpEntryId === undefined) continue;
    const result = await readOne(deps, {
      sessionId,
      domain: schema.model.domain,
      feature,
      caseId: decision.caseId,
      frames: rereadFrames(deps, decision.frameIds),
    });
    const confirmedAt = deps.ledger.get(record.entryId)?.sequence ?? Number.POSITIVE_INFINITY;
    const e = deps.ledger.append(
      entry(context(deps, loaded, traceId), "feature.backfilled", "engine", [record.bumpEntryId, decisionEntryId, ...result.frameIds], {
        feature,
        schemaVersion: record.schemaVersion,
        decisionEntryId,
        caseId: decision.caseId,
        ...(result.ok ? { value: result.value } : { value: { unknown: true as const, reason: "backfill_failed" as const }, failure: result.failure }),
        ...(result.evidence !== undefined && result.evidence !== "" && { evidence: result.evidence }),
        frameIds: result.frameIds,
        timing: decision.entry.sequence < confirmedAt ? "after_confirmation" : "new_case",
      }),
    );
    written.push(e.id);
  }
  if (written.length === 0) return;
  // The engine state is rebuilt under the new model on this read (engine-state.ts); record the rerun.
  const state = engineState({ ledger: deps.ledger, store: deps.interview, config: deps.engineConfig }, sessionId);
  const ctx = context(deps, loaded, traceId);
  deps.ledger.appendMany(
    [...state.families.values()]
      .filter((f) => f.decisions.length > 0)
      .map((f) => entry(ctx, "hypotheses.updated", "engine", written, { decisionFamily: f.model.family.id, hypothesisSetId: f.set.id, top: topCandidates(f), contradiction: false })),
  );
}

// ── Confirm / dismiss ──

/** The expert's words: typed (source `expert`), or a verbatim span of one of this session's utterances (source `voice`). */
function expertWords(deps: SchemaDeps, sessionId: string, input: z.infer<typeof ExpertWordsInputSchema>): { words: ExpertWords; source: LedgerSource; parents: string[] } {
  if (input.utteranceId === undefined) return { words: { text: input.text, provenance: "human_text" }, source: "expert", parents: [] };
  const u = deps.ledger.get(input.utteranceId);
  if (u === undefined || u.sessionId !== sessionId || u.kind !== "utterance.transcript")
    throw new ApiFailure(400, "unknown_utterance", "utteranceId is not an expert utterance of this session");
  if (!containsQuote(parseLedgerPayload(u, "utterance.transcript").text, input.text))
    throw new ApiFailure(400, "quote_not_verbatim", "the statement is not a verbatim span of the utterance");
  return { words: { text: input.text, provenance: "human_voice", utteranceId: u.id }, source: "voice", parents: [u.id] };
}

function pendingProposal(schema: SessionSchema, name: string): SessionSchema["undefinedConcepts"][number] {
  const proposal = schema.undefinedConcepts.find((c) => c.concept.name === name);
  if (proposal === undefined) throw new ApiFailure(409, "concept_not_pending", `"${name}" is not an undefined concept of this session (never proposed, or already confirmed or dismissed)`);
  return proposal;
}

export function applyConceptAction(deps: SchemaDeps, sessionId: string, body: ConceptActionRequest): ActionResponse {
  const loaded = loadExpert(deps, sessionId);
  requireNotArchived(loaded.session);
  const id = loaded.session.id;
  const schema = sessionSchema(deps.ledger, id);
  const proposal = pendingProposal(schema, body.name);
  const traceId = randomUUID();
  const { words, source, parents } = expertWords(deps, id, body.statement);

  if (body.action === "dismiss") {
    if ((body.reason === "already_covered") !== (body.coveredBy !== undefined))
      throw new ApiFailure(400, "invalid_request", "coveredBy names the existing feature exactly when the reason is already_covered");
    if (body.coveredBy !== undefined && !schema.model.domain.features.some((f) => f.id === body.coveredBy))
      throw new ApiFailure(400, "unknown_feature", `${body.coveredBy} is not a feature of the current model`);
    const dismissed = deps.ledger.append(
      entry(context(deps, loaded, traceId), "concept.dismissed", source, [...proposal.entryIds, ...parents], {
        name: body.name,
        reason: body.reason,
        ...(body.coveredBy !== undefined && { coveredBy: body.coveredBy }),
        statement: words,
      }),
    );
    return { entryId: dismissed.id, bumpEntryId: null, schemaVersion: schema.model.schemaVersion, backfillQueued: 0 };
  }

  const definition = ConceptDefinitionSchema.safeParse({ ...body.definition, name: body.name });
  if (!definition.success) throw new ApiFailure(400, "invalid_concept", definition.error.issues.map((i) => i.message).join("; "));
  const from = schema.model.schemaVersion;
  const to = from + 1;
  const next = featureModel(KYC_DOMAIN, [...schema.confirmed, { definition: definition.data, schemaVersion: to }], CASEDESK_SCHEMA_VERSION);
  if (!next.ok) throw new ApiFailure(422, "invalid_concept", next.issues.map((i) => `${i.path}: ${i.message}`).join("; "));

  const confirmed = deps.ledger.append(
    entry(context(deps, loaded, traceId), "concept.confirmed", source, [...proposal.entryIds, ...parents], {
      feature: definition.data.name,
      schemaVersion: to,
      definition: definition.data,
      statement: words,
    }),
  );
  const bump = deps.ledger.append(
    entry(context(deps, loaded, traceId), "schema.version_bumped", "engine", [confirmed.id], { from, to, feature: definition.data.name, label: definition.data.label }),
  );
  const decisions = sessionDecisions(deps, id, sessionSchema(deps.ledger, id));
  scheduleBackfill(deps, id, traceId);
  return { entryId: confirmed.id, bumpEntryId: bump.id, schemaVersion: to, backfillQueued: decisions.length };
}

// ── View ──

export function conceptsState(deps: SchemaDeps, sessionId: string): ConceptsState {
  const loaded = loadExpert(deps, sessionId);
  const id = loaded.session.id;
  const schema = sessionSchema(deps.ledger, id);
  const decisions = sessionDecisions(deps, id, schema);
  const pending = pendingBackfills(schema, decisions.map((d) => d.entry.id));
  const latest = schema.confirmed.at(-1);
  return {
    sessionId: id,
    schemaVersion: schema.model.schemaVersion,
    baseSchemaVersion: BASE_SCHEMA_VERSION,
    recomputing: pending.length > 0 || deps.store.tails.has(id),
    latest: latest === undefined ? null : { name: latest.definition.name, label: latest.definition.label, schemaVersion: latest.schemaVersion },
    undefinedConcepts: schema.undefinedConcepts.map(({ concept, entryIds, origin }) => ({
      name: concept.name,
      label: concept.label,
      definition: concept.definition,
      type: concept.type,
      values: concept.values ?? [],
      quote: concept.exactQuote ?? null,
      origin,
      proposalEntryIds: entryIds,
    })),
    confirmed: schema.confirmed.map((c) => {
      const statement = deps.ledger.get(c.entryId);
      return {
        name: c.definition.name,
        label: c.definition.label,
        type: c.definition.type,
        schemaVersion: c.schemaVersion,
        entryId: c.entryId,
        bumpEntryId: c.bumpEntryId ?? null,
        statement: statement === undefined ? "" : parseLedgerPayload(statement, "concept.confirmed").statement.text,
        backfill: decisions.map((d) => {
          const r = schema.backfills.get(d.entry.id)?.get(c.definition.name);
          return {
            decisionEntryId: d.entry.id,
            caseId: d.caseId,
            entryId: r?.entryId ?? null,
            value: r === undefined || typeof r.value === "object" ? null : r.value,
            failure: r?.failure ?? null,
            frameIds: r?.frameIds ?? [],
          };
        }),
      };
    }),
    dismissed: schema.dismissed.map((d) => ({ name: d.name, reason: d.reason, coveredBy: d.coveredBy ?? null, entryId: d.entryId })),
    features: schema.model.domain.features.map((f) => ({ id: f.id, label: f.label })),
    rereadAvailable: deps.reread !== null,
  };
}
