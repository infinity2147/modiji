import type { ParsedAnswer, ProposedConcept, Question, StatedRule } from "../schemas/engine";
import type { HypothesisSet } from "../schemas/rules";
import { typecheckPredicate } from "../logic/typecheck";
import type { EngineConfig } from "./config";
import { findFeature } from "./describe";
import { candidateId, predicateComplexity, type CandidateSeed } from "./enumerate";
import type { FamilyModel, Observation } from "./model";
import { buildHypothesisSet, type FamilyKnowledge } from "./posterior";

export type StatedRuleOutcome =
  | { status: "candidate"; rule: StatedRule; candidateId: string }
  | { status: "rejected"; rule: StatedRule; reasons: string[] };

export type Ignored = { item: string; reason: string };

export type AnswerApplication = {
  /** `low_confidence`: the parse was below `minParseConfidence`; nothing changed and the question stays open. */
  status: "applied" | "low_confidence";
  knowledge: FamilyKnowledge;
  set: HypothesisSet;
  /** Every stated rule, accepted as an `expert_statement` candidate or rejected with reasons — never dropped. */
  statedRules: StatedRuleOutcome[];
  /** The updated list of concepts awaiting expert confirmation (plan §6.6); they are not features yet. */
  undefinedConcepts: ProposedConcept[];
  /** Parser output that was not applied, with why (unknown candidate ids, contradictory lists, …). */
  ignored: Ignored[];
  /** The observation recorded from `answeredAction`, if any. */
  observation?: Observation;
  /**
   * No candidate survives: the decisions are unexplained under the current feature model. The set is
   * left empty (nothing is invented); the caller asks a why-probe.
   */
  unexplained: boolean;
};

/**
 * Applies a parsed expert answer to one family (plan §7.3 "answer parsing"):
 *   - eliminated candidates leave the set for good (weight 0, then renormalised by the rebuild);
 *   - `answeredAction` on a counterfactual/witness question is an observation of the asked case;
 *   - stated rules become `expert_statement` candidates after type-checking (a statement re-admits
 *     an identical candidate that an earlier answer eliminated: the expert's explicit words win);
 *   - new concepts join the undefined-concepts list.
 * The set is then rebuilt from the updated knowledge, so weights stay prior × likelihood.
 */
export function applyAnswer(params: {
  model: FamilyModel;
  set: HypothesisSet;
  knowledge: FamilyKnowledge;
  question: Question;
  answer: ParsedAnswer;
  undefinedConcepts: readonly ProposedConcept[];
  config: EngineConfig;
}): AnswerApplication {
  const { model, set, knowledge, question, answer, config } = params;
  if (answer.questionId !== question.id) throw new RangeError(`answer is for question ${answer.questionId}, not ${question.id}`);
  if (question.decisionFamily !== undefined && question.decisionFamily !== model.family.id)
    throw new RangeError(`question ${question.id} is about family ${question.decisionFamily}, not ${model.family.id}`);
  const unchanged = { knowledge, set, statedRules: [], undefinedConcepts: [...params.undefinedConcepts], ignored: [], unexplained: set.candidates.length === 0 };
  if (answer.confidence < config.minParseConfidence) return { status: "low_confidence", ...unchanged };

  const ignored: Ignored[] = [];
  const inSet = new Set(set.candidates.map((c) => c.id));
  const surviving = new Set(answer.survivingCandidateIds);
  const eliminated = new Set(knowledge.eliminatedIds);
  for (const id of answer.eliminatedCandidateIds) {
    if (!inSet.has(id)) ignored.push({ item: id, reason: "not a candidate of this hypothesis set" });
    else if (surviving.has(id)) ignored.push({ item: id, reason: "listed as both surviving and eliminated" });
    else eliminated.add(id);
  }
  for (const id of answer.survivingCandidateIds)
    if (!inSet.has(id)) ignored.push({ item: id, reason: "not a candidate of this hypothesis set" });

  const stated = new Map(knowledge.statedCandidates.map((s) => [s.id, s]));
  const statedRules = answer.statedRules.map((rule): StatedRuleOutcome => {
    const reasons = statedRuleProblems(model, rule);
    if (reasons.length > 0) return { status: "rejected", rule, reasons };
    const seed: CandidateSeed = {
      id: candidateId(model.family.id, rule.predicate, rule.action),
      predicate: rule.predicate,
      predictedAction: rule.action,
      complexity: predicateComplexity(rule.predicate, model.domain),
      origin: "expert_statement",
    };
    stated.set(seed.id, seed);
    eliminated.delete(seed.id);
    return { status: "candidate", rule, candidateId: seed.id };
  });

  let observation: Observation | undefined;
  if (answer.answeredAction !== undefined) {
    const assignment = question.target.assignment;
    if ((question.kind !== "counterfactual" && question.kind !== "witness") || assignment === undefined)
      ignored.push({ item: answer.answeredAction, reason: `a ${question.kind} question asks about no concrete case` });
    else if (!model.family.actions.includes(answer.answeredAction))
      ignored.push({ item: answer.answeredAction, reason: `not an action of family ${model.family.id}` });
    else
      observation = { id: answer.utteranceId, caseId: question.target.caseId ?? question.id, features: assignment, action: answer.answeredAction };
  }

  const undefinedConcepts = [...params.undefinedConcepts];
  for (const concept of answer.newConcepts) {
    if (findFeature(model.domain, concept.name) !== undefined) ignored.push({ item: concept.name, reason: "already a feature of the domain" });
    else if (undefinedConcepts.some((c) => c.name === concept.name)) ignored.push({ item: concept.name, reason: "already awaiting confirmation" });
    else undefinedConcepts.push(concept);
  }

  const next: FamilyKnowledge = {
    observations: observation === undefined ? knowledge.observations : [...knowledge.observations, observation],
    statedCandidates: [...stated.values()],
    eliminatedIds: [...eliminated],
  };
  const rebuilt = buildHypothesisSet({ setId: set.id, model, knowledge: next, schemaVersion: set.schemaVersion, config, previous: set });
  return {
    status: "applied",
    knowledge: next,
    set: rebuilt,
    statedRules,
    undefinedConcepts,
    ignored,
    ...(observation && { observation }),
    unexplained: rebuilt.candidates.length === 0,
  };
}

function statedRuleProblems(model: FamilyModel, rule: StatedRule): string[] {
  const reasons = typecheckPredicate(rule.predicate, model.domain.features).map((i) => `predicate ${i.path || "/"}: ${i.message}`);
  if (!model.family.actions.includes(rule.action)) reasons.push(`"${rule.action}" is not an action of family ${model.family.id}`);
  else if (rule.action === model.defaultAction)
    reasons.push(`predicts the family default "${rule.action}", so as a hypothesis it equals "no rule"; promote it directly once confirmed`);
  if (rule.t1Ms < rule.t0Ms) reasons.push("quote ends before it starts (t1Ms < t0Ms)");
  return reasons;
}
