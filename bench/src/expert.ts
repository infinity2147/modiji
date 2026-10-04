/**
 * THE SIMULATED EXPERT. A deterministic program, not a person (plan §9): every answer is computed by
 * evaluating the hidden policy NSRP-1. It answers through one typed channel with a hard question
 * budget:
 *   - counterfactual "what would you do in case x?" → the oracle's action on x (with probability
 *     `noise`, a uniformly drawn other action instead);
 *   - why "why did you decide this case so?" (only for a case the expert decided: observed or
 *     answered) → the rules behind that decision as stated rules: the decisive rule(s) (the firing
 *     recommend rules of the decided action at the top firing priority), the firing guardrails, and
 *     for a decisive exception the rule it is an exception to. Never any other rule. A case no rule
 *     decides gets "nothing special: the default is <action>". With probability `vagueness` a
 *     statement is verbalised vaguely (a dropped conjunct or a threshold off by ±20 %); the
 *     decision itself is never changed.
 * Statement ids are opaque handles of the oracle rule ids (plan §9: why-questions return the fired
 * rule ids), so the learner can link an exception to the rule it overrides.
 * Observed decisions on the training stream use the same noise model.
 */
import {
  contentId,
  describePredicate,
  actionPhrase,
  predicateNode,
  typecheckPredicate,
  isVarRef,
  StatedRuleSchema,
  type ActionId,
  type Assignment,
  type Predicate,
  type RuleEffect,
  type StatedRule,
} from "@vashistha/core";
import { mulberry32, type Rng } from "@vashistha/core/domains/kyc";
import type { ExpertSettings } from "./config";
import { DOMAIN, FAMILY } from "./domain";
import { FAMILY_RULES, oracleVerdict, type OracleRule } from "./oracle";

/** A rule as the expert states it: what applies and what it enforces (`rule`), and its precedence. */
export type ExpertStatement = {
  id: string;
  rule: StatedRule;
  /** Higher wins; the expert's own ranking ("sanctions trump everything"). */
  priority: number;
  /** Statement ids of the rules this one is an exception to. */
  overrides: string[];
};

export type BenchQuestion =
  | { kind: "why"; caseId: string }
  | { kind: "counterfactual"; caseId: string; features: Assignment };

/** Live questions are asked at the pause after stream decision `pause`; debrief questions after the stream. */
export type QuestionTiming = { phase: "live"; pause: number } | { phase: "debrief" };

export type ExpertAnswer =
  | { kind: "why"; statements: ExpertStatement[]; defaultAction?: ActionId }
  | { kind: "counterfactual"; action: ActionId };

export type TranscriptEntry = { question: BenchQuestion; timing: QuestionTiming; answer: ExpertAnswer };

export class BudgetExhaustedError extends Error {
  constructor() {
    super("question budget exhausted");
    this.name = "BudgetExhaustedError";
  }
}

const SALT = { decisions: 0x5eed0001, answers: 0x5eed0002, vagueness: 0x5eed0003 } as const;

function streamRng(seed: number, salt: number): Rng {
  return mulberry32((Math.imul(seed, 0x9e3779b1) ^ salt) >>> 0);
}

export class SimulatedExpert {
  readonly #settings: ExpertSettings;
  readonly #budget: number;
  readonly #decisionRng: Rng;
  readonly #answerRng: Rng;
  readonly #vaguenessRng: Rng;
  /** Cases the expert has decided (observed or answered): only these can be asked "why". */
  readonly #decided = new Map<string, Assignment>();
  readonly #transcript: TranscriptEntry[] = [];

  constructor(params: { settings: ExpertSettings; budget: number; seed: number }) {
    this.#settings = params.settings;
    this.#budget = params.budget;
    this.#decisionRng = streamRng(params.seed, SALT.decisions);
    this.#answerRng = streamRng(params.seed, SALT.answers);
    this.#vaguenessRng = streamRng(params.seed, SALT.vagueness);
  }

  /** The expert works a training case (no question, no budget). */
  decide(caseId: string, features: Assignment): ActionId {
    this.#decided.set(caseId, features);
    return this.#noisy(oracleVerdict(features).action, this.#decisionRng);
  }

  get remaining(): number {
    return this.#budget - this.#transcript.length;
  }

  get transcript(): readonly TranscriptEntry[] {
    return this.#transcript;
  }

  /** Every question costs one unit of budget, whatever its kind. */
  ask(question: BenchQuestion, timing: QuestionTiming): ExpertAnswer {
    if (this.remaining <= 0) throw new BudgetExhaustedError();
    const answer = question.kind === "why" ? this.#why(question.caseId) : this.#counterfactual(question);
    this.#transcript.push({ question, timing, answer });
    return answer;
  }

  #counterfactual(q: Extract<BenchQuestion, { kind: "counterfactual" }>): ExpertAnswer {
    const action = this.#noisy(oracleVerdict(q.features).action, this.#answerRng);
    this.#decided.set(q.caseId, q.features);
    return { kind: "counterfactual", action };
  }

  #why(caseId: string): ExpertAnswer {
    const features = this.#decided.get(caseId);
    if (features === undefined) throw new RangeError(`why-question about case ${caseId}, which the expert has not decided`);
    const verdict = oracleVerdict(features);
    const rules = explainingRules(verdict.action, verdict.firedRuleIds);
    const statements = rules.map((r) => this.#state(r));
    return statements.length === 0 ? { kind: "why", statements, defaultAction: verdict.action } : { kind: "why", statements };
  }

  #state(r: OracleRule): ExpertStatement {
    const predicate = this.#vagueness(r.predicate);
    // A sign-off requirement constrains approving, the family's first (default) action.
    const action = r.effect.type === "recommend" || r.effect.type === "forbid" ? r.effect.action : FAMILY.actions[0];
    if (action === undefined) throw new Error("family has no actions");
    const exactQuote = verbalize(predicate, r.effect);
    return {
      id: statementId(r.id),
      rule: StatedRuleSchema.parse({ predicate, action, kind: r.kind, effect: r.effect, exactQuote, t0Ms: 0, t1Ms: 0 }),
      priority: r.priority,
      overrides: r.overrides.map(statementId),
    };
  }

  #noisy(action: ActionId, rng: Rng): ActionId {
    if (this.#settings.noise === 0 || rng() >= this.#settings.noise) return action;
    const others = FAMILY.actions.filter((a) => a !== action);
    return others[Math.floor(rng() * others.length)] ?? action;
  }

  #vagueness(p: Predicate): Predicate {
    if (this.#settings.vagueness === 0 || this.#vaguenessRng() >= this.#settings.vagueness) return p;
    return vaguePredicate(p, this.#vaguenessRng);
  }
}

export function statementId(oracleRuleId: string): string {
  return contentId("stmt", oracleRuleId);
}

/** The rules behind a decision: decisive rules, firing guardrails, and the rules a decisive exception overrides. */
function explainingRules(action: ActionId, firedRuleIds: readonly string[]): OracleRule[] {
  const fired = FAMILY_RULES.filter((r) => firedRuleIds.includes(r.id));
  const recommending = fired.filter((r) => r.effect.type === "recommend" && r.effect.action === action);
  const top = Math.max(...fired.filter((r) => r.effect.type === "recommend").map((r) => r.priority));
  const decisive = recommending.filter((r) => r.priority === top);
  const guardrails = fired.filter((r) => r.effect.type === "forbid" || r.effect.type === "require_approval");
  const exceptedFrom = FAMILY_RULES.filter((r) => decisive.some((d) => d.overrides.includes(r.id)));
  return [...new Set([...decisive, ...guardrails, ...exceptedFrom])];
}

function verbalize(p: Predicate, effect: RuleEffect): string {
  const when = describePredicate(p, DOMAIN);
  switch (effect.type) {
    case "recommend":
      return `If ${when}, ${actionPhrase(DOMAIN, effect.action)}.`;
    case "forbid":
      return `If ${when}, never ${actionPhrase(DOMAIN, effect.action)}.`;
    case "require_approval":
      return `If ${when}, it needs ${effect.role.replaceAll("_", " ")} sign-off.`;
    case "route":
      return `If ${when}, route it to ${effect.destination}.`;
  }
}

/**
 * One distortion, drawn uniformly among those the predicate admits: drop one conjunct of a
 * top-level conjunction, or move one numeric threshold by ±20 % (two significant figures, integer
 * features rounded, clamped to the feature's range). A single non-numeric condition stays precise.
 */
function vaguePredicate(p: Predicate, rng: Rng): Predicate {
  const node = predicateNode(p);
  const conjuncts = node.key === "and" ? node.args : [p];
  const options: (() => Predicate)[] = [];
  if (conjuncts.length >= 2)
    options.push(() => {
      const drop = Math.floor(rng() * conjuncts.length);
      const kept = conjuncts.filter((_, i) => i !== drop);
      const [first, ...rest] = kept;
      if (first === undefined) return p;
      return rest.length === 0 ? first : { and: [first, ...rest] };
    });
  const numeric = conjuncts.flatMap((c, i) => (thresholdOf(c) === undefined ? [] : [i]));
  if (numeric.length > 0)
    options.push(() => {
      const i = numeric[Math.floor(rng() * numeric.length)] ?? 0;
      const factor = rng() < 0.5 ? 0.8 : 1.2;
      const shifted = conjuncts.map((c, j) => (j === i ? shiftThreshold(c, factor) : c));
      const [first, ...rest] = shifted;
      if (first === undefined) return p;
      return rest.length === 0 ? first : { and: [first, ...rest] };
    });
  const pick = options[Math.floor(rng() * options.length)];
  if (pick === undefined) return p;
  const vague = pick();
  if (typecheckPredicate(vague, DOMAIN.features).length > 0) throw new Error(`vague predicate does not type-check: ${JSON.stringify(vague)}`);
  return vague;
}

function thresholdOf(p: Predicate): { feature: string; value: number } | undefined {
  const node = predicateNode(p);
  if (node.key === "and" || node.key === "or" || node.key === "!" || node.key === "in") return undefined;
  const [l, r] = node.args;
  return isVarRef(l) && typeof r === "number" ? { feature: l.var, value: r } : undefined;
}

function shiftThreshold(p: Predicate, factor: number): Predicate {
  const node = predicateNode(p);
  const t = thresholdOf(p);
  const feature = DOMAIN.features.find((f) => f.id === t?.feature);
  if (t === undefined || feature?.type !== "number" || node.key === "and" || node.key === "or" || node.key === "!" || node.key === "in") return p;
  const raw = Number((t.value * factor).toPrecision(2));
  const value = Math.min(feature.max, Math.max(feature.min, feature.integer ? Math.round(raw) : raw));
  return { [node.key]: [node.args[0], value] } as unknown as Predicate;
}
