/**
 * The compliance strip (plan §10), computed only from the session ledger — every item stays pending
 * until the ledger proves it:
 *
 * - Live questions n/3: distinct live questions (why-probe, counterfactual, concept definition) the
 *   gate authorized AND the agent then spoke (`llm.turn_decision` speak whose stream was not aborted
 *   without a later successful speak).
 * - Guardrail ✓: a `rule.confirmed` entry whose rule kind is "guardrail".
 * - Debrief gaps closed n/3: `witness.resolved` entries.
 * - Teach-back ✓: a `teachback.confirmed` entry.
 * - Unseen case intercepted ✓: a `tutor.intervention`, and no later violating `case.decision` for that
 *   case (the proposed action committed without an escalation).
 */
import { z } from "zod";
import { IdSchema, parseLedgerPayload, type LedgerEntry, type QuestionKind } from "@vashistha/core";

export const LIVE_QUESTION_TARGET = 3;
/** Questions asked during capture (M1); witness and teach-back questions belong to the debrief. */
export const LIVE_QUESTION_KINDS: ReadonlySet<QuestionKind> = new Set(["why_probe", "counterfactual", "concept_definition"]);
export const DEBRIEF_GAP_TARGET = 3;

export type Compliance = {
  liveQuestions: number;
  guardrail: boolean;
  debriefGaps: number;
  teachBack: boolean;
  unseenCaseIntercepted: boolean;
};

const TurnDecisionRefSchema = z.looseObject({ questionId: IdSchema.optional() });
const RuleKindSchema = z.looseObject({ kind: z.string().optional() });

function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Folds the ledger (oldest first) into the strip. Entries that fail their registry schema count for nothing. */
export function computeCompliance(entries: readonly LedgerEntry[]): Compliance {
  const liveQuestionIds = new Set<string>();
  const authorized = new Set<string>();
  /** Speak decisions by entry id → question, and each question's latest speak decision. */
  const speakDecision = new Map<string, string>();
  const latestSpeak = new Map<string, string>();
  const aborted = new Set<string>();
  let guardrail = false;
  let debriefGaps = 0;
  let teachBack = false;
  const interventions: { caseId: string; proposedAction: string; sequence: number }[] = [];
  const violations: { caseId: string; action: string; sequence: number }[] = [];

  for (const entry of entries) {
    switch (entry.kind) {
      case "question.queued": {
        const q = safely(() => parseLedgerPayload(entry, "question.queued"));
        if (q && LIVE_QUESTION_KINDS.has(q.kind)) liveQuestionIds.add(q.id);
        break;
      }
      case "gate.authorized": {
        const p = safely(() => parseLedgerPayload(entry, "gate.authorized"));
        if (p) authorized.add(p.questionId);
        break;
      }
      case "llm.turn_decision": {
        const p = safely(() => parseLedgerPayload(entry, "llm.turn_decision"));
        const questionId = p?.decision === "speak" ? TurnDecisionRefSchema.safeParse(p).data?.questionId : undefined;
        if (questionId !== undefined) {
          speakDecision.set(entry.id, questionId);
          latestSpeak.set(questionId, entry.id);
        }
        break;
      }
      case "llm.stream_aborted":
        if (safely(() => parseLedgerPayload(entry, "llm.stream_aborted")))
          for (const parent of entry.parentIds) aborted.add(parent);
        break;
      case "rule.confirmed": {
        const p = safely(() => parseLedgerPayload(entry, "rule.confirmed"));
        if (p && RuleKindSchema.safeParse(p).data?.kind === "guardrail") guardrail = true;
        break;
      }
      case "witness.resolved":
        if (safely(() => parseLedgerPayload(entry, "witness.resolved"))) debriefGaps += 1;
        break;
      case "teachback.confirmed":
        if (safely(() => parseLedgerPayload(entry, "teachback.confirmed"))) teachBack = true;
        break;
      case "tutor.intervention": {
        const p = safely(() => parseLedgerPayload(entry, "tutor.intervention"));
        if (p) interventions.push({ caseId: p.caseId, proposedAction: p.proposedAction, sequence: entry.sequence });
        break;
      }
      case "case.decision": {
        const p = safely(() => parseLedgerPayload(entry, "case.decision"));
        if (p && p.override?.kind !== "escalated") violations.push({ caseId: p.caseId, action: p.action, sequence: entry.sequence });
        break;
      }
    }
  }

  let liveQuestions = 0;
  for (const questionId of liveQuestionIds) {
    const decision = latestSpeak.get(questionId);
    if (authorized.has(questionId) && decision !== undefined && speakDecision.has(decision) && !aborted.has(decision))
      liveQuestions += 1;
  }

  const unseenCaseIntercepted = interventions.some(
    (i) => !violations.some((v) => v.caseId === i.caseId && v.action === i.proposedAction && v.sequence > i.sequence),
  );

  return { liveQuestions, guardrail, debriefGaps, teachBack, unseenCaseIntercepted };
}
