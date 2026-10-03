/**
 * The live question queue policy (plan §7.2–7.3). The engine generates and ranks the questions
 * (counterfactuals by EIG on the case just decided, a why-probe for an unexplained decision, concept
 * probes, nothing over 25 words, nothing the screen answers); this module decides which of them are
 * queued:
 *   - only for the family's latest committed decision (the case the expert just worked);
 *   - never a question the expert was already asked (same kind, family, case and target);
 *   - one question per (kind, target feature) — the engine ranks several thresholds of one feature
 *     separately, and the queue (and the HUD's "three questions") is more useful varied;
 *   - at most QUEUE_LIMIT, highest value first.
 *
 * Context versions. Questions are regenerated on every committed decision and after every applied
 * answer, at the session's context version of that moment. Opening a case or editing a field bumps
 * the version without regenerating: the queue stays valid (its questions are about the decided case,
 * which did not change), so live questions are always reported at the current version.
 */
import "server-only";
import { canonicalJson, generateQuestions, type DecisionContext, type EngineConfig, type Question } from "@vashistha/core";
import type { DecisionRecord, EngineState, FamilyState } from "./engine-state";

export const QUEUE_LIMIT = 5;

/** What a question asks, independent of when it was generated (ids change with the context version). */
export function questionKey(q: Question): string {
  const { caseId, feature, assignment, witnessId, ruleId } = q.target;
  return canonicalJson({ kind: q.kind, family: q.decisionFamily, caseId, feature, assignment, witnessId, ruleId });
}

/** The decision context of a decided case as the engine's question generator reads it. */
function decisionContext(decision: DecisionRecord, now: number): DecisionContext {
  return {
    case: decision.features,
    workflow: { priorActions: [] },
    history: { derived: {} },
    actor: { role: "reviewer", id: "expert" },
    environment: { date: new Date(now).toISOString().slice(0, 10) },
    schemaVersion: 1,
  };
}

export function planQueue(params: {
  state: EngineState;
  family: FamilyState;
  /** Include the why-probe for the latest decision (only right after it was committed). */
  withWhyProbe: boolean;
  contextVersion: number;
  parentIds: string[];
  now: number;
  config: EngineConfig;
}): Question[] {
  const { state, family, withWhyProbe, contextVersion, parentIds, now, config } = params;
  const latest = family.decisions.at(-1);
  if (latest === undefined) return [];
  const asked = new Set([...state.questions.values()].filter((r) => r.status === "asked").map((r) => questionKey(r.question)));
  const generated = generateQuestions({
    model: family.model,
    set: family.set,
    ctx: {
      sessionId: state.sessionId,
      createdAt: now,
      contextVersion,
      caseId: latest.caseId,
      context: decisionContext(latest, now),
      parentIds,
    },
    ...(withWhyProbe && { recent: latest.recent }),
    concepts: state.undefinedConcepts,
    config,
  });
  const slots = new Set<string>();
  const queue: Question[] = [];
  for (const q of generated) {
    const slot = `${q.kind}:${q.target.feature ?? ""}`;
    if (asked.has(questionKey(q)) || slots.has(slot)) continue;
    slots.add(slot);
    queue.push(q);
    if (queue.length === QUEUE_LIMIT) break;
  }
  return queue;
}
