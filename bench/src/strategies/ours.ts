import {
  buildHypothesisSet,
  canonicalJson,
  counterfactualEig,
  explainedMass,
  generateQuestions,
  isContradiction,
  recordLookup,
  selectQuestion,
  surprise,
  type Assignment,
  type DecisionContext,
  type HypothesisSet,
  type Observation,
  type Question,
  type Witness,
} from "@vashistha/core";
import { findBoundaries, findConflicts, findUnresolved } from "@vashistha/solver";
import { DOMAIN, FAMILY_ID } from "../domain";
import type { BenchQuestion } from "../expert";
import { BENCH_ENGINE_CONFIG, FAMILY_MODEL, fitPolicy, predict, residualObservations, type Knowledge, type LearnedPolicy } from "../learner";
import type { Session } from "./session";

/**
 * (D) Ours: surprise + EIG live, Z3 witnesses in the debrief (plan §7.3, §7.5).
 *
 * Live, at the pause after each decision (at most one question per pause):
 *   - the decision is decided by a stated rule: correct → no question; wrong → contradiction of a
 *     confirmed rule → why-question;
 *   - otherwise its surprise is computed under the engine's hypothesis set over the residual (the
 *     observations no stated rule decides), the set is rebuilt, and the engine's question queue
 *     (`generateQuestions`: counterfactuals valued by EIG, a why-probe when the decision is
 *     unexplained) is consulted: on a contradiction (surprise ≥ 3 bits) the top question is asked,
 *     else the top question only if its value ≥ θ (`selectQuestion`).
 * Debrief, until the budget ends or no unasked witness has EIG ≥ θ ("coverage closed": nothing
 * left that the hypotheses expect to learn from): Z3 witnesses over the CURRENT learned rulebook —
 * unresolved cases (where the learner would fall back), conflicts, and boundary cases of every rule
 * with a numeric threshold — ranked by EIG under the residual hypothesis set; the best is asked as
 * a counterfactual, and when the answer contradicts the learned policy a why-question follows.
 */
export async function ours(session: Session): Promise<void> {
  let set = residualSet(session.knowledge);
  const refresh = (): void => {
    set = residualSet(session.knowledge);
  };

  for (let i = 0; i < session.stream.length; i++) {
    const o = session.decide(i);
    if (!session.canAsk) continue;
    const observation: Observation = { id: o.caseId, caseId: o.caseId, features: o.features, action: o.action };
    const statedVerdict = statedDecision(session.knowledge, o.features);
    if (statedVerdict !== undefined) {
      if (statedVerdict !== o.action) {
        session.ask({ kind: "why", caseId: o.caseId }, { phase: "live", pause: i });
        refresh();
      }
      continue;
    }
    const recent = { observation, surprise: surprise(FAMILY_MODEL, set, observation), explainedMass: explainedMass(FAMILY_MODEL, set, observation) };
    refresh();
    const queue = generateQuestions({
      model: FAMILY_MODEL,
      set,
      ctx: { sessionId: "bench", createdAt: 0, contextVersion: i, caseId: o.caseId, context: decisionContext(o.features), parentIds: [] },
      recent,
      config: BENCH_ENGINE_CONFIG,
    });
    const question = isContradiction(recent.surprise, BENCH_ENGINE_CONFIG) ? queue[0] : selectQuestion(queue, { thetaAsk: session.thetaAsk });
    const asked = question === undefined ? undefined : toBenchQuestion(question, o.caseId);
    if (asked === undefined) continue;
    session.ask(asked, { phase: "live", pause: i });
    refresh();
  }

  const decided = new Set(session.knowledge.observations.map((o) => canonicalJson(o.features)));
  while (session.canAsk) {
    const policy = fitPolicy(session.knowledge);
    const fresh = (await witnesses(policy)).filter((w) => !decided.has(canonicalJson(w.assignment)));
    const ranked = fresh
      .map((w) => ({ w, eig: counterfactualEig(FAMILY_MODEL, set, recordLookup(w.assignment)) }))
      .filter((x) => x.eig >= session.thetaAsk)
      .sort((a, b) => b.eig - a.eig || KIND_ORDER[a.w.kind] - KIND_ORDER[b.w.kind] || (a.w.id < b.w.id ? -1 : a.w.id > b.w.id ? 1 : 0));
    const best = ranked[0]?.w;
    if (best === undefined) return;
    decided.add(canonicalJson(best.assignment));
    const answer = session.ask({ kind: "counterfactual", caseId: best.id, features: best.assignment }, { phase: "debrief" });
    if (answer.kind === "counterfactual" && answer.action !== predict(policy, best.assignment).action && session.canAsk)
      session.ask({ kind: "why", caseId: best.id }, { phase: "debrief" });
    refresh();
  }
}

const KIND_ORDER: Record<Witness["kind"], number> = { unresolved: 0, conflict: 1, boundary: 2, disagreement: 3 };

function residualSet(k: Knowledge): HypothesisSet {
  return buildHypothesisSet({
    setId: "bench-residual",
    model: FAMILY_MODEL,
    knowledge: { observations: residualObservations(k), statedCandidates: [], eliminatedIds: [] },
    schemaVersion: 1,
    config: BENCH_ENGINE_CONFIG,
  });
}

/** The action the stated rules alone decide on a case, or undefined when they leave it unresolved. */
function statedDecision(k: Knowledge, features: Assignment): string | undefined {
  const policy = fitPolicy({ ...k, observations: [] });
  const p = predict(policy, features);
  return p.resolution === "fallback" ? undefined : p.action;
}

async function witnesses(policy: LearnedPolicy): Promise<Witness[]> {
  const rules = policy.book.rules;
  const common = { domain: DOMAIN, rules, schemaVersion: 1 };
  const out: Witness[] = [...(await findUnresolved({ ...common, family: FAMILY_ID, limit: 10 })), ...(await findConflicts({ ...common, family: FAMILY_ID }))];
  for (const r of rules) out.push(...(await findBoundaries({ ...common, ruleId: r.id })));
  return out;
}

function decisionContext(features: Assignment): DecisionContext {
  return {
    case: features,
    workflow: { priorActions: [] },
    history: { derived: {} },
    actor: { role: "expert", id: "bench-simulated-expert" },
    environment: { date: "2026-10-04" },
    schemaVersion: 1,
  };
}

/** Engine question → bench channel question. Concept probes cannot arise (NSRP-1 uses declared features only). */
function toBenchQuestion(q: Question, decidedCaseId: string): BenchQuestion | undefined {
  if (q.kind === "why_probe") return { kind: "why", caseId: decidedCaseId };
  if (q.kind === "counterfactual" && q.target.assignment !== undefined) return { kind: "counterfactual", caseId: q.id, features: q.target.assignment };
  return undefined;
}
