/**
 * A novice session's tutor record, folded from its ledger and nothing else: the latest selected
 * outcome per case, the first prediction per case, interventions and the speech status of their
 * questions, committed decisions, generated cases, and the mastery ladder (`mastery.updated`).
 */
import "server-only";
import { parseLedgerPayload, type LedgerEntry, type LedgerPayload, type MasteryLevel } from "@vashistha/core";
import type { Ledger } from "@vashistha/core/server";

const KINDS = [
  "tutor.intent",
  "tutor.prediction",
  "tutor.intervention",
  "question.queued",
  "question.dropped",
  "gate.authorized",
  "question.requeued",
  "case.decision",
  "case.generated",
  "mastery.updated",
] as const;

export type Recorded<K extends (typeof KINDS)[number]> = { entry: LedgerEntry; payload: LedgerPayload<K> };

export type TutorRecord = {
  /** Latest selected (unsaved) outcome per case. */
  intents: Map<string, Recorded<"tutor.intent">>;
  /** The first prediction per case: the one that counts. */
  predictions: Map<string, Recorded<"tutor.prediction">>;
  interventions: Recorded<"tutor.intervention">[];
  /** Intervention questions by id: the spoken text and the `question.queued` entry. */
  interventionQuestions: Map<string, { text: string; entryId: string }>;
  /** Question ids the gate authorized (spoken) or the tutor dropped. */
  spoken: Set<string>;
  dropped: Set<string>;
  decisions: Map<string, Recorded<"case.decision">>;
  generated: Map<string, Recorded<"case.generated">>;
  mastery: Map<string, MasteryLevel>;
};

export function tutorRecord(ledger: Pick<Ledger, "list">, sessionId: string): TutorRecord {
  const record: TutorRecord = {
    intents: new Map(),
    predictions: new Map(),
    interventions: [],
    interventionQuestions: new Map(),
    spoken: new Set(),
    dropped: new Set(),
    decisions: new Map(),
    generated: new Map(),
    mastery: new Map(),
  };
  for (const entry of ledger.list(sessionId, { kinds: KINDS })) {
    switch (entry.kind) {
      case "tutor.intent": {
        const payload = parseLedgerPayload(entry, "tutor.intent");
        record.intents.set(payload.caseId, { entry, payload });
        break;
      }
      case "tutor.prediction": {
        const payload = parseLedgerPayload(entry, "tutor.prediction");
        if (!record.predictions.has(payload.caseId)) record.predictions.set(payload.caseId, { entry, payload });
        break;
      }
      case "tutor.intervention":
        record.interventions.push({ entry, payload: parseLedgerPayload(entry, "tutor.intervention") });
        break;
      case "question.queued": {
        const question = parseLedgerPayload(entry, "question.queued");
        if (question.kind === "intervention") record.interventionQuestions.set(question.id, { text: question.text, entryId: entry.id });
        break;
      }
      case "question.dropped":
        record.dropped.add(parseLedgerPayload(entry, "question.dropped").questionId);
        break;
      case "gate.authorized":
        record.spoken.add(parseLedgerPayload(entry, "gate.authorized").questionId);
        break;
      // Its authorization expired unspoken: the intervention is waiting to be spoken again.
      case "question.requeued":
        record.spoken.delete(parseLedgerPayload(entry, "question.requeued").questionId);
        break;
      case "case.decision": {
        const payload = parseLedgerPayload(entry, "case.decision");
        record.decisions.set(payload.caseId, { entry, payload });
        break;
      }
      case "case.generated": {
        const payload = parseLedgerPayload(entry, "case.generated");
        record.generated.set(payload.case.id, { entry, payload });
        break;
      }
      case "mastery.updated": {
        const { ruleId, to } = parseLedgerPayload(entry, "mastery.updated");
        record.mastery.set(ruleId, to);
        break;
      }
    }
  }
  return record;
}

/** Speech status of an intervention's question: spoken once authorized; dropped if withdrawn first. */
export function speechOf(record: TutorRecord, questionId: string): "queued" | "spoken" | "dropped" {
  return record.spoken.has(questionId) ? "spoken" : record.dropped.has(questionId) ? "dropped" : "queued";
}

/** Interventions still waiting to be spoken. */
export function queuedInterventions(record: TutorRecord): Recorded<"tutor.intervention">[] {
  return record.interventions.filter((i) => speechOf(record, i.payload.questionId) === "queued");
}

/** The case was generated as a solver boundary case (it counts as "at a boundary" on the ladder). */
export function isBoundaryCase(record: TutorRecord, caseId: string): boolean {
  return record.generated.get(caseId)?.payload.origin.kind === "boundary_practice";
}
