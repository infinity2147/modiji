import type { DecisionContext } from "../schemas/context";
import type { DomainConfig, Feature } from "../schemas/domain";
import type { Assignment, ProposedConcept, Question } from "../schemas/engine";
import { evaluatePredicate, type FeatureLookup } from "../logic/evaluate";
import { contextLookup } from "../logic/context";
import { featuresReferenced } from "../logic/typecheck";
import { predicateNode } from "../logic/node";
import { isVarRef, type Predicate } from "../schemas/predicate";
import { FeatureIdSchema, isUnknown, type FeatureId, type FeatureValue, type Value } from "../schemas/primitives";
import type { HypothesisSet } from "../schemas/rules";
import { canonicalJson, contentId } from "./canonical";
import { MAX_QUESTION_WORDS, type EngineConfig } from "./config";
import { actionPhrase, featurePhrase, findFeature, formatValue, wordCount } from "./describe";
import { counterfactualEig } from "./eig";
import { flattenContext, predictedAction, recordLookup, type FamilyModel } from "./model";
import { roundestBetween, type NumberFeature } from "./numbers";
import type { RecentDecision } from "./posterior";
import { isContradiction } from "./surprise";

/** Where and when the questions would be asked. */
export type QuestionContext = {
  sessionId: string;
  createdAt: number;
  contextVersion: number;
  /** The case on screen. */
  caseId: string;
  context: DecisionContext;
  /** Ledger entries that motivated the questions (e.g. the surprising decision). */
  parentIds: string[];
};

export const QUESTION_REASONS = {
  contradiction: "contradiction detected",
  competing: "competing explanations",
  unexplained: "unexplained decision",
  concept: "new concept",
} as const;

/**
 * Counterfactual questions on the current case: one feature moved across a threshold the
 * candidates use (or to another enum/boolean value), valued by EIG in bits.
 *
 * Validity. The moved case must satisfy every domain constraint under the Kleene evaluator (a
 * constraint that is false or unknown discards it: a counterfactual must be a valid, fully
 * determined case). If the move violates a constraint (existing → new requires 0 months'
 * history), ONE other feature that the violated constraints mention is adjusted minimally — the
 * first feature in domain order, with the value closest to its current one (enum/boolean: declared
 * order; number: the constraints' own literals and the feature's bounds) — and the adjustment is
 * stated in the question. If no single adjustment makes the case valid, the question is discarded.
 */
export function counterfactualQuestions(params: {
  model: FamilyModel;
  set: HypothesisSet;
  ctx: QuestionContext;
  recent?: RecentDecision;
  config: EngineConfig;
}): Question[] {
  const { model, set, ctx, recent, config } = params;
  if (set.candidates.length === 0) return [];
  const { domain } = model;
  const base = knownAssignment(flattenContext(ctx.context, domain));
  const reason = recent !== undefined && isContradiction(recent.surprise, config) ? QUESTION_REASONS.contradiction : QUESTION_REASONS.competing;
  const questions: Question[] = [];
  for (const f of domain.features) {
    const current = base[f.id];
    if (current === undefined) continue;
    for (const value of counterfactualValues(f, current, set)) {
      const moved = makeValid(domain, { ...base, [f.id]: value }, f.id, base);
      if (moved === undefined) continue;
      const lookup = recordLookup(moved.assignment);
      const eig = counterfactualEig(model, set, lookup);
      const text = counterfactualText(f, current, value, moved.adjusted);
      if (text === undefined) continue;
      questions.push({
        id: contentId("q", canonicalJson({ s: ctx.sessionId, v: ctx.contextVersion, k: "counterfactual", fam: model.family.id, a: moved.assignment })),
        sessionId: ctx.sessionId,
        kind: "counterfactual",
        text,
        decisionFamily: model.family.id,
        target: { caseId: ctx.caseId, candidateIds: rivalCandidates(model, set, lookup), feature: f.id, assignment: moved.assignment },
        value: eig,
        reason,
        ephemeral: false,
        createdAt: ctx.createdAt,
        contextVersion: ctx.contextVersion,
        parentIds: ctx.parentIds,
      });
    }
  }
  return questions;
}

/**
 * ACTA why-probe for an unexplained decision: the hypotheses held before it arrived gave it less
 * than `config.explainedMass` (typical for a family's first non-default decisions), or no
 * candidate survives now. Value: the decision's surprise in bits (a priority score — an open question has
 * no enumerable answer space). Ephemeral: it only makes sense right after the decision.
 */
export function whyProbe(params: { model: FamilyModel; set: HypothesisSet; ctx: QuestionContext; recent: RecentDecision; config: EngineConfig }): Question | undefined {
  const { model, set, ctx, recent, config } = params;
  const { observation } = recent;
  if (set.candidates.length > 0 && recent.explainedMass >= config.explainedMass) return undefined;
  const text = `What told you to ${actionPhrase(model.domain, observation.action)} here? What would have changed your mind?`;
  return {
    id: contentId("q", canonicalJson({ s: ctx.sessionId, v: ctx.contextVersion, k: "why_probe", fam: model.family.id, o: observation.id })),
    sessionId: ctx.sessionId,
    kind: "why_probe",
    text,
    decisionFamily: model.family.id,
    target: { caseId: observation.caseId, candidateIds: [] },
    value: Number.isFinite(recent.surprise.bits) ? recent.surprise.bits : Math.log2(model.family.actions.length),
    reason: QUESTION_REASONS.unexplained,
    ephemeral: true,
    createdAt: ctx.createdAt,
    contextVersion: ctx.contextVersion,
    parentIds: [...new Set([...ctx.parentIds, observation.id])],
  };
}

/** "What counts as X?" for each concept the expert used that the feature model lacks (plan §6.6). */
export function conceptProbes(params: { concepts: readonly ProposedConcept[]; ctx: QuestionContext; config: EngineConfig }): Question[] {
  const { concepts, ctx, config } = params;
  return concepts.map((c) => ({
    id: contentId("q", canonicalJson({ s: ctx.sessionId, v: ctx.contextVersion, k: "concept_definition", c: c.name })),
    sessionId: ctx.sessionId,
    kind: "concept_definition",
    text: `You mentioned “${c.label}”. What counts as ${c.label}, and where would I see it on screen?`,
    target: { caseId: ctx.caseId, candidateIds: [], feature: FeatureIdSchema.parse(c.name) },
    value: config.conceptProbeValue,
    reason: QUESTION_REASONS.concept,
    ephemeral: false,
    createdAt: ctx.createdAt,
    contextVersion: ctx.contextVersion,
    parentIds: ctx.parentIds,
  }));
}

/**
 * Never ask what the screen answers (plan §7.3): a question whose target feature is a declared
 * feature already known in the current context. Counterfactual and witness questions are exempt —
 * they ask about a hypothetical case, not the value on screen.
 */
export function screenAnswers(question: Question, domain: DomainConfig, context: DecisionContext): boolean {
  if (question.kind === "counterfactual" || question.kind === "witness") return false;
  const feature = question.target.feature;
  if (feature === undefined || findFeature(domain, feature) === undefined) return false;
  return !isUnknown(contextLookup(context, domain.features)(feature));
}

/**
 * The live question queue for one family: counterfactuals, a why-probe for an unexplained recent
 * decision, concept probes; minus what the screen answers and anything over 25 words; highest value
 * first (ties by id, so the order is deterministic).
 */
export function generateQuestions(params: {
  model: FamilyModel;
  set: HypothesisSet;
  ctx: QuestionContext;
  recent?: RecentDecision;
  concepts?: readonly ProposedConcept[];
  config: EngineConfig;
}): Question[] {
  const { model, set, ctx, recent, concepts = [], config } = params;
  const why = recent === undefined ? undefined : whyProbe({ model, set, ctx, recent, config });
  return [
    ...counterfactualQuestions({ model, set, ctx, ...(recent && { recent }), config }),
    ...(why === undefined ? [] : [why]),
    ...conceptProbes({ concepts, ctx, config }),
  ]
    .filter((q) => wordCount(q.text) <= MAX_QUESTION_WORDS && !screenAnswers(q, model.domain, ctx.context))
    .sort((a, b) => b.value - a.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The highest-value question at or above θ_ask (plan §7.2), if any. */
export function selectQuestion(queue: readonly Question[], options: { thetaAsk: number }): Question | undefined {
  let best: Question | undefined;
  for (const q of queue) if (q.value >= options.thetaAsk && (best === undefined || q.value > best.value || (q.value === best.value && q.id < best.id))) best = q;
  return best;
}

function knownAssignment(features: Record<FeatureId, FeatureValue>): Assignment {
  const out: Assignment = {};
  for (const [k, v] of Object.entries(features) as [FeatureId, FeatureValue][]) if (!isUnknown(v)) out[k] = v;
  return out;
}

/** Candidate values for a counterfactual move of `f` away from `current`. */
function counterfactualValues(f: Feature, current: Value, set: HypothesisSet): Value[] {
  switch (f.type) {
    case "boolean":
      return [!current];
    case "enum":
      return f.values.filter((v) => v !== current);
    case "string":
      return [...new Set(literalsIn(candidatePredicates(set), f.id).filter((v): v is string => typeof v === "string" && v !== current))].sort();
    case "number":
      return numericValues(f, current, set);
  }
}

/**
 * Each threshold the candidates use on `f`, plus the roundest value inside each region between
 * them. The outer regions are cut to one threshold-span beyond the outermost thresholds, so the
 * question stays near the boundary ("36 months", not "312 months").
 */
function numericValues(f: NumberFeature, current: Value, set: HypothesisSet): number[] {
  const ts = [...new Set(literalsIn(candidatePredicates(set), f.id).filter((v): v is number => typeof v === "number"))].sort((a, b) => a - b);
  const lo = ts[0];
  const hi = ts[ts.length - 1];
  if (lo === undefined || hi === undefined) return [];
  const span = hi > lo ? hi - lo : Math.max(Math.abs(hi), (f.max - f.min) / 10);
  const edges = [Math.max(f.min, lo - span), ...ts, Math.min(f.max, hi + span)];
  const reps: number[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const r = roundestBetween(f, edges[i] as number, edges[i + 1] as number);
    if (r !== undefined) reps.push(r);
  }
  return [...new Set([...ts, ...reps])].filter((v) => v !== current && v >= f.min && v <= f.max).sort((a, b) => a - b);
}

function candidatePredicates(set: HypothesisSet): Predicate[] {
  return set.candidates.map((c) => c.predicate);
}

/** Literal values compared against feature `id` anywhere in `predicates`. */
function literalsIn(predicates: readonly Predicate[], id: FeatureId): Value[] {
  const out: Value[] = [];
  const visit = (p: Predicate): void => {
    const node = predicateNode(p);
    switch (node.key) {
      case "and":
      case "or":
      case "!":
        node.args.forEach(visit);
        return;
      case "in":
        if (isVarRef(node.args[0]) && node.args[0].var === id) out.push(...node.args[1]);
        return;
      default: {
        const [l, r] = node.args;
        if (isVarRef(l) && l.var === id && !isVarRef(r)) out.push(r);
        if (isVarRef(r) && r.var === id && !isVarRef(l)) out.push(l);
      }
    }
  };
  predicates.forEach(visit);
  return out;
}

type Valid = { assignment: Assignment; adjusted?: { feature: Feature; value: Value } };

function makeValid(domain: DomainConfig, assignment: Assignment, moved: FeatureId, base: Assignment): Valid | undefined {
  const violated = domain.domainConstraints.filter((c) => evaluatePredicate(c, recordLookup(assignment)).truth !== true);
  if (violated.length === 0) return { assignment };
  // Unknown (not false) means the case is not fully determined: never repaired, never asked.
  if (violated.some((c) => evaluatePredicate(c, recordLookup(assignment)).truth === "unknown")) return undefined;
  const mentioned = new Set(violated.flatMap(featuresReferenced));
  for (const g of domain.features) {
    if (g.id === moved || !mentioned.has(g.id)) continue;
    for (const value of repairValues(g, base[g.id], violated)) {
      const candidate = { ...assignment, [g.id]: value };
      if (domain.domainConstraints.every((c) => evaluatePredicate(c, recordLookup(candidate)).truth === true))
        return { assignment: candidate, adjusted: { feature: g, value } };
    }
  }
  return undefined;
}

function repairValues(g: Feature, current: Value | undefined, violated: readonly Predicate[]): Value[] {
  switch (g.type) {
    case "boolean":
      return [true, false].filter((v) => v !== current);
    case "enum":
      return g.values.filter((v) => v !== current);
    case "string":
      return [];
    case "number": {
      const literals = literalsIn(violated, g.id).filter((v): v is number => typeof v === "number");
      const values = [...new Set([...literals, g.min, g.max])].filter((v) => v !== current);
      const from = typeof current === "number" ? current : g.min;
      return values.sort((a, b) => Math.abs(a - from) - Math.abs(b - from) || a - b);
    }
  }
}

function counterfactualText(f: Feature, from: Value, to: Value, adjusted: Valid["adjusted"]): string | undefined {
  const extra = adjusted === undefined ? "" : ` (${featurePhrase(adjusted.feature)} ${formatValue(adjusted.feature, adjusted.value)})`;
  const long = `If ${featurePhrase(f)} were ${formatValue(f, to)} instead of ${formatValue(f, from)}${extra}, what would you decide?`;
  if (wordCount(long) <= MAX_QUESTION_WORDS) return long;
  const short = `If ${featurePhrase(f)} were ${formatValue(f, to)}${extra}, what would you decide?`;
  return wordCount(short) <= MAX_QUESTION_WORDS ? short : undefined;
}

/** An answer group below this posterior mass is noise, not a rival explanation. */
const RIVAL_MIN_MASS = 0.05;

/**
 * The explanations the question pits against each other: for each answer the case would get with
 * at least RIVAL_MIN_MASS of posterior mass, its top-weight candidate (heaviest group first).
 */
function rivalCandidates(model: FamilyModel, set: HypothesisSet, lookup: FeatureLookup): string[] {
  const groups = new Map<string, { id: string; weight: number; mass: number }>();
  for (const c of set.candidates) {
    const a = predictedAction(model, c, lookup);
    if (a === "unknown") continue;
    const g = groups.get(a);
    if (g === undefined) groups.set(a, { id: c.id, weight: c.weight, mass: c.weight });
    else {
      g.mass += c.weight;
      if (c.weight > g.weight) Object.assign(g, { id: c.id, weight: c.weight });
    }
  }
  return [...groups.values()]
    .filter((g) => g.mass >= RIVAL_MIN_MASS)
    .sort((x, y) => y.mass - x.mass)
    .map((g) => g.id);
}
