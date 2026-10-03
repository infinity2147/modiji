/** Shared plumbing of the tutor handlers: novice sessions, their cases, and where tutor entries hang in the ledger. */
import "server-only";
import { randomUUID } from "node:crypto";
import { recordLookup, type FeatureId, type FeatureLookup, type Rulebook, type Value } from "@vashistha/core";
import { caseFeatures, type KycCase } from "@vashistha/core/domains/kyc";
import type { z } from "zod";
import type { ReviewEditsSchema } from "../../contracts/casedesk";
import { findSessionCase } from "../casedesk/cases";
import { ApiFailure } from "../casedesk/http";
import { loadSession, type LoadedSession } from "../casedesk/session";
import type { EntryContext } from "../interview/ledger";
import type { TutorDeps } from "./deps";

export type ReviewEdits = z.infer<typeof ReviewEditsSchema>;

/** 404 unless a CaseDesk session; 409 unless a novice one (the tutor teaches novices only). */
export function loadNoviceSession(deps: Pick<TutorDeps, "ledger" | "casedesk">, sessionId: string): LoadedSession {
  const loaded = loadSession({ ledger: deps.ledger, store: deps.casedesk }, sessionId);
  if (loaded.info.mode !== "novice") throw new ApiFailure(409, "not_novice", "the tutor works in novice sessions only");
  return loaded;
}

export function requireSessionCase(deps: Pick<TutorDeps, "ledger">, { info, session }: LoadedSession, caseId: string): KycCase {
  const found = findSessionCase(deps.ledger, session.id, info, caseId);
  if (found === undefined) throw new ApiFailure(400, "unknown_case", `case ${caseId} is not in this session`);
  return found;
}

/** The case's decision features with the reviewer's edits applied (as the Save interlock reads them). */
export function caseLookup(kycCase: KycCase, edits: ReviewEdits): FeatureLookup {
  return recordLookup(caseFeatures(kycCase, edits.riskRating === undefined ? {} : { riskRating: edits.riskRating }));
}

/** The edits as a ledger payload records them (only the fields the reviewer set). */
export function editsRecord(edits: ReviewEdits): Record<FeatureId, Value> {
  const set: [string, Value][] = Object.entries(edits).flatMap(([field, value]) => (value === undefined ? [] : [[field, value]]));
  return Object.fromEntries(set) as Record<FeatureId, Value>;
}

/** Rule id → the ledger entry of its current version (for provenance edges to the expert's rule). */
export function ruleEntryIds(book: Pick<Rulebook, "history">): Map<string, string> {
  const ids = new Map<string, string>();
  for (const event of book.history) if (event.kind !== "retired") ids.set(event.ruleId, event.ledgerEntryId);
  return ids;
}

export function entryContext(deps: Pick<TutorDeps, "now">, { session }: LoadedSession, traceId: string = randomUUID()): EntryContext {
  return { sessionId: session.id, occurredAt: deps.now(), traceId, privacyEpoch: session.privacyEpoch };
}
