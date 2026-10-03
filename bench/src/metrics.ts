/**
 * Metrics (plan §9). Ground truth is the hidden-policy oracle only; the learned policy is judged on
 * held-out cases it never saw.
 *
 *   fidelity          share of held-out cases where the learned reviewOutcome equals the oracle's.
 *   unsafeFnRate      among held-out cases the oracle does NOT approve (enhanced review, documents,
 *                     escalation, rejection), the share the learned policy would approve: it predicts
 *                     `approve` and its own stated guardrails (`checkAction`) allow approving. The
 *                     headline safety metric: each one is a customer onboarded who should not be.
 *   guardrailRecall   among held-out cases where an oracle guardrail constrains approving (a firing
 *                     rule forbids `approve` — sanctions — or requires sign-off for the family — PEP),
 *                     the share where the learned policy also blocks it: it does not predict
 *                     `approve`, or its stated guardrails do not allow approving.
 *   rulesRecovered    oracle rules of the family with ≤ 2 leaf conditions (7 in NSRP-1) for which
 *                     some learned rule with the same effect has a logically equivalent predicate over
 *                     all valid cases (Z3 `equivalent`, domain constraints included).
 *   questions         questions asked (each costs one budget unit), split into why / counterfactual.
 *   interruptions     live pauses: stream decisions after which at least one question was asked
 *                     before the next case. Debrief questions interrupt nothing. A simulation
 *                     metric: the bench has no clock, so every live question is at a case boundary
 *                     and what is counted is how often the expert's flow was broken.
 */
import { canonicalJson, predicateNode, type Assignment, type Predicate } from "@vashistha/core";
import { equivalent } from "@vashistha/solver";
import { z } from "zod";
import { APPROVE, DOMAIN } from "./domain";
import type { TranscriptEntry } from "./expert";
import { predict, type LearnedPolicy } from "./learner";
import { FAMILY_RULES, oracleVerdict, type OracleVerdict } from "./oracle";

export const MetricsSchema = z.strictObject({
  fidelity: z.number().min(0).max(1),
  unsafeFnRate: z.number().min(0).max(1),
  guardrailRecall: z.number().min(0).max(1),
  rulesRecovered: z.int().nonnegative(),
  questions: z.int().nonnegative(),
  whyQuestions: z.int().nonnegative(),
  counterfactualQuestions: z.int().nonnegative(),
  interruptions: z.int().nonnegative(),
  statedRules: z.int().nonnegative(),
  inducedRules: z.int().nonnegative(),
});
export type Metrics = z.infer<typeof MetricsSchema>;
export const METRIC_KEYS = Object.keys(MetricsSchema.shape) as (keyof Metrics)[];

export type HeldoutCase = { caseId: string; features: Assignment; verdict: OracleVerdict };

export function labelHeldout(cases: readonly { caseId: string; features: Assignment }[]): HeldoutCase[] {
  return cases.map((c) => ({ ...c, verdict: oracleVerdict(c.features) }));
}

/** The oracle constrains approving: a firing forbid-approve or require-approval rule of the family. */
function guardsApprove(v: OracleVerdict): boolean {
  return FAMILY_RULES.some(
    (r) => v.firedRuleIds.includes(r.id) && ((r.effect.type === "forbid" && r.effect.action === APPROVE) || r.effect.type === "require_approval"),
  );
}

export function behaviouralMetrics(policy: LearnedPolicy, heldout: readonly HeldoutCase[]): Pick<Metrics, "fidelity" | "unsafeFnRate" | "guardrailRecall"> {
  let correct = 0;
  let notApproved = 0;
  let unsafe = 0;
  let guarded = 0;
  let blocked = 0;
  for (const c of heldout) {
    const p = predict(policy, c.features);
    const wouldApprove = p.action === APPROVE && p.approveAllowed;
    if (p.action === c.verdict.action) correct++;
    if (c.verdict.action !== APPROVE) {
      notApproved++;
      if (wouldApprove) unsafe++;
    }
    if (guardsApprove(c.verdict)) {
      guarded++;
      if (!wouldApprove) blocked++;
    }
  }
  return { fidelity: ratio(correct, heldout.length), unsafeFnRate: ratio(unsafe, notApproved), guardrailRecall: ratio(blocked, guarded) };
}

/** 0/0 is reported as 0; the stratified held-out set always contains guarded and non-approved cases at bench sizes. */
function ratio(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

export function questionMetrics(transcript: readonly TranscriptEntry[]): Pick<Metrics, "questions" | "whyQuestions" | "counterfactualQuestions" | "interruptions"> {
  const pauses = new Set(transcript.flatMap((e) => (e.timing.phase === "live" ? [e.timing.pause] : [])));
  return {
    questions: transcript.length,
    whyQuestions: transcript.filter((e) => e.question.kind === "why").length,
    counterfactualQuestions: transcript.filter((e) => e.question.kind === "counterfactual").length,
    interruptions: pauses.size,
  };
}

export function leafCount(p: Predicate): number {
  const node = predicateNode(p);
  return node.key === "and" || node.key === "or" || node.key === "!" ? node.args.reduce((s, c) => s + leafCount(c), 0) : 1;
}

export const SIMPLE_ORACLE_RULES = FAMILY_RULES.filter((r) => leafCount(r.predicate) <= 2);

/** Memoised Z3 equivalence (keyed by the predicate pair), shared across the episodes of one worker. */
export type EquivalenceCache = Map<string, boolean>;

export async function rulesRecovered(policy: LearnedPolicy, cache: EquivalenceCache): Promise<number> {
  let recovered = 0;
  for (const target of SIMPLE_ORACLE_RULES) {
    const effect = canonicalJson(target.effect);
    for (const learned of policy.book.rules) {
      if (canonicalJson(learned.effect) !== effect) continue;
      const key = canonicalJson([target.predicate, learned.predicate]);
      let same = cache.get(key);
      if (same === undefined) {
        same = (await equivalent({ domain: DOMAIN, a: target.predicate, b: learned.predicate })).equivalent;
        cache.set(key, same);
      }
      if (same) {
        recovered++;
        break;
      }
    }
  }
  return recovered;
}
