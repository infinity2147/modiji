/**
 * Debrief questions from solver witnesses (plan §7.5 #3): plain language, asked through the same
 * gate and custom-LLM path as live questions (`question.queued`, kind "witness"). The text names
 * exactly the conditions the rulebook can tell apart — the decision cell — so an answer about the
 * question is an answer about the cell. ≤25 words whenever the case allows it.
 */
import "server-only";
import {
  MAX_QUESTION_WORDS,
  actionPhrase,
  QuestionSchema,
  canonicalJson,
  contentId,
  type Question,
  type Witness,
} from "@vashistha/core";
import { DOMAIN, boundaryPhrases, cellOf, suggestedAction, type Snapshot } from "./state";
import { caseDescription, cellPhrases, effectPhrase, withinWords } from "./text";

/** Queue priority by witness kind (not EIG: a witness is a proof obligation, not a hypothesis split). */
const PRIORITY: Record<Witness["kind"], number> = { conflict: 1, unresolved: 0.9, boundary: 0.5, disagreement: 0.8 };
const REASON: Record<Witness["kind"], string> = {
  unresolved: "solver: no rule decides this case",
  conflict: "solver: two rules conflict on this case",
  boundary: "solver: threshold check",
  disagreement: "solver: two experts disagree",
};

export function witnessQuestionId(sessionId: string, witnessId: string): string {
  return contentId("q", canonicalJson({ s: sessionId, k: "witness", w: witnessId }));
}

function familyLabel(id: string): string {
  return DOMAIN.decisionFamilies.find((f) => f.id === id)?.label.toLowerCase() ?? id;
}

/** The question text for a witness, deterministic. */
export function witnessQuestionText(snap: Snapshot, w: Witness): string {
  switch (w.kind) {
    case "unresolved": {
      const phrases = cellPhrases(DOMAIN, cellOf(snap, w));
      if (phrases.length === 0) return `No confirmed rule decides the ${familyLabel(w.decisionFamily)} yet. What decides it?`;
      const desc = caseDescription(phrases);
      const suggestion = suggestedAction(snap, w);
      return withinWords(
        [...(suggestion === undefined ? [] : [`${desc} — ${actionPhrase(DOMAIN, suggestion)}?`]), `${desc} — what would you decide?`, `${desc}?`],
        MAX_QUESTION_WORDS,
      );
    }
    case "conflict": {
      const desc = caseDescription(cellPhrases(DOMAIN, cellOf(snap, w)));
      const [a, b] = w.actions.map((x) => actionPhrase(DOMAIN, x));
      return withinWords([`${desc} — ${a} or ${b}?`, `${desc}: which applies?`], MAX_QUESTION_WORDS);
    }
    case "boundary": {
      const rule = snap.book.rules.find((r) => r.id === w.ruleId);
      const desc = caseDescription(boundaryPhrases(snap, w));
      return rule === undefined ? `${desc}?` : withinWords([`${desc} — ${effectPhrase(DOMAIN, rule.effect)}?`, `${desc}?`], MAX_QUESTION_WORDS);
    }
    case "disagreement":
      return withinWords([`${caseDescription(cellPhrases(DOMAIN, cellOf(snap, w)))} — which decision is right?`], MAX_QUESTION_WORDS);
  }
}

export function witnessQuestion(snap: Snapshot, w: Witness, ctx: { createdAt: number; contextVersion: number; parentIds: string[] }): Question {
  const sessionId = snap.loaded.session.id;
  return QuestionSchema.parse({
    id: witnessQuestionId(sessionId, w.id),
    sessionId,
    kind: "witness",
    text: witnessQuestionText(snap, w),
    decisionFamily: w.decisionFamily,
    target: {
      candidateIds: [],
      witnessId: w.id,
      assignment: w.assignment,
      ...(w.kind === "boundary" && { ruleId: w.ruleId, feature: w.feature }),
    },
    value: PRIORITY[w.kind],
    reason: REASON[w.kind],
    ephemeral: false,
    createdAt: ctx.createdAt,
    contextVersion: ctx.contextVersion,
    parentIds: ctx.parentIds,
  });
}
